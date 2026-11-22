import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { executeWithClient } from '../presenters/errors.ts';
import type {
  DeepSeekWebClient,
  SearchResponse,
  SearchResult,
} from '../services/deepseek-client.ts';

const MAX_SEARCH_TEXT_CODE_POINTS = 128;

const SEARCH_DESCRIPTION = [
  'Search live web pages when you need up-to-date information or do not have a specific URL yet.',
  'Returns ranked results with URLs, publish dates, quality/authority scores, and ~600-800 character summaries.',
  'By default full page bodies are omitted (`need_content=false`); prefer reviewing summaries first and calling `deepseek_fetch` on selected URLs rather than enabling `need_content=true` across many results.',
  'Limitations: text web search only—does not support image search.',
  'Query operators: join multiple `site:` filters with `OR` (`site:a.com OR site:b.com`); separate `-site:`, `-term`, `-"phrase"`, and `"exact phrase"` with spaces; use comma-separated language codes (`lang:zh,en`); and use `after:YYYY` / `after:YYYY-MM-DD` or `before:YYYY` / `before:YYYY-MM-DD` for date bounds.',
].join(' ');

const searchOutputResultSchema = z.object({
  rerank_score: z
    .number()
    .describe(
      'Relevance and quality score from 0 to 3 (>= 1.5 indicates a high-quality result).',
    ),
  title: z.string().describe('Result page title.'),
  url: z.string().describe('Result page URL.'),
  snippet: z
    .string()
    .describe('Short excerpt (~100-200 characters) for brief previews.'),
  summary: z
    .string()
    .describe(
      'Longer query-focused summary (~600-800 characters) suited for LLM reading.',
    ),
  content: z
    .string()
    .describe(
      'Full extracted page body; empty string when need_content is false or unavailable.',
    ),
  site_name: z
    .string()
    .nullable()
    .describe('Publisher or site name, or null if unknown.'),
  site_icon: z
    .string()
    .nullable()
    .describe('Site favicon URL, or null if unknown.'),
  date: z
    .string()
    .nullable()
    .describe('Publication timestamp in UTC RFC 3339 format, or null.'),
  authority: z
    .number()
    .int()
    .describe(
      'Source authority score from 0 to 4 (>= 3 is highly authoritative; -1 means unknown).',
    ),
});

function codePointLength(value: string): number {
  return [...value].length;
}

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

export function registerSearchTool(
  server: McpServer,
  client: DeepSeekWebClient | undefined,
): void {
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
          .array(searchOutputResultSchema)
          .describe(
            'Ordered search results (empty array when nothing matches).',
          ),
      },
      annotations: {
        readOnlyHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    (args, extra) =>
      executeWithClient(
        'search',
        client,
        extra.signal,
        async (activeClient) => {
          const data = await activeClient.search(
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
            extra.signal,
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
      ),
  );
}
