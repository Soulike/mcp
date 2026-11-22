import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from './server.ts';
import { createDeepSeekWebClient } from './services/deepseek-client.ts';

function extractUrl(input: string | URL | Request): string {
  if (typeof input === 'string') {
    return input;
  }
  if (input instanceof URL) {
    return input.href;
  }
  return input.url;
}

function getFirstTextContent(result: unknown): string {
  assert.ok(typeof result === 'object' && result !== null);
  assert.ok('content' in result && Array.isArray(result.content));
  const first: unknown = result.content[0];
  assert.ok(typeof first === 'object' && first !== null);
  assert.ok('type' in first && first.type === 'text');
  assert.ok('text' in first && typeof first.text === 'string');
  return first.text;
}

async function withClient(
  options:
    | {
        apiKey?: string | undefined;
        fetch?: typeof fetch | undefined;
        timeoutMs?: number | undefined;
      }
    | undefined,
  run: (client: Client) => Promise<void>,
): Promise<void> {
  const apiKey = options?.apiKey;
  const deepSeekClient =
    apiKey !== undefined && apiKey.trim() !== ''
      ? createDeepSeekWebClient({
          apiKey,
          fetchFn: options?.fetch,
          timeoutMs: options?.timeoutMs,
        })
      : undefined;
  const server = createServer({ client: deepSeekClient });
  const client = new Client({
    name: 'deepseek-web-mcp-test-client',
    version: '0.1.0',
  });

  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();

  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);

  try {
    await run(client);
  } finally {
    await Promise.all([client.close(), server.close()]);
  }
}

