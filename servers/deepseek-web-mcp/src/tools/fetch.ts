import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  createMissingApiKeyResult,
  createToolErrorResult,
} from '../presenters/errors.ts';
import type {
  DeepSeekWebClient,
  FetchResponse,
} from '../services/deepseek-client.ts';

const MAX_FETCH_URL_LENGTH = 8192;

const FETCH_DESCRIPTION = [
  'Fetch a single public web page and extract its content as Markdown.',
  'Use when you already have a concrete `http://` or `https://` URL (from the user or a `deepseek_search` result) and need the full page text rather than a search summary.',
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
    async (args, extra) => {
      if (client === undefined) {
        return createMissingApiKeyResult();
      }

      try {
        const data = await client.fetch({ url: args.url }, extra.signal);

        return {
          content: [
            {
              type: 'text',
              text: formatFetchMarkdown(data),
            },
          ],
          structuredContent: data,
        };
      } catch (error: unknown) {
        if (extra.signal.aborted) {
          throw error;
        }
        return createToolErrorResult('fetch', error);
      }
    },
  );
}
