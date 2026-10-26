import { ApiError } from '@galley/shared';
import type * as z from 'zod/mini';

/** Error raised when a request part fails its schema; carries per-field i18n keys. */
export class ValidationError extends ApiError {
  readonly fields: { path: string; messageKey: string }[];

  constructor(fields: { path: string; messageKey: string }[]) {
    super('VALIDATION_FAILED');
    this.fields = fields;
  }
}

/**
 * Parses an untrusted request part. Every route goes through this, so that no
 * handler ever reads a body, query or parameter that has not been validated.
 */
export function parse<Schema extends z.ZodMiniType>(
  schema: Schema,
  value: unknown,
): z.output<Schema> {
  const result = schema.safeParse(value);
  if (result.success) {
    return result.data;
  }
  throw new ValidationError(
    result.error.issues.map((issue) => ({
      path: issue.path.map(String).join('.'),
      messageKey: `validation.${issue.code}`,
    })),
  );
}