await describe('deepseek-web-mcp server', async () => {
  await it('lists deepseek_search and deepseek_fetch with read-only open-world annotations', async () => {
    const manifest: unknown = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    );
    assert.ok(
      typeof manifest === 'object' &&
        manifest !== null &&
        'version' in manifest &&
        typeof manifest.version === 'string',
    );
    const expectedVersion = manifest.version;

    await withClient(undefined, async (client) => {
      assert.deepEqual(client.getServerVersion(), {
        name: 'deepseek-web-mcp',
        version: expectedVersion,
      });
      const { tools } = await client.listTools();
      assert.deepEqual(
        tools.map((tool) => ({
          name: tool.name,
          title: tool.title,
          annotations: tool.annotations,
        })),
        [
          {
            name: 'deepseek_search',
            title: 'Web Search',
            annotations: {
              readOnlyHint: true,
              idempotentHint: false,
              openWorldHint: true,
            },
          },
          {
            name: 'deepseek_fetch',
            title: 'Web Page Fetch',
            annotations: {
              readOnlyHint: true,
              idempotentHint: false,
              openWorldHint: true,
            },
          },
        ],
      );
      for (const tool of tools) {
        assert.ok(
          tool.description !== undefined && tool.description.length > 0,
        );
        assert.ok(tool.outputSchema);
      }
    });
  });

  await it('calls DeepSeek Search API and returns Markdown content and structuredContent', async () => {
    let capturedUrl: string | undefined;
    let capturedMethod: string | undefined;
    let capturedHeaders: Headers | undefined;
    let capturedBody: unknown;

    const sampleResult = {
      rerank_score: 2.4,
      title: 'DeepSeek V4 Released',
      url: 'https://example.com/deepseek-v4',
      snippet: 'DeepSeek V4 is now available.',
      summary: 'DeepSeek released V4 with improved tool calling.',
      content: 'Full article body about DeepSeek V4.',
      site_name: 'Example News',
      site_icon: 'https://example.com/favicon.ico',
      date: '2026-06-01T00:00:00+00:00',
      authority: 3,
    };

    const stubFetch: typeof fetch = (input, init) => {
      capturedUrl = extractUrl(input);
      capturedMethod = init?.method;
      capturedHeaders = new Headers(init?.headers);
      capturedBody =
        typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;

      return Promise.resolve(
        new Response(JSON.stringify({ results: [sampleResult] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    };

    await withClient(
      { apiKey: 'test-api-key', fetch: stubFetch },
      async (client) => {
        const result = await client.callTool({
          name: 'deepseek_search',
          arguments: {
            query: 'DeepSeek V4 site:example.com',
            count: 5,
            ori_question: 'When was DeepSeek V4 released?',
            localization: '1.2.3.4',
            need_content: true,
          },
        });

        assert.equal(result.isError, undefined);
        assert.equal(capturedUrl, 'https://api.deepseek.com/v1/tools/search');
        assert.equal(capturedMethod, 'POST');
        assert.ok(capturedHeaders);
        assert.equal(
          capturedHeaders.get('authorization'),
          'Bearer test-api-key',
        );
        assert.equal(capturedHeaders.get('content-type'), 'application/json');
        assert.deepEqual(capturedBody, {
          query: 'DeepSeek V4 site:example.com',
          count: 5,
          ori_question: 'When was DeepSeek V4 released?',
          localization: '1.2.3.4',
          need_content: true,
        });
        assert.deepEqual(result.structuredContent, {
          results: [sampleResult],
        });

        const text = getFirstTextContent(result);
        assert.match(text, /DeepSeek V4 Released/);
        assert.match(text, /https:\/\/example\.com\/deepseek-v4/);
        assert.match(text, /Example News/);
        assert.match(text, /2026-06-01T00:00:00\+00:00/);
        assert.match(text, /Score: 2\.4\/3/);
        assert.match(text, /Authority: 3\/4/);
        assert.match(text, /DeepSeek released V4 with improved tool calling\./);
        assert.match(text, /Full article body about DeepSeek V4\./);
      },
    );
  });

  await it('omits unknown authority (-1) from search Markdown while preserving it in structuredContent', async () => {
    const unknownAuthorityResult = {
      rerank_score: 1.8,
      title: 'Blog Post',
      url: 'https://example.com/post',
      snippet: 'Short snippet.',
      summary: 'Longer summary.',
      content: '',
      site_name: null,
      site_icon: null,
      date: null,
      authority: -1,
    };

    const stubFetch: typeof fetch = () =>
      Promise.resolve(
        new Response(JSON.stringify({ results: [unknownAuthorityResult] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );

    await withClient(
      { apiKey: 'test-api-key', fetch: stubFetch },
      async (client) => {
        const result = await client.callTool({
          name: 'deepseek_search',
          arguments: { query: 'blog post' },
        });

        assert.equal(result.isError, undefined);
        assert.deepEqual(result.structuredContent, {
          results: [unknownAuthorityResult],
        });
        const text = getFirstTextContent(result);
        assert.match(text, /Score: 1\.8\/3/);
        assert.doesNotMatch(text, /Authority:/);
      },
    );
  });

  await it('returns a non-error empty state when DeepSeek Search returns no results', async () => {
    const stubFetch: typeof fetch = () =>
      Promise.resolve(
        new Response(JSON.stringify({ results: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );

    await withClient(
      { apiKey: 'test-api-key', fetch: stubFetch },
      async (client) => {
        const result = await client.callTool({
          name: 'deepseek_search',
          arguments: { query: 'obscure nonexistent query' },
        });

        assert.equal(result.isError, undefined);
        assert.deepEqual(result.structuredContent, { results: [] });
        assert.match(
          getFirstTextContent(result),
          /^No results found for "obscure nonexistent query"\./,
        );
      },
    );
  });

  await it('validates search query whitespace and Unicode character limits before calling fetch', async () => {
    let fetchCalled = false;
    const stubFetch: typeof fetch = () => {
      fetchCalled = true;
      return Promise.resolve(
        new Response(JSON.stringify({ results: [] }), { status: 200 }),
      );
    };

    await withClient(
      { apiKey: 'test-api-key', fetch: stubFetch },
      async (client) => {
        const blankResult = await client.callTool({
          name: 'deepseek_search',
          arguments: { query: '   \t\n' },
        });
        assert.equal(blankResult.isError, true);
        assert.equal(fetchCalled, false);

        const tooLongResult = await client.callTool({
          name: 'deepseek_search',
          arguments: { query: '🚀'.repeat(129) },
        });
        assert.equal(tooLongResult.isError, true);
        assert.equal(fetchCalled, false);

        const maxEmojiResult = await client.callTool({
          name: 'deepseek_search',
          arguments: { query: '🚀'.repeat(128) },
        });
        assert.equal(maxEmojiResult.isError, undefined);
        assert.equal(fetchCalled, true);
      },
    );
  });

  await it('calls DeepSeek Fetch API and returns Markdown content and structuredContent', async () => {
    let capturedUrl: string | undefined;
    let capturedMethod: string | undefined;
    let capturedHeaders: Headers | undefined;
    let capturedBody: unknown;

    const stubFetch: typeof fetch = (input, init) => {
      capturedUrl = extractUrl(input);
      capturedMethod = init?.method;
      capturedHeaders = new Headers(init?.headers);
      capturedBody =
        typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;

      return Promise.resolve(
        new Response(
          JSON.stringify({
            title: 'Example Article',
            content: '# Example Article\n\nBody text.',
          }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          },
        ),
      );
    };

    await withClient(
      { apiKey: 'test-api-key', fetch: stubFetch },
      async (client) => {
        const result = await client.callTool({
          name: 'deepseek_fetch',
          arguments: { url: 'https://example.com/article' },
        });

        assert.equal(result.isError, undefined);
        assert.equal(capturedUrl, 'https://api.deepseek.com/v1/tools/fetch');
        assert.equal(capturedMethod, 'POST');
        assert.ok(capturedHeaders);
        assert.equal(
          capturedHeaders.get('authorization'),
          'Bearer test-api-key',
        );
        assert.equal(capturedHeaders.get('content-type'), 'application/json');
        assert.deepEqual(capturedBody, {
          url: 'https://example.com/article',
        });
        assert.deepEqual(result.structuredContent, {
          title: 'Example Article',
          content: '# Example Article\n\nBody text.',
        });
        assert.equal(
          getFirstTextContent(result),
          '# Example Article\n\nBody text.',
        );
      },
    );
  });

  await it('prepends fetch title heading when Markdown body does not start with it', async () => {
    const stubFetch: typeof fetch = () =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            title: 'Example Article',
            content: 'Paragraph without top heading.',
          }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          },
        ),
      );

    await withClient(
      { apiKey: 'test-api-key', fetch: stubFetch },
      async (client) => {
        const result = await client.callTool({
          name: 'deepseek_fetch',
          arguments: { url: 'https://example.com/plain' },
        });

        assert.equal(result.isError, undefined);
        assert.equal(
          getFirstTextContent(result),
          '# Example Article\n\nParagraph without top heading.',
        );
      },
    );
  });

  await it('truncates oversized fetch output and structuredContent with a notice without splitting surrogate pairs', async () => {
    const body = `${'a'.repeat(19_800)}${'🚀'.repeat(200)}`;
    const stubFetch: typeof fetch = () =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            title: 'Oversized Article',
            content: body,
          }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          },
        ),
      );

    await withClient(
      { apiKey: 'test-api-key', fetch: stubFetch },
      async (client) => {
        const result = await client.callTool({
          name: 'deepseek_fetch',
          arguments: { url: 'https://example.com/oversized' },
        });

        assert.equal(result.isError, undefined);
        const text = getFirstTextContent(result);
        assert.ok(text.length <= 20_000);
        assert.match(text, /^# Oversized Article\n\na+/);
        assert.match(text, /\[Output truncated:/);
        assert.equal(text.isWellFormed(), true);

        assert.ok(
          typeof result.structuredContent === 'object' &&
            result.structuredContent !== null &&
            'title' in result.structuredContent &&
            typeof result.structuredContent.title === 'string' &&
            'content' in result.structuredContent &&
            typeof result.structuredContent.content === 'string',
        );
        assert.equal(result.structuredContent.title, 'Oversized Article');
        assert.ok(result.structuredContent.content.length <= 20_000);
        assert.match(result.structuredContent.content, /\[Output truncated:/);
        assert.equal(result.structuredContent.content.isWellFormed(), true);
        assert.ok(JSON.stringify(result.structuredContent).length <= 20_000);
      },
    );
  });

  await it('keeps highest-ranked search results that fit and drops trailing results once adding one exceeds the output cap', async () => {
    const results = [1, 2, 3, 4].map((index) => ({
      rerank_score: 3 - index * 0.2,
      title: `Result ${index}`,
      url: `https://example.com/${index}`,
      snippet: `Snippet ${index}`,
      summary: `Summary-${index}-` + 'x'.repeat(7_000),
      content: '',
      site_name: 'Example',
      site_icon: null,
      date: null,
      authority: 3,
    }));

    const stubFetch: typeof fetch = () =>
      Promise.resolve(
        new Response(JSON.stringify({ results }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );

    await withClient(
      { apiKey: 'test-api-key', fetch: stubFetch },
      async (client) => {
        const result = await client.callTool({
          name: 'deepseek_search',
          arguments: { query: 'large search results' },
        });

        assert.equal(result.isError, undefined);
        const text = getFirstTextContent(result);
        assert.ok(text.length <= 20_000);
        assert.match(text, /Result 1/);
        assert.match(text, /Result 2/);
        assert.doesNotMatch(text, /Result 3/);
        assert.doesNotMatch(text, /Result 4/);
        assert.match(text, /showing top 2 of 4 results/i);

        assert.deepEqual(result.structuredContent, {
          results: results.slice(0, 2),
        });
        assert.ok(JSON.stringify(result.structuredContent).length <= 20_000);
      },
    );
  });

  await it('enforces the output cap when Markdown fits but serialized structuredContent exceeds 20,000 characters', async () => {
    const results = Array.from({ length: 20 }, (_, index) => ({
      rerank_score: 2.5 - index * 0.05,
      title: `Item ${index + 1}`,
      url: `https://example.com/item-${index + 1}`,
      snippet: `s${index + 1}-` + 'y'.repeat(200),
      summary: `Summary ${index + 1}: ` + 'x'.repeat(780),
      content: '',
      site_name: 'Example',
      site_icon: `https://example.com/icons/${index + 1}/` + 'i'.repeat(120),
      date: '2026-06-01T00:00:00+00:00',
      authority: 3,
    }));

    const stubFetch: typeof fetch = () =>
      Promise.resolve(
        new Response(JSON.stringify({ results }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );

    await withClient(
      { apiKey: 'test-api-key', fetch: stubFetch },
      async (client) => {
        const result = await client.callTool({
          name: 'deepseek_search',
          arguments: { query: 'structured payload cap' },
        });

        assert.equal(result.isError, undefined);
        const text = getFirstTextContent(result);
        assert.ok(text.length <= 20_000);
        assert.match(
          text,
          /\[Output truncated: showing top \d+ of 20 results/i,
        );

        assert.ok(
          typeof result.structuredContent === 'object' &&
            result.structuredContent !== null &&
            'results' in result.structuredContent &&
            Array.isArray(result.structuredContent.results),
        );
        assert.ok(result.structuredContent.results.length > 0);
        assert.ok(result.structuredContent.results.length < 20);
        assert.ok(JSON.stringify(result.structuredContent).length <= 20_000);
      },
    );
  });

  await it('truncates the first search result in place rather than returning zero results when result 1 alone exceeds the cap', async () => {
    const results = [
      {
        rerank_score: 2.9,
        title: 'Massive First Result',
        url: 'https://example.com/first',
        snippet: 'First snippet',
        summary: 'First summary',
        content: 'z'.repeat(25_000),
        site_name: 'Example',
        site_icon: null,
        date: null,
        authority: 4,
      },
      {
        rerank_score: 2.1,
        title: 'Second Result',
        url: 'https://example.com/second',
        snippet: 'Second snippet',
        summary: 'Second summary',
        content: 'Short body',
        site_name: 'Example',
        site_icon: null,
        date: null,
        authority: 2,
      },
    ];

    const stubFetch: typeof fetch = () =>
      Promise.resolve(
        new Response(JSON.stringify({ results }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );

    await withClient(
      { apiKey: 'test-api-key', fetch: stubFetch },
      async (client) => {
        const result = await client.callTool({
          name: 'deepseek_search',
          arguments: { query: 'massive first result', need_content: true },
        });

        assert.equal(result.isError, undefined);
        const text = getFirstTextContent(result);
        assert.ok(text.length <= 20_000);
        assert.match(text, /Massive First Result/);
        assert.doesNotMatch(text, /Second Result/);
        assert.match(text, /result 1 exceeded.*1 remaining result/i);

        assert.ok(
          typeof result.structuredContent === 'object' &&
            result.structuredContent !== null &&
            'results' in result.structuredContent &&
            Array.isArray(result.structuredContent.results),
        );
        assert.equal(result.structuredContent.results.length, 1);
        const first: unknown = result.structuredContent.results[0];
        assert.ok(
          typeof first === 'object' &&
            first !== null &&
            'content' in first &&
            typeof first.content === 'string',
        );
        assert.ok(first.content.length < 20_000);
        assert.ok(JSON.stringify(result.structuredContent).length <= 20_000);
      },
    );
  });

  await it('validates fetch URL protocol, credentials, and length before calling fetch', async () => {
    let fetchCalled = false;
    const stubFetch: typeof fetch = () => {
      fetchCalled = true;
      return Promise.resolve(
        new Response(JSON.stringify({ title: '', content: '' }), {
          status: 200,
        }),
      );
    };

    await withClient(
      { apiKey: 'test-api-key', fetch: stubFetch },
      async (client) => {
        for (const badUrl of [
          'ftp://example.com/file',
          'https://user:pass@example.com/secret',
          'https://user@example.com/secret',
          'not-a-url',
          `https://example.com/${'a'.repeat(8190)}`,
        ]) {
          const result = await client.callTool({
            name: 'deepseek_fetch',
            arguments: { url: badUrl },
          });
          assert.equal(
            result.isError,
            true,
            `Expected validation error for ${badUrl.slice(0, 60)}`,
          );
        }
        assert.equal(fetchCalled, false);
      },
    );
  });

  await it('returns an error without calling fetch when DEEPSEEK_API_KEY is missing', async () => {
    let fetchCalled = false;
    const stubFetch: typeof fetch = () => {
      fetchCalled = true;
      return Promise.resolve(new Response('{}', { status: 200 }));
    };

    await withClient(
      { apiKey: undefined, fetch: stubFetch },
      async (client) => {
        const searchResult = await client.callTool({
          name: 'deepseek_search',
          arguments: { query: 'hello' },
        });
        assert.equal(searchResult.isError, true);
        assert.equal(searchResult.structuredContent, undefined);
        assert.match(getFirstTextContent(searchResult), /DEEPSEEK_API_KEY/);

        const fetchResult = await client.callTool({
          name: 'deepseek_fetch',
          arguments: { url: 'https://example.com' },
        });
        assert.equal(fetchResult.isError, true);
        assert.equal(fetchResult.structuredContent, undefined);
        assert.match(getFirstTextContent(fetchResult), /DEEPSEEK_API_KEY/);

        assert.equal(fetchCalled, false);
      },
    );
  });

  await it('maps upstream DeepSeek JSON and non-JSON HTTP errors to actionable tool errors', async () => {
    const responseQueue: Response[] = [
      new Response(
        JSON.stringify({
          error: {
            message: 'Insufficient balance',
            type: 'insufficient_balance_error',
            param: null,
            code: 'insufficient_balance',
          },
        }),
        { status: 402, headers: { 'content-type': 'application/json' } },
      ),
      new Response('Not Found', { status: 404 }),
      new Response('Bad Gateway', { status: 502 }),
    ];

    const stubFetch: typeof fetch = () => {
      const next = responseQueue.shift();
      assert.ok(next);
      return Promise.resolve(next);
    };

    await withClient(
      { apiKey: 'test-api-key', fetch: stubFetch },
      async (client) => {
        const balanceError = await client.callTool({
          name: 'deepseek_search',
          arguments: { query: 'test' },
        });
        assert.equal(balanceError.isError, true);
        assert.equal(balanceError.structuredContent, undefined);
        const balanceText = getFirstTextContent(balanceError);
        assert.match(balanceText, /402/);
        assert.match(balanceText, /insufficient_balance/);
        assert.match(balanceText, /Insufficient balance/);
        assert.match(balanceText, /do not retry/i);

        const notFoundError = await client.callTool({
          name: 'deepseek_fetch',
          arguments: { url: 'https://example.com/missing' },
        });
        assert.equal(notFoundError.isError, true);
        assert.equal(notFoundError.structuredContent, undefined);
        const notFoundText = getFirstTextContent(notFoundError);
        assert.match(notFoundText, /404/);
        assert.match(notFoundText, /try another URL/i);

        const gatewayError = await client.callTool({
          name: 'deepseek_fetch',
          arguments: { url: 'https://example.com' },
        });
        assert.equal(gatewayError.isError, true);
        assert.equal(gatewayError.structuredContent, undefined);
        const gatewayText = getFirstTextContent(gatewayError);
        assert.match(gatewayText, /502/);
        assert.match(gatewayText, /Bad Gateway/);
        assert.match(gatewayText, /retry/i);
      },
    );
  });

  await it('maps malformed upstream 200 payloads to tool errors', async () => {
    const stubFetch: typeof fetch = () =>
      Promise.resolve(
        new Response(JSON.stringify({ unexpected: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );

    await withClient(
      { apiKey: 'test-api-key', fetch: stubFetch },
      async (client) => {
        const result = await client.callTool({
          name: 'deepseek_fetch',
          arguments: { url: 'https://example.com/bad-shape' },
        });
        assert.equal(result.isError, true);
        assert.equal(result.structuredContent, undefined);
        assert.match(getFirstTextContent(result), /unexpected response shape/i);
      },
    );
  });

  await it('maps TimeoutError during response body reading to timeout guidance', async () => {
    const stubFetch: typeof fetch = () => {
      const response = new Response(
        new ReadableStream({
          start(controller) {
            controller.error(new DOMException('Timed out', 'TimeoutError'));
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
      return Promise.resolve(response);
    };

    await withClient(
      { apiKey: 'test-api-key', fetch: stubFetch },
      async (client) => {
        const result = await client.callTool({
          name: 'deepseek_fetch',
          arguments: { url: 'https://example.com/slow-body' },
        });
        assert.equal(result.isError, true);
        assert.equal(result.structuredContent, undefined);
        assert.match(getFirstTextContent(result), /timed out after 60s/i);
      },
    );
  });

  await it('enforces request deadline timeout when a response body stalls', async () => {
    let observedDeadlineAbort = false;
    const stubFetch: typeof fetch = (_input, init) => {
      const signal = init?.signal;
      assert.ok(signal);
      const response = new Response(
        new ReadableStream({
          start(controller) {
            signal.addEventListener(
              'abort',
              () => {
                observedDeadlineAbort = true;
                controller.error(signal.reason);
              },
              { once: true },
            );
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
      return Promise.resolve(response);
    };

    await withClient(
      { apiKey: 'test-api-key', fetch: stubFetch, timeoutMs: 25 },
      async (client) => {
        const result = await client.callTool({
          name: 'deepseek_fetch',
          arguments: { url: 'https://example.com/stalled-body' },
        });
        assert.equal(observedDeadlineAbort, true);
        assert.equal(result.isError, true);
        assert.equal(result.structuredContent, undefined);
        assert.match(getFirstTextContent(result), /timed out/i);
      },
    );
  });

  await it('propagates MCP request cancellation signal to fetch', async () => {
    const controller = new AbortController();
    let resolveAborted: (() => void) | undefined;
    const fetchAborted = new Promise<void>((resolve) => {
      resolveAborted = resolve;
    });

    const stubFetch: typeof fetch = (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        assert.ok(signal);
        if (signal.aborted) {
          resolveAborted?.();
          reject(new DOMException('Aborted', 'AbortError'));
          return;
        }
        signal.addEventListener(
          'abort',
          () => {
            resolveAborted?.();
            reject(new DOMException('Aborted', 'AbortError'));
          },
          { once: true },
        );
        controller.abort();
      });

    await withClient(
      { apiKey: 'test-api-key', fetch: stubFetch },
      async (client) => {
        await assert.rejects(
          () =>
            client.callTool(
              {
                name: 'deepseek_search',
                arguments: { query: 'abort check' },
              },
              undefined,
              { signal: controller.signal },
            ),
          (error: unknown) =>
            error instanceof Error && /aborted/i.test(error.message),
        );
        await fetchAborted;
      },
    );
  });
});
