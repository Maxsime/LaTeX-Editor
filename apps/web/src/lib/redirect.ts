/**
 * Where to go after signing in: a path of this application only, so that a
 * crafted login link cannot send the user to another site.
 */
export function safeRedirect(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.startsWith('/')) return undefined;
  // "//host" and "/\host" are read by browsers as another origin.
  if (value.startsWith('//') || value.startsWith('/\\')) return undefined;
  return value;
}
