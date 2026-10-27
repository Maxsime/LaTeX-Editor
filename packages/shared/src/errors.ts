import * as z from 'zod/mini';

/**
 * Stable machine-readable error codes. Clients map them to translated messages;
 * renaming a code is a breaking API change.
 */
export const errorCodes = [
  'BAD_REQUEST',
  'VALIDATION_FAILED',
  'INVALID_PATTERN',
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'NOT_FOUND',
  'CONFLICT',
  'NO_MAIN_FILE',
  'PAYLOAD_TOO_LARGE',
  'RATE_LIMITED',
  'SERVICE_UNAVAILABLE',
  'INTERNAL_ERROR',
] as const;
export const errorCode = z.enum(errorCodes);
export type ErrorCode = z.infer<typeof errorCode>;

/** Body of every non-2xx API response. */
export const apiErrorBody = z.object({
  error: z.object({
    code: errorCode,
    /** i18n key resolved by the client, e.g. `errors.NOT_FOUND`. */
    messageKey: z.string(),
    requestId: z.optional(z.string()),
    /** Field-level validation issues, only for `VALIDATION_FAILED`. */
    fields: z.optional(z.array(z.object({ path: z.string(), messageKey: z.string() }))),
  }),
});
export type ApiErrorBody = z.infer<typeof apiErrorBody>;

const statusByCode: Record<ErrorCode, number> = {
  BAD_REQUEST: 400,
  VALIDATION_FAILED: 400,
  INVALID_PATTERN: 400,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  NO_MAIN_FILE: 422,
  PAYLOAD_TOO_LARGE: 413,
  RATE_LIMITED: 429,
  SERVICE_UNAVAILABLE: 503,
  INTERNAL_ERROR: 500,
};

/** HTTP status associated with an error code. */
export function httpStatusFor(code: ErrorCode): number {
  return statusByCode[code];
}

/** Error thrown by API handlers; serialised to {@link ApiErrorBody} by the error handler. */
export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly statusCode: number;

  constructor(code: ErrorCode, message?: string) {
    super(message ?? code);
    this.name = 'ApiError';
    this.code = code;
    this.statusCode = httpStatusFor(code);
  }
}
