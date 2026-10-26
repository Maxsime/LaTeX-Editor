import { ApiError, type ApiErrorBody, type ErrorCode, httpStatusFor } from '@galley/shared';
import type { FastifyError, FastifyInstance } from 'fastify';
import { ValidationError } from './http/validate.js';

function body(code: ErrorCode, requestId: string): ApiErrorBody {
  return { error: { code, messageKey: `errors.${code}`, requestId } };
}

function codeForStatus(status: number): ErrorCode {
  switch (status) {
    case 400:
      return 'BAD_REQUEST';
    case 401:
      return 'UNAUTHENTICATED';
    case 403:
      return 'FORBIDDEN';
    case 404:
      return 'NOT_FOUND';
    case 409:
      return 'CONFLICT';
    case 413:
      return 'PAYLOAD_TOO_LARGE';
    case 429:
      return 'RATE_LIMITED';
    default:
      return 'INTERNAL_ERROR';
  }
}

/**
 * Serialises every error as {@link ApiErrorBody}. Stack traces and driver
 * messages stay in the logs; clients only receive a stable code and an i18n key.
 */
export function registerErrorHandling(app: FastifyInstance): void {
  app.setErrorHandler((error: FastifyError, request, reply) => {
    if (error instanceof ValidationError) {
      return reply.status(error.statusCode).send({
        error: { ...body(error.code, request.id).error, fields: error.fields },
      });
    }
    if (error instanceof ApiError) {
      return reply.status(error.statusCode).send(body(error.code, request.id));
    }
    if (error.validation) {
      return reply.status(400).send(body('VALIDATION_FAILED', request.id));
    }
    const status = error.statusCode ?? 500;
    if (status >= 500) {
      request.log.error({ err: error }, 'unhandled error');
      return reply.status(500).send(body('INTERNAL_ERROR', request.id));
    }
    const code = codeForStatus(status);
    return reply.status(httpStatusFor(code)).send(body(code, request.id));
  });

  app.setNotFoundHandler((request, reply) => {
    return reply.status(404).send(body('NOT_FOUND', request.id));
  });
}
