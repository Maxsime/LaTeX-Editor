/** Name of the violated unique constraint, if `error` is a PostgreSQL unique violation. */
export function uniqueViolation(error: unknown): string | null {
  // Drizzle wraps driver errors; the PostgreSQL error is the cause.
  const candidates = [error, error instanceof Error ? error.cause : undefined];
  for (const candidate of candidates) {
    if (
      typeof candidate === 'object' &&
      candidate !== null &&
      'code' in candidate &&
      candidate.code === '23505'
    ) {
      return 'constraint_name' in candidate && typeof candidate.constraint_name === 'string'
        ? candidate.constraint_name
        : 'unknown';
    }
  }
  return null;
}
