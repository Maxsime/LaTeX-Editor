import * as z from 'zod/mini';

/**
 * On-demand synchronisation of a project with a GitHub or GitLab repository
 * (SPEC §3.5): a branch pulled into the project, or the project pushed to it.
 */

/** Hosts offered when the administrator sets none. */
export const DEFAULT_SYNC_HOSTS = ['github.com', 'gitlab.com'] as const;

/**
 * A branch name Git accepts and that cannot be read as an option or a
 * revision expression; `git check-ref-format` has the last word on the server.
 */
export const remoteBranch = z
  .string()
  .check(
    z.regex(
      /^(?!-)(?!.*\.\.)(?!.*\/\/)(?!.*\.lock(?:\/|$))(?!.*[/.]$)[A-Za-z0-9._/-]{1,200}$/,
      'invalid branch name',
    ),
  );

export const setRemoteRequest = z.object({
  url: z.string().check(z.minLength(1), z.maxLength(500)),
  branch: remoteBranch,
  /** Required for a new remote; left out to keep the stored one. */
  token: z.optional(z.string().check(z.minLength(1), z.maxLength(500))),
});
export type SetRemoteRequest = z.infer<typeof setRemoteRequest>;

export const projectRemote = z.object({
  url: z.string(),
  branch: z.string(),
  tokenHint: z.string(),
  lastCommit: z.nullable(z.string()),
  lastSyncedAt: z.nullable(z.string()),
});
export type ProjectRemote = z.infer<typeof projectRemote>;

export const remoteResponse = z.object({
  remote: z.nullable(projectRemote),
  /** Hosts a remote may point to on this instance. */
  allowedHosts: z.array(z.string()),
  /** False when the instance has no master key: no token can be stored. */
  available: z.boolean(),
});
export type RemoteResponse = z.infer<typeof remoteResponse>;

/** Why pulled files cannot enter the project; mirrors the Git push refusals. */
export const remoteRefusal = z.enum([
  'symlink',
  'submodule',
  'invalidPath',
  'fileTooLarge',
  'tooLarge',
  'tooManyFiles',
  'quota',
]);
export type RemoteRefusal = z.infer<typeof remoteRefusal>;

export const pullResponse = z.union([
  z.object({ outcome: z.literal('upToDate') }),
  /** `merged` when the project had changes of its own, combined with the remote's. */
  z.object({ outcome: z.enum(['updated', 'merged']), commit: z.string() }),
  /** The same lines changed on both sides: nothing was applied. */
  z.object({ outcome: z.literal('conflict'), paths: z.array(z.string()) }),
  z.object({
    outcome: z.literal('refused'),
    reason: remoteRefusal,
    path: z.nullable(z.string()),
  }),
]);
export type PullResponse = z.infer<typeof pullResponse>;

export const pushResponse = z.object({
  outcome: z.enum(['upToDate', 'pushed']),
  commit: z.string(),
});
export type PushResponse = z.infer<typeof pushResponse>;

/**
 * Normalises a repository address and checks it against the instance's
 * policy: HTTPS (or HTTP when allowed, for a mirror on a trusted network), an
 * allowed host, no credentials, no query. Returns null when it is refused.
 */
export function normalizeRemoteUrl(
  input: string,
  allowedHosts: readonly string[],
  allowHttp = false,
): string | null {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && !(allowHttp && url.protocol === 'http:')) return null;
  if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') {
    return null;
  }
  if (!allowedHosts.map((host) => host.toLowerCase()).includes(url.host.toLowerCase())) {
    return null;
  }
  const path = url.pathname.replace(/\/+$/, '');
  // owner/repo, or group/subgroup/repo on GitLab; no dot segments.
  if (!/^(\/[A-Za-z0-9_.-]+){2,10}$/.test(path) || /\/\.\.?(\/|$)/.test(path)) return null;
  return `${url.protocol}//${url.host.toLowerCase()}${path}`;
}
