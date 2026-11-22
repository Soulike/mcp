import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import {
  DeepSeekApiError,
  type DeepSeekOperation,
  type DeepSeekWebClient,
} from '../services/deepseek-client.ts';
import { MAX_TOOL_OUTPUT_CHARS, sliceUtf16Safe } from './output-limit.ts';

function operationLabel(operation: DeepSeekOperation): string {
  return operation === 'search' ? 'Search' : 'Fetch';
}

function getHttpGuidance(
  operation: DeepSeekOperation,
  status: number | undefined,
): string {
  if (status === undefined) {
    return 'Do not retry without changing the request.';
  }
  switch (status) {
    case 400:
    case 413:
      return 'Adjust the request parameters and retry.';
    case 401:
      return 'DEEPSEEK_API_KEY is missing or invalid; do not retry until the user fixes credentials.';
    case 402:
      return 'DeepSeek account balance is insufficient; do not retry until the user adds credit.';
    case 403:
      return operation === 'fetch'
        ? 'Target URL was rejected by security policy; do not retry this URL—try a different source.'
        : 'Request was forbidden; do not retry unchanged.';
    case 404:
      return operation === 'fetch'
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

function capErrorText(text: string): string {
  if (text.length <= MAX_TOOL_OUTPUT_CHARS) {
    return text;
  }
  const notice = `\n\n[Error output truncated: exceeded the ${MAX_TOOL_OUTPUT_CHARS.toLocaleString('en-US')}-character limit.]`;
  const maxBodyChars = Math.max(0, MAX_TOOL_OUTPUT_CHARS - notice.length);
  return `${sliceUtf16Safe(text, maxBodyChars)}${notice}`;
}

function formatDeepSeekApiError(error: DeepSeekApiError): string {
  const label = operationLabel(error.operation);

  switch (error.kind) {
    case 'timeout':
      return capErrorText(
        `${error.message}. Safe to retry or try a different query/URL.`,
      );
    case 'invalid_response':
      return capErrorText(
        `${error.message}. Retry briefly or inspect the upstream response.`,
      );
    case 'http': {
      const guidance = getHttpGuidance(error.operation, error.status);
      const tags = [error.code, error.errorType].filter(
        (value): value is string => value !== undefined && value !== '',
      );
      const tagSuffix = tags.length > 0 ? ` [${tags.join(' / ')}]` : '';
      const statusPart =
        error.status !== undefined ? `HTTP ${error.status}` : 'HTTP error';
      const prefix = `DeepSeek ${label} failed (${statusPart}${tagSuffix})`;
      const suffix = `. ${guidance}`;

      if (error.upstreamMessage === undefined || error.upstreamMessage === '') {
        return capErrorText(`${prefix}${suffix}`);
      }

      const full = `${prefix}: ${error.upstreamMessage}${suffix}`;
      if (full.length <= MAX_TOOL_OUTPUT_CHARS) {
        return full;
      }

      const detailNotice = '... [upstream error detail truncated]';
      const maxDetailChars = Math.max(
        0,
        MAX_TOOL_OUTPUT_CHARS -
          prefix.length -
          2 -
          detailNotice.length -
          suffix.length,
      );
      const slicedDetail = sliceUtf16Safe(
        error.upstreamMessage,
        maxDetailChars,
      );
      return capErrorText(`${prefix}: ${slicedDetail}${detailNotice}${suffix}`);
    }
  }
}

export function createMissingApiKeyResult(): CallToolResult {
  return {
    content: [
      {
        type: 'text',
        text: 'DEEPSEEK_API_KEY is not set. Configure DEEPSEEK_API_KEY in the MCP server environment and restart the server; do not retry until configured.',
      },
    ],
    isError: true,
  };
}

function createToolErrorResult(
  operation: DeepSeekOperation,
  error: unknown,
): CallToolResult {
  if (error instanceof DeepSeekApiError) {
    return {
      content: [{ type: 'text', text: formatDeepSeekApiError(error) }],
      isError: true,
    };
  }

  const label = operationLabel(operation);
  const detail = error instanceof Error ? error.message : String(error);
  return {
    content: [
      {
        type: 'text',
        text: capErrorText(`DeepSeek ${label} failed: ${detail}`),
      },
    ],
    isError: true,
  };
}

export async function executeWithClient(
  operation: DeepSeekOperation,
  client: DeepSeekWebClient | undefined,
  signal: AbortSignal,
  run: (activeClient: DeepSeekWebClient) => Promise<CallToolResult>,
): Promise<CallToolResult> {
  if (client === undefined) {
    return createMissingApiKeyResult();
  }

  try {
    return await run(client);
  } catch (error: unknown) {
    if (signal.aborted) {
      throw error;
    }
    return createToolErrorResult(operation, error);
  }
}
