import {
  type Executor,
  files,
  findSessionByToken,
  projectMembers,
  projects,
  sessions,
  users,
} from '@galley/db';
import { hasRole, parseDocumentName, type ProjectRole, SESSION_COOKIE } from '@galley/shared';
import { and, eq, gt, inArray, isNull } from 'drizzle-orm';

/** What collab knows about a WebSocket connection once it is authorised. */
export interface CollabContext {
  userId: string;
  /** Session the connection was opened with; the socket closes once it is revoked. */
  sessionId: string;
  /** Shown to other participants; taken from the account, never from the client. */
  displayName: string;
  projectId: string;
  role: ProjectRole;
  /** `null` on the project event channel. */
  fileId: string | null;
}

/**
 * Refusal reported to the client. Hocuspocus forwards `reason` in its
 * permission-denied message, so it stays a stable code with no detail.
 */
export class AccessDenied extends Error {
  readonly reason: 'unauthenticated' | 'forbidden';

  constructor(reason: 'unauthenticated' | 'forbidden') {
    super(reason);
    this.name = 'AccessDenied';
    this.reason = reason;
  }
}

/** Reads one cookie from a `Cookie` header without a dependency on a full parser. */
export function readCookie(header: string | null, name: string): string | null {
  if (header === null) return null;
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(separator + 1).trim());
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Accepts a WebSocket upgrade only from a page of the same host. Browsers
 * attach cookies to cross-site WebSocket requests, so without this check any
 * site could open a document in the name of a signed-in visitor.
 */
export function originAllowed(origin: string | undefined, host: string | undefined): boolean {
  if (origin === undefined || host === undefined) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

/**
 * Authorises a connection to a document from the session cookie. A missing
 * document, a document of another project and a project the user is not a
 * member of are indistinguishable to the client. Readers get a read-only
 * connection, enforced by Hocuspocus on every update they send; reviewers may
 * write suggestions, each update checked by `checkReviewerUpdate`. Linked
 * files and the project channel are read-only for everyone.
 */
export async function authorize(
  db: Executor,
  cookieHeader: string | null,
  documentName: string,
): Promise<{ context: CollabContext; readOnly: boolean }> {
  const token = readCookie(cookieHeader, SESSION_COOKIE);
  if (token === null) throw new AccessDenied('unauthenticated');
  const session = await findSessionByToken(db, token);
  if (session === null) throw new AccessDenied('unauthenticated');

  const target = parseDocumentName(documentName);
  if (target === null) throw new AccessDenied('forbidden');

  let projectId = target.id;
  let fileId: string | null = null;
  let linked = false;
  if (target.kind === 'file') {
    const [file] = await db
      .select({ projectId: files.projectId, link: files.link })
      .from(files)
      .where(and(eq(files.id, target.id), eq(files.kind, 'text')))
      .limit(1);
    if (!file) throw new AccessDenied('forbidden');
    projectId = file.projectId;
    fileId = target.id;
    linked = file.link !== null;
  }

  const [member] = await db
    .select({ role: projectMembers.role })
    .from(projectMembers)
    .innerJoin(projects, eq(projects.id, projectMembers.projectId))
    .where(
      and(
        eq(projectMembers.projectId, projectId),
        eq(projectMembers.userId, session.user.id),
        isNull(projects.deletedAt),
      ),
    )
    .limit(1);
  if (!member) throw new AccessDenied('forbidden');

  return {
    context: {
      userId: session.user.id,
      sessionId: session.sessionId,
      displayName: session.user.displayName,
      projectId,
      role: member.role,
      fileId,
    },
    // A linked file changes only when refreshed from its source, through the API.
    // The project channel carries events and presence, never document changes:
    // writable, it would be shared memory any member could fill for everyone.
    readOnly: target.kind === 'project' || linked || !hasRole(member.role, 'reviewer'),
  };
}

/**
 * Returns which of `sessionIds` are still valid: not deleted (sign-out,
 * password reset, account disabled by an administrator) and not expired, for
 * an account that is still enabled. A WebSocket outlives the request that
 * opened it, so collab asks this periodically to close revoked connections.
 */
export async function liveSessions(
  db: Executor,
  sessionIds: readonly string[],
  now = new Date(),
): Promise<Set<string>> {
  if (sessionIds.length === 0) return new Set();
  const rows = await db
    .select({ id: sessions.id })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(
      and(
        inArray(sessions.id, [...sessionIds]),
        gt(sessions.expiresAt, now),
        isNull(users.disabledAt),
      ),
    );
  return new Set(rows.map((row) => row.id));
}
