import { APICallError, RetryError } from 'ai';

export type ProviderErrorCode =
  'AI_AUTH_FAILED' | 'AI_RATE_LIMITED' | 'AI_UNAVAILABLE' | 'AI_BAD_RESPONSE';

/** The status code of a provider failure, looking through the SDK's retry wrapper. */
function statusOf(error: unknown): number | undefined {
  if (RetryError.isInstance(error)) return statusOf(error.lastError);
  if (APICallError.isInstance(error)) return error.statusCode;
  return undefined;
}

/** Maps a failure of the SDK to a stable code for the client. */
export function classifyProviderError(error: unknown): ProviderErrorCode {
  const status = statusOf(error);
  if (status === 401 || status === 403) return 'AI_AUTH_FAILED';
  if (status === 429) return 'AI_RATE_LIMITED';
  if (status === undefined || status >= 500) {
    const inner = RetryError.isInstance(error) ? error.lastError : error;
    // No status: the request did not reach the provider (refused, timed out).
    if (APICallError.isInstance(inner) || status !== undefined) return 'AI_UNAVAILABLE';
    if (inner instanceof Error && /fetch|ECONN|ENOTFOUND|timeout|abort/i.test(inner.message)) {
      return 'AI_UNAVAILABLE';
    }
  }
  return 'AI_BAD_RESPONSE';
}

/**
 * What may be logged about a provider failure. The SDK's error objects carry
 * the request body (the user's document) and sometimes headers: never log them.
 */
export function loggableProviderError(error: unknown): { name: string; statusCode?: number } {
  const status = statusOf(error);
  const name = error instanceof Error ? error.name : typeof error;
  return status === undefined ? { name } : { name, statusCode: status };
}
