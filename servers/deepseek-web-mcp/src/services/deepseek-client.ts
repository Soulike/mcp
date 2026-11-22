import { z } from 'zod';

const DEEPSEEK_API_BASE_URL = 'https://api.deepseek.com';
const REQUEST_TIMEOUT_MS = 60_000;

const searchResultWireSchema = z.object({
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

const searchResponseWireSchema = z.object({
  results: z.array(searchResultWireSchema),
});

const fetchResponseWireSchema = z.object({
  title: z.string(),
  content: z.string(),
});

const deepSeekErrorWireSchema = z.object({
  error: z.object({
    message: z.string(),
    type: z.string().optional(),
    param: z.unknown().optional(),
    code: z.string().nullable().optional(),
  }),
});

export type SearchResult = z.infer<typeof searchResultWireSchema>;
export type SearchResponse = z.infer<typeof searchResponseWireSchema>;
export type FetchResponse = z.infer<typeof fetchResponseWireSchema>;

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

export interface DeepSeekWebClient {
  search(
    payload: SearchRequestPayload,
    signal: AbortSignal,
  ): Promise<SearchResponse>;
  fetch(
    payload: FetchRequestPayload,
    signal: AbortSignal,
  ): Promise<FetchResponse>;
}

export interface DeepSeekWebClientOptions {
  apiKey: string;
  fetchFn?: typeof fetch | undefined;
}

export type DeepSeekOperation = 'search' | 'fetch';
export type DeepSeekErrorKind = 'http' | 'timeout' | 'invalid_response';

export interface DeepSeekApiErrorDetails {
  operation: DeepSeekOperation;
  kind: DeepSeekErrorKind;
  message: string;
  status?: number | undefined;
  code?: string | undefined;
  errorType?: string | undefined;
  upstreamMessage?: string | undefined;
  cause?: unknown;
}

export class DeepSeekApiError extends Error {
  public readonly operation: DeepSeekOperation;
  public readonly kind: DeepSeekErrorKind;
  public readonly status: number | undefined;
  public readonly code: string | undefined;
  public readonly errorType: string | undefined;
  public readonly upstreamMessage: string | undefined;

  public constructor(details: DeepSeekApiErrorDetails) {
    super(
      details.message,
      details.cause !== undefined ? { cause: details.cause } : undefined,
    );
    this.name = 'DeepSeekApiError';
    this.operation = details.operation;
    this.kind = details.kind;
    this.status = details.status;
    this.code = details.code;
    this.errorType = details.errorType;
    this.upstreamMessage = details.upstreamMessage;
  }
}

function isTimeoutError(error: unknown): boolean {
  return error instanceof Error && error.name === 'TimeoutError';
}

function createTimeoutError(
  operation: DeepSeekOperation,
  cause: unknown,
): DeepSeekApiError {
  return new DeepSeekApiError({
    operation,
    kind: 'timeout',
    message: `DeepSeek ${operation} request timed out after ${REQUEST_TIMEOUT_MS / 1000}s`,
    cause,
  });
}

async function parseHttpError(
  operation: DeepSeekOperation,
  response: Response,
): Promise<DeepSeekApiError> {
  let rawBody: string;
  try {
    rawBody = (await response.text()).trim();
  } catch (error: unknown) {
    if (isTimeoutError(error)) {
      return createTimeoutError(operation, error);
    }
    throw error;
  }

  if (rawBody !== '') {
    try {
      const parsedJson: unknown = JSON.parse(rawBody);
      const parsedError = deepSeekErrorWireSchema.safeParse(parsedJson);
      if (parsedError.success) {
        const { message, type, code } = parsedError.data.error;
        return new DeepSeekApiError({
          operation,
          kind: 'http',
          status: response.status,
          code:
            code !== undefined && code !== null && code !== ''
              ? code
              : undefined,
          errorType: type !== undefined && type !== '' ? type : undefined,
          upstreamMessage: message,
          message: `DeepSeek ${operation} failed with HTTP ${response.status}: ${message}`,
        });
      }
    } catch {
      // Non-JSON error bodies fall through to raw text diagnostics.
    }
    return new DeepSeekApiError({
      operation,
      kind: 'http',
      status: response.status,
      upstreamMessage: rawBody,
      message: `DeepSeek ${operation} failed with HTTP ${response.status}: ${rawBody}`,
    });
  }

  return new DeepSeekApiError({
    operation,
    kind: 'http',
    status: response.status,
    message: `DeepSeek ${operation} failed with HTTP ${response.status}`,
  });
}

export function createDeepSeekWebClient(
  options: DeepSeekWebClientOptions,
): DeepSeekWebClient {
  const fetchFn = options.fetchFn ?? globalThis.fetch;

  async function post<TResponse>(
    operation: DeepSeekOperation,
    path: string,
    payload: unknown,
    schema: z.ZodType<TResponse>,
    signal: AbortSignal,
  ): Promise<TResponse> {
    let response: Response;
    try {
      response = await fetchFn(`${DEEPSEEK_API_BASE_URL}${path}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${options.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.any([
          signal,
          AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        ]),
      });
    } catch (error: unknown) {
      if (isTimeoutError(error)) {
        throw createTimeoutError(operation, error);
      }
      throw error;
    }

    if (!response.ok) {
      throw await parseHttpError(operation, response);
    }

    let rawJson: unknown;
    try {
      rawJson = await response.json();
    } catch (error: unknown) {
      if (isTimeoutError(error)) {
        throw createTimeoutError(operation, error);
      }
      throw new DeepSeekApiError({
        operation,
        kind: 'invalid_response',
        message: `DeepSeek ${operation} returned invalid JSON`,
        cause: error,
      });
    }

    const parsed = schema.safeParse(rawJson);
    if (!parsed.success) {
      throw new DeepSeekApiError({
        operation,
        kind: 'invalid_response',
        message: `DeepSeek ${operation} returned an unexpected response shape: ${parsed.error.message}`,
        cause: parsed.error,
      });
    }

    return parsed.data;
  }

  return {
    search(payload, signal) {
      return post(
        'search',
        '/v1/tools/search',
        payload,
        searchResponseWireSchema,
        signal,
      );
    },
    fetch(payload, signal) {
      return post(
        'fetch',
        '/v1/tools/fetch',
        payload,
        fetchResponseWireSchema,
        signal,
      );
    },
  };
}
