import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { executeWithClient } from '../presenters/errors.ts';
import {
  MAX_TOOL_OUTPUT_CHARS,
  sliceForJsonBudget,
} from '../presenters/output-limit.ts';
import type {
  DeepSeekWebClient,
  FetchResponse,
} from '../services/deepseek-client.ts';

const MAX_FETCH_URL_LENGTH = 8192;
const MAX_FETCH_TITLE_CHARS = 500;

const FETCH_DESCRIPTION = [
  'Fetch a single public web page and extract its content as Markdown.',
  'Use when you already have a concrete `http://` or `https://` URL (from the user or a `deepseek_search` result) and need the full page text rather than a search summary.',
  `Outputs exceeding ${MAX_TOOL_OUTPUT_CHARS.toLocaleString('en-US')} characters are truncated with a notice.`,
  'Limitations: fetches one public page per call; cannot log into authenticated/paywalled pages, read binary files, or bypass sites that block automated access (which fail with HTTP 403 or 404).',
].join(' ');

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

function buildFetchTruncationNotice(originalLength: number): string {
  return `\n\n[Output truncated: exceeded the ${MAX_TOOL_OUTPUT_CHARS.toLocaleString('en-US')}-character limit (original length: ${originalLength.toLocaleString('en-US')} characters).]`;
}

function applyFetchOutputLimit(data: FetchResponse): {
  text: string;
  structuredContent: FetchResponse;
} {
  const rendered = formatFetchMarkdown(data);
  const jsonLength = JSON.stringify(data).length;
  if (
    rendered.length <= MAX_TOOL_OUTPUT_CHARS &&
    jsonLength <= MAX_TOOL_OUTPUT_CHARS
  ) {
    return {
      text: rendered,
      structuredContent: data,
    };
  }

  const notice = buildFetchTruncationNotice(
    Math.max(rendered.length, jsonLength),
  );
  const safeTitle =
    data.title.length > MAX_FETCH_TITLE_CHARS ||
    JSON.stringify(data.title).length > MAX_FETCH_TITLE_CHARS * 2
      ? `${sliceForJsonBudget(data.title, MAX_FETCH_TITLE_CHARS * 2 - 3, MAX_FETCH_TITLE_CHARS - 3)}...`
      : data.title;

  if (data.content === '') {
    const titleOnly = `# ${safeTitle}`;
    return {
      text: `${titleOnly}${notice}`,
      structuredContent: {
        title: safeTitle,
        content: '',
      },
    };
  }

  const firstNonEmptyLine = data.content
    .split('\n')
    .find((line) => line.trim() !== '');
  const hasLeadingTitle =
    safeTitle !== '' && firstNonEmptyLine?.trim() === `# ${safeTitle.trim()}`;
  const titlePrefix =
    safeTitle === '' || hasLeadingTitle ? '' : `# ${safeTitle}\n\n`;

  const maxBodyPlainChars = Math.max(
    0,
    MAX_TOOL_OUTPUT_CHARS - titlePrefix.length - notice.length,
  );
  const noticeJsonEnvelopeLength = JSON.stringify({
    title: safeTitle,
    content: notice,
  }).length;
  const maxBodyJsonChars = Math.max(
    2,
    MAX_TOOL_OUTPUT_CHARS - noticeJsonEnvelopeLength + 2,
  );
  const bodySlice = sliceForJsonBudget(
    data.content,
    maxBodyJsonChars,
    maxBodyPlainChars,
  );
  const truncatedContent = `${bodySlice}${notice}`;

  return {
    text: `${titlePrefix}${truncatedContent}`,
    structuredContent: {
      title: safeTitle,
      content: truncatedContent,
    },
  };
}

export function registerFetchTool(
  server: McpServer,
  client: DeepSeekWebClient | undefined,
): void {
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
      outputSchema: {
        title: z.string().describe('Extracted page title, or empty string.'),
        content: z.string().describe('Extracted page body in Markdown.'),
      },
      annotations: {
        readOnlyHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    (args, extra) =>
      executeWithClient('fetch', client, extra.signal, async (activeClient) => {
        const data = await activeClient.fetch({ url: args.url }, extra.signal);
        const limited = applyFetchOutputLimit(data);

        return {
          content: [
            {
              type: 'text',
              text: limited.text,
            },
          ],
          structuredContent: limited.structuredContent,
        };
      }),
  );
}
