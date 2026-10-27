import { apiErrorBody, CSRF_HEADER, type ErrorCode } from '@galley/shared';

/** A failed API call, carrying the stable error code and per-field i18n keys. */
export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    readonly fields: { path: string; messageKey: string }[] = [],
  ) {
    super(code);
    this.name = 'ApiRequestError';
  }
}

let csrfToken: string | null = null;

/** Remembers the CSRF token of the current session; sent with every state-changing call. */
export function setCsrfToken(token: string | null): void {
  csrfToken = token;
}

/** Headers a state-changing call needs besides its body: the CSRF token. */
export function csrfHeaders(): Record<string, string> {
  return csrfToken === null ? {} : { [CSRF_HEADER]: csrfToken };
}

export interface RequestOptions {
  json?: unknown;
  form?: FormData;
  query?: Record<string, string | undefined>;
  signal?: AbortSignal;
}

function buildUrl(path: string, query: RequestOptions['query']): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined && value !== '') params.set(key, value);
  }
  const search = params.toString();
  return search === '' ? path : `${path}?${search}`;
}

/** The {@link ApiRequestError} a failed response carries in its JSON body. */
export async function errorOf(response: Response): Promise<ApiRequestError> {
  const payload: unknown = await response.json().catch(() => null);
  const parsed = apiErrorBody.safeParse(payload);
  if (!parsed.success) return new ApiRequestError(response.status, 'INTERNAL_ERROR');
  return new ApiRequestError(response.status, parsed.data.error.code, parsed.data.error.fields);
}

/**
 * Calls the API and returns the parsed JSON body (`undefined` for 204).
 * Errors are normalised to {@link ApiRequestError}; network failures map to
 * SERVICE_UNAVAILABLE so the interface always has a message to show.
 */
export async function api<T>(
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  path: string,
  options: RequestOptions = {},
): Promise<T> {
  const headers: Record<string, string> = {};
  let body: BodyInit | undefined;
  if (options.json !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(options.json);
  } else if (options.form !== undefined) {
    body = options.form;
  }
  if (method !== 'GET') Object.assign(headers, csrfHeaders());

  let response: Response;
  try {
    response = await fetch(buildUrl(path, options.query), {
      method,
      headers,
      body: body ?? null,
      credentials: 'same-origin',
      signal: options.signal ?? null,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new ApiRequestError(0, 'SERVICE_UNAVAILABLE');
  }
  // Callers of 204 routes type the result as void or unknown.
  if (response.status === 204) return undefined as T;
  if (!response.ok) throw await errorOf(response);
  const payload: unknown = await response.json().catch(() => null);
  // The API validates its own responses' shape; the client trusts the contract.
  return payload as T;
}

/** i18n key describing an error for the user. */
export function errorMessageKey(error: unknown): string {
  if (error instanceof ApiRequestError) {
    return error.fields[0]?.messageKey ?? `errors.${error.code}`;
  }
  return 'errors.INTERNAL_ERROR';
}

/** URL of a file's raw content, usable in `src` and `href`. */
export function fileContentUrl(projectId: string, fileId: string): string {
  return `/api/projects/${projectId}/files/${fileId}/content`;
}
