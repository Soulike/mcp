import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { executeWithClient } from '../presenters/errors.ts';
import {
  MAX_TOOL_OUTPUT_CHARS,
  sliceForJsonBudget,
  sliceUtf16Safe,
} from '../presenters/output-limit.ts';
import type {
  DeepSeekWebClient,
  SearchResponse,
  SearchResult,
} from '../services/deepseek-client.ts';

const MAX_SEARCH_TEXT_CODE_POINTS = 128;
const RESULT_SEPARATOR = '\n\n---\n\n';
const CONTENT_SECTION_HEADER = '\n\n### Content\n\n';
const SEARCH_JSON_WRAPPER_LENGTH = '{"results":[]}'.length;

const SEARCH_DESCRIPTION = [
  'Search live web pages when you need up-to-date information or do not have a specific URL yet.',
  'Returns ranked results with URLs, publish dates, quality/authority scores, and ~600-800 character summaries.',
  'By default full page bodies are omitted (`need_content=false`); prefer reviewing summaries first and calling `deepseek_fetch` on selected URLs rather than enabling `need_content=true` across many results.',
  `Outputs exceeding ${MAX_TOOL_OUTPUT_CHARS.toLocaleString('en-US')} characters keep the highest-ranked results that fit and omit the rest with a notice.`,
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
  return data.results.map(formatSearchResult).join(RESULT_SEPARATOR);
}

function buildSearchTruncationNotice(
  shownCount: number,
  totalCount: number,
): string {
  return `\n\n[Output truncated: showing top ${shownCount} of ${totalCount} results due to the ${MAX_TOOL_OUTPUT_CHARS.toLocaleString('en-US')}-character limit. Narrow your query, reduce count, or omit need_content to see more results.]`;
}

function buildFirstResultTruncatedNotice(totalCount: number): string {
  const omittedPart =
    totalCount > 1
      ? `, and ${totalCount - 1} remaining result(s) were omitted`
      : '';
  return `\n\n[Output truncated: result 1 exceeded the ${MAX_TOOL_OUTPUT_CHARS.toLocaleString('en-US')}-character limit and was truncated${omittedPart}. Narrow your query, omit need_content, or call deepseek_fetch on the URL.]`;
}

function fitsSingleSearchBudget(
  candidate: SearchResult,
  markdownBudget: number,
  jsonItemBudget: number,
): boolean {
  return (
    formatSearchResult(candidate, 0).length <= markdownBudget &&
    JSON.stringify(candidate).length <= jsonItemBudget
  );
}

function truncateSingleSearchResult(
  result: SearchResult,
  markdownBudget: number,
  jsonItemBudget: number,
): SearchResult {
  const withoutContent: SearchResult = { ...result, content: '' };
  if (
    result.content !== '' &&
    fitsSingleSearchBudget(withoutContent, markdownBudget, jsonItemBudget)
  ) {
    const baseMarkdownLen = formatSearchResult(withoutContent, 0).length;
    const baseJsonLen = JSON.stringify(withoutContent).length;
    const maxContentPlain =
      markdownBudget - baseMarkdownLen - CONTENT_SECTION_HEADER.length;
    const maxContentJson = jsonItemBudget - baseJsonLen + 2;
    if (maxContentPlain > 0 && maxContentJson >= 2) {
      return {
        ...withoutContent,
        content: sliceForJsonBudget(
          result.content,
          maxContentJson,
          maxContentPlain,
        ),
      };
    }
    return withoutContent;
  }

  let candidate: SearchResult = withoutContent;
  if (fitsSingleSearchBudget(candidate, markdownBudget, jsonItemBudget)) {
    return candidate;
  }

  if (candidate.site_icon !== null) {
    candidate = { ...candidate, site_icon: null };
    if (fitsSingleSearchBudget(candidate, markdownBudget, jsonItemBudget)) {
      return candidate;
    }
  }

  if (candidate.summary !== '' && candidate.snippet !== '') {
    candidate = { ...candidate, snippet: '' };
    if (fitsSingleSearchBudget(candidate, markdownBudget, jsonItemBudget)) {
      return candidate;
    }
  }

  const withoutOverview: SearchResult = {
    ...candidate,
    summary: '',
    snippet: '',
  };
  const overviewSource =
    result.summary !== '' ? result.summary : result.snippet;
  if (
    overviewSource !== '' &&
    fitsSingleSearchBudget(withoutOverview, markdownBudget, jsonItemBudget)
  ) {
    const baseMarkdownLen = formatSearchResult(withoutOverview, 0).length;
    const baseJsonLen = JSON.stringify(withoutOverview).length;
    const maxOverviewPlain = markdownBudget - baseMarkdownLen - 2;
    const maxOverviewJson = jsonItemBudget - baseJsonLen + 2;
    if (maxOverviewPlain > 0 && maxOverviewJson >= 2) {
      const slicedOverview = sliceForJsonBudget(
        overviewSource,
        maxOverviewJson,
        maxOverviewPlain,
      );
      return result.summary !== ''
        ? { ...withoutOverview, summary: slicedOverview }
        : { ...withoutOverview, snippet: slicedOverview };
    }
    return withoutOverview;
  }

  candidate = withoutOverview;
  if (fitsSingleSearchBudget(candidate, markdownBudget, jsonItemBudget)) {
    return candidate;
  }

  if (candidate.site_name !== null) {
    candidate = { ...candidate, site_name: null };
    if (fitsSingleSearchBudget(candidate, markdownBudget, jsonItemBudget)) {
      return candidate;
    }
  }

  if (candidate.date !== null) {
    candidate = { ...candidate, date: null };
    if (fitsSingleSearchBudget(candidate, markdownBudget, jsonItemBudget)) {
      return candidate;
    }
  }

  const withoutTitle: SearchResult = { ...candidate, title: '' };
  if (
    candidate.title !== '' &&
    fitsSingleSearchBudget(withoutTitle, markdownBudget, jsonItemBudget)
  ) {
    const maxTitlePlain =
      markdownBudget - formatSearchResult(withoutTitle, 0).length;
    const maxTitleJson =
      jsonItemBudget - JSON.stringify(withoutTitle).length + 2;
    return {
      ...withoutTitle,
      title: sliceForJsonBudget(candidate.title, maxTitleJson, maxTitlePlain),
    };
  }

  candidate = withoutTitle;
  const withoutUrl: SearchResult = { ...candidate, url: '' };
  const maxUrlPlain = markdownBudget - formatSearchResult(withoutUrl, 0).length;
  const maxUrlJson = jsonItemBudget - JSON.stringify(withoutUrl).length + 2;
  return {
    ...withoutUrl,
    url: sliceForJsonBudget(candidate.url, maxUrlJson, maxUrlPlain),
  };
}

