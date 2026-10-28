import { ApiError, type PullResponse, type PushResponse } from '@galley/shared';
import type { FastifyBaseLogger } from 'fastify';
import type { AppContext } from '../context.js';
import { withLock } from '../locks.js';
import { materializeProject } from '../materialize.js';
import { commitCurrentState, gitLockKey } from './commit.js';
import { importTree, type PushLimits, PushRefused } from './push.js';
import { ensureRepository, MAIN_REF, SYNC_REF } from './repository.js';
import { git, GitError, gitWithStatus } from './run.js';
import { repositoryRow, saveRepositoryRow } from './state.js';

/** A repository and branch to synchronise with, and the token that opens it. */
export interface RemoteTarget {
  url: string;
  branch: string;
  token: string;
}

/** Longest fetch or push; a thesis repository takes seconds. */
const NETWORK_TIMEOUT_MS = 120_000;
/** The repository lock outlives the slowest network command. */
const SYNC_LOCK_MS = 2 * NETWORK_TIMEOUT_MS + 60_000;

/**
 * Hands the token to Git from the environment, at Git's request: it never
 * appears in a URL, a command line, a configuration file or the logs. GitHub
 * and GitLab both accept `oauth2` as the user name of an access token.
 */
const CREDENTIAL_HELPER =
  '!f() { test "$1" = get && printf "username=oauth2\\npassword=%s\\n" "$GALLEY_REMOTE_TOKEN"; }; f';

const SERVER_IDENTITY = {
  GIT_AUTHOR_NAME: 'Galley',
  GIT_AUTHOR_EMAIL: 'galley@galley.invalid',
  GIT_COMMITTER_NAME: 'Galley',
  GIT_COMMITTER_EMAIL: 'galley@galley.invalid',
};

/** Options of every command that talks to a remote. */
function remoteOptions(allowHttp: boolean): string[] {
  return [
    // An empty value first drops any helper Git would otherwise inherit.
    '-c',
    'credential.helper=',
    '-c',
    `credential.helper=${CREDENTIAL_HELPER}`,
    '-c',
    'credential.interactive=false',
    '-c',
    'core.askPass=',
    // Only the transport the address was checked for; no redirect to another host.
    '-c',
    'protocol.allow=never',
    '-c',
    'protocol.https.allow=always',
    ...(allowHttp ? ['-c', 'protocol.http.allow=always'] : []),
    '-c',
    'http.followRedirects=false',
  ];
}

