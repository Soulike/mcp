import { z } from 'zod';

const DEEPSEEK_API_BASE_URL = 'https://api.deepseek.com';
const REQUEST_TIMEOUT_MS = 60_000;

export const searchResultSchema = z.object({
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

export type SearchResult = z.infer<typeof searchResultSchema>;

export const searchResponseSchema = z.object({
  results: z.array(searchResultSchema),
});

export type SearchResponse = z.infer<typeof searchResponseSchema>;

export const fetchResponseSchema = z.object({
  title: z.string().describe('Extracted page title, or empty string.'),
  content: z.string().describe('Extracted page body in Markdown.'),
});

export type FetchResponse = z.infer<typeof fetchResponseSchema>;

export interface SearchRequestPayload {
  query: string;
  count?: number | undefined;
  ori_question?: string | null | undefined;
  localization?: string | undefined;
  need_content?: boolean | undefined;
}

export interface FetchRequestPayload {
  url: string;
}

const deepSeekErrorSchema = z.object({
  error: z.object({
    message: z.string(),
    type: z.string().optional(),
    param: z.unknown().optional(),
    code: z.string().nullable().optional(),
  }),
});

function getStatusGuidance(
  operation: 'Search' | 'Fetch',
  status: number,
): string {
  switch (status) {
    case 400:
    case 413:
      return 'Adjust the request parameters and retry.';
    case 401:
      return 'DEEPSEEK_API_KEY is missing or invalid; do not retry until the user fixes credentials.';
    case 402:
      return 'DeepSeek account balance is insufficient; do not retry until the user adds credit.';
    case 403:
      return operation === 'Fetch'
        ? 'Target URL was rejected by security policy; do not retry this URL—try a different source.'
        : 'Request was forbidden; do not retry unchanged.';
    case 404:
      return operation === 'Fetch'
        ? 'No extractable Markdown content at this URL (unreachable, blocked, unsupported content type, or empty page); do not retry this URL—try another URL or use search summaries.'
        : 'Resource not found; do not retry unchanged.';
    case 408:
    case 500:
    case 504:
      return 'Transient upstream timeout or server error; safe to retry after a brief pause.';
    case 429:
      return 'Rate limit exceeded; pause briefly and reduce concurrent calls before retrying.';
    default:
      if (status >= 500) {
        return 'Transient upstream server error; safe to retry after a brief pause.';
      }
      return 'Do not retry without changing the request.';
  }
}

async function formatHttpErrorMessage(
  operation: 'Search' | 'Fetch',
  response: Response,
): Promise<string> {
  const guidance = getStatusGuidance(operation, response.status);
  const rawBody = (await response.text()).trim();
  if (rawBody !== '') {
    try {
      const parsedJson: unknown = JSON.parse(rawBody);
      const parsedError = deepSeekErrorSchema.safeParse(parsedJson);
      if (parsedError.success) {
        const { message, type, code } = parsedError.data.error;
        const tags = [code, type].filter(
          (value): value is string =>
            value !== undefined && value !== null && value !== '',
        );
        const tagSuffix = tags.length > 0 ? ` [${tags.join(' / ')}]` : '';
        return `DeepSeek ${operation} failed (HTTP ${response.status}${tagSuffix}): ${message}. ${guidance}`;
      }
    } catch {
      // Fall through to raw text body when error payload is not JSON.
    }
    return `DeepSeek ${operation} failed (HTTP ${response.status}): ${rawBody}. ${guidance}`;
  }
  return `DeepSeek ${operation} failed (HTTP ${response.status}). ${guidance}`;
}

export interface DeepSeekRequestOptions {
  apiKey: string;
  fetchFn: typeof fetch;
  signal: AbortSignal;
}

async function postDeepSeekEndpoint<TResponse>(
  operation: 'Search' | 'Fetch',
  path: string,
  payload: unknown,
  schema: z.ZodType<TResponse>,
  options: DeepSeekRequestOptions,
): Promise<TResponse> {
  let response: Response;
  try {
    response = await options.fetchFn(`${DEEPSEEK_API_BASE_URL}${path}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${options.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.any([
        options.signal,
        AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      ]),
    });
  } catch (error: unknown) {
    if (error instanceof Error && error.name === 'TimeoutError') {
      throw new Error(
        `DeepSeek ${operation} request timed out after ${REQUEST_TIMEOUT_MS / 1000}s. Safe to retry or try a different query/URL.`,
        { cause: error },
      );
    }
    throw error;
  }

  if (!response.ok) {
    throw new Error(await formatHttpErrorMessage(operation, response));
  }

  const raw: unknown = await response.json();
  return schema.parse(raw);
}

export async function requestDeepSeekSearch(
  payload: SearchRequestPayload,
  options: DeepSeekRequestOptions,
): Promise<SearchResponse> {
  return postDeepSeekEndpoint(
    'Search',
    '/v1/tools/search',
    payload,
    searchResponseSchema,
    options,
  );
}

export async function requestDeepSeekFetch(
  payload: FetchRequestPayload,
  options: DeepSeekRequestOptions,
): Promise<FetchResponse> {
  return postDeepSeekEndpoint(
    'Fetch',
    '/v1/tools/fetch',
    payload,
    fetchResponseSchema,
    options,
  );
}