function applySearchOutputLimit(
  query: string,
  data: SearchResponse,
): {
  text: string;
  structuredContent: SearchResponse;
} {
  if (data.results.length === 0) {
    return {
      text: formatSearchMarkdown(query, data),
      structuredContent: data,
    };
  }

  const formattedItems = data.results.map(formatSearchResult);
  const itemJsonLengths = data.results.map(
    (item) => JSON.stringify(item).length,
  );
  const fullText = formattedItems.join(RESULT_SEPARATOR);
  const fullJsonLength =
    SEARCH_JSON_WRAPPER_LENGTH +
    itemJsonLengths.reduce((sum, len) => sum + len, 0) +
    Math.max(0, itemJsonLengths.length - 1);

  if (
    fullText.length <= MAX_TOOL_OUTPUT_CHARS &&
    fullJsonLength <= MAX_TOOL_OUTPUT_CHARS
  ) {
    return {
      text: fullText,
      structuredContent: data,
    };
  }

  let keptCount = 0;
  let currentTextLength = 0;
  let currentJsonLength = SEARCH_JSON_WRAPPER_LENGTH;
  for (let index = 0; index < formattedItems.length; index++) {
    const item = formattedItems[index];
    const itemJsonLength = itemJsonLengths[index];
    if (item === undefined || itemJsonLength === undefined) {
      continue;
    }
    const separatorLength = index === 0 ? 0 : RESULT_SEPARATOR.length;
    const candidateTextLength =
      currentTextLength + separatorLength + item.length;
    const candidateJsonLength =
      currentJsonLength + (index === 0 ? 0 : 1) + itemJsonLength;
    const notice = buildSearchTruncationNotice(
      index + 1,
      formattedItems.length,
    );
    if (
      candidateTextLength + notice.length <= MAX_TOOL_OUTPUT_CHARS &&
      candidateJsonLength <= MAX_TOOL_OUTPUT_CHARS
    ) {
      keptCount = index + 1;
      currentTextLength = candidateTextLength;
      currentJsonLength = candidateJsonLength;
    } else {
      break;
    }
  }

  if (keptCount > 0) {
    const notice = buildSearchTruncationNotice(keptCount, data.results.length);
    return {
      text: `${formattedItems.slice(0, keptCount).join(RESULT_SEPARATOR)}${notice}`,
      structuredContent: {
        results: data.results.slice(0, keptCount),
      },
    };
  }

  const first = data.results[0];
  if (first === undefined) {
    return {
      text: formatSearchMarkdown(query, { results: [] }),
      structuredContent: { results: [] },
    };
  }

  const notice = buildFirstResultTruncatedNotice(data.results.length);
  const markdownBudget = Math.max(0, MAX_TOOL_OUTPUT_CHARS - notice.length);
  const jsonItemBudget = Math.max(
    0,
    MAX_TOOL_OUTPUT_CHARS - SEARCH_JSON_WRAPPER_LENGTH,
  );
  const truncatedFirst = truncateSingleSearchResult(
    first,
    markdownBudget,
    jsonItemBudget,
  );
  const truncatedText = sliceUtf16Safe(
    formatSearchResult(truncatedFirst, 0),
    markdownBudget,
  );

  return {
    text: `${truncatedText}${notice}`,
    structuredContent: {
      results: [truncatedFirst],
    },
  };
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
          const limited = applySearchOutputLimit(args.query, data);

          return {
            content: [
              {
                type: 'text',
                text: limited.text,
              },
            ],
            structuredContent: limited.structuredContent,
          };
        },
      ),
  );
}
