import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
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
  return `# ${data.title}\n\n${data.content}`;
}

const SEARCH_DESCRIPTION = [
  'Search the web using DeepSeek Search API.',
  'Supports DeepSeek search operators inside `query`:',
  '`site:example.com`, `-site:example.com`, `-keyword`, `-"phrase"`, `"exact phrase"`, `lang:zh,en`, `after:YYYY-MM-DD`, `before:YYYY-MM-DD`.',
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
  metadata.push(`Score: ${result.rerank_score}`);
  metadata.push(`Authority: ${result.authority}`);
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
    return `No results found for "${query}".`;
  }
  return data.results.map(formatSearchResult).join('\n\n---\n\n');
}

function resolveApiKey(options?: ServerOptions): string | undefined {
  if (options !== undefined && 'apiKey' in options) {
    return options.apiKey;
  }
  return process.env['DEEPSEEK_API_KEY'];
}

export function createServer(options?: ServerOptions): McpServer {
  const server = new McpServer({
    name: 'deepseek-web-mcp',
    version: '0.1.0',
  });
  const fetchFn = options?.fetch ?? globalThis.fetch;

  server.registerTool(
    'deepseek_search',
    {
      description: SEARCH_DESCRIPTION,
      inputSchema: {
        query: z
          .string()
          .min(1)
          .refine((value) => value.trim().length > 0, {
            message: 'query must not be only whitespace',
          })
          .refine(
            (value) => codePointLength(value) <= MAX_SEARCH_TEXT_CODE_POINTS,
            {
              message: `query must be at most ${MAX_SEARCH_TEXT_CODE_POINTS} Unicode characters`,
            },
          )
          .describe(
            'Search query (1-128 Unicode characters, non-whitespace). Supports site:, -site:, -, -"...", "...", lang:, after:, before:.',
          ),
        count: z
          .number()
          .int()
          .min(1)
          .max(50)
          .optional()
          .describe('Number of results to return (1-50, default 10).'),
        ori_question: z
          .string()
          .min(1)
          .refine(
            (value) => codePointLength(value) <= MAX_SEARCH_TEXT_CODE_POINTS,
            {
              message: `ori_question must be at most ${MAX_SEARCH_TEXT_CODE_POINTS} Unicode characters`,
            },
          )
          .nullable()
          .optional()
          .describe(
            'Optional original user question (1-128 characters, or null) to improve search intent understanding.',
          ),
        localization: z
          .string()
          .optional()
          .describe('Optional IP address for localized search results.'),
        need_content: z
          .boolean()
          .optional()
          .describe(
            'Whether to include full page content in results (default false).',
          ),
      },
      outputSchema: {
        results: z.array(searchResultSchema),
      },
      annotations: TOOL_ANNOTATIONS,
    },
    async (args, extra) => {
      const apiKey = resolveApiKey(options);
      if (apiKey === undefined || apiKey.trim() === '') {
        return {
          content: [
            {
              type: 'text',
              text: 'DEEPSEEK_API_KEY is not configured.',
            },
          ],
          isError: true,
        };
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
      description: 'Fetch a web page as Markdown using DeepSeek Fetch API.',
      inputSchema: {
        url: z
          .string()
          .min(1)
          .max(MAX_FETCH_URL_LENGTH)
          .refine(isValidFetchUrl, {
            message:
              'url must be an http:// or https:// URL with a host and no credentials',
          })
          .describe(
            'Web page URL to fetch (http/https, max 8192 characters, no username or password).',
          ),
      },
      outputSchema: {
        title: z.string(),
        content: z.string(),
      },
      annotations: TOOL_ANNOTATIONS,
    },
    async (args, extra) => {
      const apiKey = resolveApiKey(options);
      if (apiKey === undefined || apiKey.trim() === '') {
        return {
          content: [
            {
              type: 'text',
              text: 'DEEPSEEK_API_KEY is not configured.',
            },
          ],
          isError: true,
        };
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
