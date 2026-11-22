import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  fetchResponseSchema,
  requestDeepSeekFetch,
  requestDeepSeekSearch,
  searchResultSchema,
  type FetchResponse,
  type SearchResponse,
  type SearchResult,
} from './deepseek.ts';

export interface ServerOptions {
  apiKey?: string | undefined;
  fetch?: typeof fetch | undefined;
}

const TOOL_ANNOTATIONS = {
  readOnlyHint: true,
  idempotentHint: false,
  openWorldHint: true,
} as const;

const MAX_SEARCH_TEXT_CODE_POINTS = 128;
const MAX_FETCH_URL_LENGTH = 8192;

function codePointLength(value: string): number {
  return [...value].length;
}

function isValidFetchUrl(value: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }

  return (
    (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
    parsed.hostname !== '' &&
    parsed.username === '' &&
    parsed.password === ''
  );
}

function formatFetchMarkdown(data: FetchResponse): string {
  if (data.title === '') {
    return data.content;
  }
  if (data.content === '') {
    return `# ${data.title}`;
  }
  const firstNonEmptyLine = data.content
    .split('\n')
    .find((line) => line.trim() !== '');
  if (firstNonEmptyLine?.trim() === `# ${data.title.trim()}`) {
    return data.content;
  }
  return `# ${data.title}\n\n${data.content}`;
}

const SEARCH_DESCRIPTION = [
  'Search live web pages when you need up-to-date information or do not have a specific URL yet.',
  'Returns ranked results with URLs, publish dates, quality/authority scores, and ~600-800 character summaries.',
  'By default full page bodies are omitted (`need_content=false`); prefer reviewing summaries first and calling `deepseek_fetch` on selected URLs rather than enabling `need_content=true` across many results.',
  'Limitations: text web search only—does not support image search.',
  'Query operators: join multiple `site:` filters with `OR` (`site:a.com OR site:b.com`); separate `-site:`, `-term`, `-"phrase"`, and `"exact phrase"` with spaces; use comma-separated language codes (`lang:zh,en`); and use `after:YYYY` / `after:YYYY-MM-DD` or `before:YYYY` / `before:YYYY-MM-DD` for date bounds.',
].join(' ');

const FETCH_DESCRIPTION = [
  'Fetch a single public web page and extract its content as Markdown.',
  'Use when you already have a concrete `http://` or `https://` URL (from the user or a `deepseek_search` result) and need the full page text rather than a search summary.',
  'Limitations: fetches one public page per call; cannot log into authenticated/paywalled pages, read binary files, or bypass sites that block automated access (which fail with HTTP 403 or 404).',
].join(' ');

function formatSearchResult(result: SearchResult, index: number): string {
  const lines: string[] = [
    `## ${index + 1}. ${result.title || '(Untitled)'}`,
    `- URL: ${result.url}`,
  ];
  const metadata: string[] = [];
  if (result.site_name !== null && result.site_name !== '') {
    metadata.push(`Site: ${result.site_name}`);
  }
  if (result.date !== null && result.date !== '') {
    metadata.push(`Date: ${result.date}`);
  }
  metadata.push(`Score: ${result.rerank_score}/3`);
  if (result.authority >= 0) {
    metadata.push(`Authority: ${result.authority}/4`);
  }
  lines.push(`- ${metadata.join(' | ')}`);

  const overview = result.summary !== '' ? result.summary : result.snippet;
  if (overview !== '') {
    lines.push('', overview);
  }
  if (result.content !== '') {
    lines.push('', '### Content', '', result.content);
  }

  return lines.join('\n');
}

function formatSearchMarkdown(query: string, data: SearchResponse): string {
  if (data.results.length === 0) {
    return `No results found for "${query}". Try broadening the keywords or removing restrictive site:/date/language operators.`;
  }
  return data.results.map(formatSearchResult).join('\n\n---\n\n');
}

function resolveApiKey(options?: ServerOptions): string | undefined {
  if (options !== undefined && 'apiKey' in options) {
    return options.apiKey;
  }
  return process.env['DEEPSEEK_API_KEY'];
}

function getValidatedApiKey(options?: ServerOptions): string | undefined {
  const apiKey = resolveApiKey(options);
  if (apiKey === undefined || apiKey.trim() === '') {
    return undefined;
  }
  return apiKey;
}

const MISSING_API_KEY_RESULT = {
  content: [
    {
      type: 'text' as const,
      text: 'DEEPSEEK_API_KEY is not set. Configure DEEPSEEK_API_KEY in the MCP server environment and restart the server; do not retry until configured.',
    },
  ],
  isError: true,
};

