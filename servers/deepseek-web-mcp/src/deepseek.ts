import { z } from 'zod';

const DEEPSEEK_API_BASE_URL = 'https://api.deepseek.com';
const REQUEST_TIMEOUT_MS = 60_000;

export const searchResultSchema = z.object({
  rerank_score: z.number(),
  title: z.string(),
  url: z.string(),
  snippet: z.string(),
  summary: z.string(),
  content: z.string(),
  site_name: z.string().nullable(),
  site_icon: z.string().nullable(),
  date: z.string().nullable(),
  authority: z.number().int(),
});

export type SearchResult = z.infer<typeof searchResultSchema>;

export const searchResponseSchema = z.object({
  results: z.array(searchResultSchema),
});

export type SearchResponse = z.infer<typeof searchResponseSchema>;

export const fetchResponseSchema = z.object({
  title: z.string(),
  content: z.string(),
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

async function formatHttpErrorMessage(
  operation: 'Search' | 'Fetch',
  response: Response,
): Promise<string> {
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
        return `DeepSeek ${operation} API failed (HTTP ${response.status}${tagSuffix}): ${message}`;
      }
    } catch {
      // Fall through to raw text body when error payload is not JSON.
    }
    return `DeepSeek ${operation} API failed (HTTP ${response.status}): ${rawBody}`;
  }
  return `DeepSeek ${operation} API failed (HTTP ${response.status})`;
}

async function postDeepSeekEndpoint<TResponse>(
  operation: 'Search' | 'Fetch',
  path: string,
  payload: unknown,
  schema: z.ZodType<TResponse>,
  options: {
    apiKey: string;
    fetchFn: typeof fetch;
    signal: AbortSignal;
  },
): Promise<TResponse> {
  const response = await options.fetchFn(`${DEEPSEEK_API_BASE_URL}${path}`, {
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

  if (!response.ok) {
    throw new Error(await formatHttpErrorMessage(operation, response));
  }

  const raw: unknown = await response.json();
  return schema.parse(raw);
}

export async function requestDeepSeekSearch(
  payload: SearchRequestPayload,
  options: {
    apiKey: string;
    fetchFn: typeof fetch;
    signal: AbortSignal;
  },
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
  options: {
    apiKey: string;
    fetchFn: typeof fetch;
    signal: AbortSignal;
  },
): Promise<FetchResponse> {
  return postDeepSeekEndpoint(
    'Fetch',
    '/v1/tools/fetch',
    payload,
    fetchResponseSchema,
    options,
  );
}