/** Maps a failed network command to the error the user sees. */
function remoteError(error: unknown, logger: FastifyBaseLogger, projectId: string): ApiError {
  if (!(error instanceof GitError)) return new ApiError('REMOTE_UNREACHABLE');
  const message = error.stderr;
  // Git's own messages, which name the remote but never the token.
  logger.warn({ projectId, reason: message.slice(0, 300) }, 'remote repository refused');
  if (/couldn't find remote ref/i.test(message)) return new ApiError('REMOTE_BRANCH_NOT_FOUND');
  if (
    /authentication failed|could not read (username|password)|invalid username or password|repository not found|terminal prompts disabled|\b40[13]\b/i.test(
      message,
    )
  ) {
    return new ApiError('REMOTE_AUTH_FAILED');
  }
  if (/non-fast-forward|fetch first|\[rejected\]/i.test(message)) {
    return new ApiError('REMOTE_AHEAD');
  }
  if (
    /protected branch|pre-receive hook declined|permission|denied|remote rejected/i.test(message)
  ) {
    return new ApiError('REMOTE_REJECTED');
  }
  return new ApiError('REMOTE_UNREACHABLE');
}

async function isAncestor(gitDir: string, ancestor: string, descendant: string): Promise<boolean> {
  const { code } = await gitWithStatus(
    gitDir,
    ['merge-base', '--is-ancestor', ancestor, descendant],
    { allowExit: [1] },
  );
  return code === 0;
}

interface SyncContext {
  context: AppContext;
  projectId: string;
  gitDir: string;
  target: RemoteTarget;
  logger: FastifyBaseLogger;
}

/**
 * Fetches the remote branch into {@link SYNC_REF}, its whole history so that
 * merges find their base. The pack is bounded like a push (`GIT_MAX_PUSH_MB`).
 *
 * @returns the remote commit, or null when the branch does not exist.
 */
async function fetchRemote(sync: SyncContext): Promise<string | null> {
  const { context, gitDir, target } = sync;
  const { config } = context;
  try {
    await git(
      gitDir,
      [
        ...remoteOptions(config.GIT_SYNC_ALLOW_HTTP),
        'fetch',
        '--quiet',
        '--no-tags',
        '--no-write-fetch-head',
        '--no-recurse-submodules',
        target.url,
        `+refs/heads/${target.branch}:${SYNC_REF}`,
      ],
      {
        env: { GALLEY_REMOTE_TOKEN: target.token },
        timeoutMs: NETWORK_TIMEOUT_MS,
        maxFileBytes: config.GIT_MAX_PUSH_MB * 1024 * 1024,
      },
    );
  } catch (error) {
    const refused = remoteError(error, sync.logger, sync.projectId);
    if (refused.code !== 'REMOTE_BRANCH_NOT_FOUND') throw refused;
    await git(gitDir, ['update-ref', '-d', SYNC_REF]).catch(() => undefined);
    return null;
  }
  return (await git(gitDir, ['rev-parse', '--verify', `${SYNC_REF}^{commit}`]))
    .toString('utf8')
    .trim();
}

/**
 * Pulls the remote branch into the project (SPEC §3.5). The project's
 * current state is committed first; then the remote commit is taken as it is
 * when the project has not changed since, or merged with it when both moved.
 * A merge with conflicting changes applies nothing and names the files. The
 * resulting tree goes through the checks of a Git push.
 */
export async function pullRemote(
  context: AppContext,
  input: {
    projectId: string;
    userId: string;
    target: RemoteTarget;
    limits: PushLimits;
    logger: FastifyBaseLogger;
  },
): Promise<{ response: PullResponse; remoteCommit: string }> {
  const { projectId, target } = input;
  const gitDir = await ensureRepository(context.config, projectId);
  const sync: SyncContext = { context, projectId, gitDir, target, logger: input.logger };
  return withLock(
    context.redis,
    gitLockKey(projectId),
    async () => {
      const remote = await fetchRemote(sync);
      if (remote === null) throw new ApiError('REMOTE_BRANCH_NOT_FOUND');
      const local = await commitCurrentState(context, projectId, gitDir);
      if (await isAncestor(gitDir, remote, local)) {
        return { response: { outcome: 'upToDate' }, remoteCommit: remote };
      }

      let commit = remote;
      let outcome: 'updated' | 'merged' = 'updated';
      if (!(await isAncestor(gitDir, local, remote))) {
        // A project that never synchronised shares no history with the remote:
        // files present on one side only are kept, the same path on both conflicts.
        const merged = await gitWithStatus(
          gitDir,
          [
            'merge-tree',
            '--write-tree',
            '--allow-unrelated-histories',
            '--name-only',
            '--no-messages',
            '-z',
            local,
            remote,
          ],
          { allowExit: [1] },
        );
        const [tree = '', ...paths] = merged.stdout.toString('utf8').split('\0');
        if (merged.code === 1) {
          const conflicted = [...new Set(paths.filter((path) => path !== ''))].sort();
          return { response: { outcome: 'conflict', paths: conflicted }, remoteCommit: remote };
        }
        commit = (
          await git(gitDir, ['commit-tree', tree, '-p', local, '-p', remote], {
            input: `Merge ${target.branch} of ${target.url}\n`,
            env: SERVER_IDENTITY,
          })
        )
          .toString('utf8')
          .trim();
        outcome = 'merged';
      }

      const row = await repositoryRow(context.database.db, projectId);
      if (!row) throw new Error('repository row missing after commit');
      const current = await materializeProject(context, projectId);
      let imported;
      try {
        imported = await importTree(context, {
          projectId,
          userId: input.userId,
          gitDir,
          commit,
          base: { row, current },
          limits: input.limits,
        });
      } catch (error) {
        if (!(error instanceof PushRefused)) throw error;
        const { refusal } = error;
        if (refusal.reason === 'onlyMain' || refusal.reason === 'fetchFirst') throw error;
        return {
          response: {
            outcome: 'refused',
            reason: refusal.reason,
            path: 'path' in refusal ? refusal.path : null,
          },
          remoteCommit: remote,
        };
      }
      await git(gitDir, ['update-ref', MAIN_REF, commit, local]);
      await saveRepositoryRow(
        context.database.db,
        projectId,
        commit,
        imported.manifest,
        imported.objects,
      );
      return { response: { outcome, commit }, remoteCommit: remote };
    },
    SYNC_LOCK_MS,
  );
}

/**
 * Pushes the project's current state to the remote branch, creating it if
 * needed. Refused when the remote has commits the project lacks: the person
 * pulls first, as with Git. Nothing is ever force-pushed.
 */
export async function pushRemote(
  context: AppContext,
  input: { projectId: string; target: RemoteTarget; logger: FastifyBaseLogger },
): Promise<PushResponse> {
  const { projectId, target } = input;
  const gitDir = await ensureRepository(context.config, projectId);
  const sync: SyncContext = { context, projectId, gitDir, target, logger: input.logger };
  return withLock(
    context.redis,
    gitLockKey(projectId),
    async () => {
      const remote = await fetchRemote(sync);
      const local = await commitCurrentState(context, projectId, gitDir);
      if (remote === local) return { outcome: 'upToDate', commit: local };
      if (remote !== null && !(await isAncestor(gitDir, remote, local))) {
        throw new ApiError('REMOTE_AHEAD');
      }
      try {
        await git(
          gitDir,
          [
            ...remoteOptions(context.config.GIT_SYNC_ALLOW_HTTP),
            'push',
            '--quiet',
            '--no-recurse-submodules',
            target.url,
            `${local}:refs/heads/${target.branch}`,
          ],
          { env: { GALLEY_REMOTE_TOKEN: target.token }, timeoutMs: NETWORK_TIMEOUT_MS },
        );
      } catch (error) {
        throw remoteError(error, input.logger, projectId);
      }
      await git(gitDir, ['update-ref', SYNC_REF, local]);
      return { outcome: 'pushed', commit: local };
    },
    SYNC_LOCK_MS,
  );
}