export function createServer(options?: ServerOptions): McpServer {
  const server = new McpServer({
    name: 'deepseek-web-mcp',
    version: '0.1.0',
  });
  const fetchFn = options?.fetch ?? globalThis.fetch;

  server.registerTool(
    'deepseek_search',
    {
      title: 'Web Search',
      description: SEARCH_DESCRIPTION,
      inputSchema: {
        query: z
          .string()
          .min(1, 'query cannot be empty. Provide 1-128 Unicode characters.')
          .refine((value) => value.trim().length > 0, {
            message:
              'query cannot be only whitespace. Provide search terms (1-128 Unicode characters), e.g. "TypeScript release notes".',
          })
          .refine(
            (value) => codePointLength(value) <= MAX_SEARCH_TEXT_CODE_POINTS,
            {
              message: `query must be at most ${MAX_SEARCH_TEXT_CODE_POINTS} Unicode characters; shorten the query or remove extra modifiers.`,
            },
          )
          .describe(
            'Search query (1-128 Unicode characters, not all whitespace), e.g. \'"release notes" site:github.com after:2025-01-01\'. Keep focused and do not append unnecessary year tokens unless filtering by time.',
          ),
        count: z
          .number()
          .int()
          .min(1)
          .max(50)
          .optional()
          .describe(
            'Number of results to return (integer 1-50, default 10). Use a smaller count (e.g. 5) when need_content is true to avoid context bloat.',
          ),
        ori_question: z
          .string()
          .min(1)
          .refine(
            (value) => codePointLength(value) <= MAX_SEARCH_TEXT_CODE_POINTS,
            {
              message: `ori_question must be at most ${MAX_SEARCH_TEXT_CODE_POINTS} Unicode characters; summarize concisely or omit it.`,
            },
          )
          .nullable()
          .optional()
          .describe(
            'Optional original natural-language user question (1-128 Unicode characters, or null) when query has been distilled into keywords/operators, to improve intent ranking.',
          ),
        localization: z
          .string()
          .optional()
          .describe(
            'Optional client IP address (e.g. "203.0.113.10") for region-localized results. Omit unless a real user/client IP is known; never invent an IP.',
          ),
        need_content: z
          .boolean()
          .optional()
          .describe(
            'Include full page body in each result (default false). Leave false when summaries suffice or when fetching only selected URLs with deepseek_fetch.',
          ),
      },
      outputSchema: {
        results: z
          .array(searchResultSchema)
          .describe(
            'Ordered search results (empty array when nothing matches).',
          ),
      },
      annotations: TOOL_ANNOTATIONS,
    },
    async (args, extra) => {
      const apiKey = getValidatedApiKey(options);
      if (apiKey === undefined) {
        return MISSING_API_KEY_RESULT;
      }

      const data = await requestDeepSeekSearch(
        {
          query: args.query,
          ...(args.count !== undefined ? { count: args.count } : {}),
          ...(args.ori_question !== undefined
            ? { ori_question: args.ori_question }
            : {}),
          ...(args.localization !== undefined
            ? { localization: args.localization }
            : {}),
          ...(args.need_content !== undefined
            ? { need_content: args.need_content }
            : {}),
        },
        {
          apiKey,
          fetchFn,
          signal: extra.signal,
        },
      );

      return {
        content: [
          {
            type: 'text',
            text: formatSearchMarkdown(args.query, data),
          },
        ],
        structuredContent: data,
      };
    },
  );

  server.registerTool(
    'deepseek_fetch',
    {
      title: 'Web Page Fetch',
      description: FETCH_DESCRIPTION,
      inputSchema: {
        url: z
          .string()
          .min(1)
          .max(MAX_FETCH_URL_LENGTH)
          .refine(isValidFetchUrl, {
            message:
              'url must be a public http:// or https:// URL with a host and no embedded username or password, e.g. "https://example.com/article".',
          })
          .describe(
            'Public http:// or https:// URL with a host and no credentials (max 8192 characters), e.g. "https://example.com/article".',
          ),
      },
      outputSchema: fetchResponseSchema.shape,
      annotations: TOOL_ANNOTATIONS,
    },
    async (args, extra) => {
      const apiKey = getValidatedApiKey(options);
      if (apiKey === undefined) {
        return MISSING_API_KEY_RESULT;
      }

      const data = await requestDeepSeekFetch(
        { url: args.url },
        {
          apiKey,
          fetchFn,
          signal: extra.signal,
        },
      );

      return {
        content: [
          {
            type: 'text',
            text: formatFetchMarkdown(data),
          },
        ],
        structuredContent: data,
      };
    },
  );

  return server;
}
