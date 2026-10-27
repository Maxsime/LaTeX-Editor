import { type Executor, files, findSessionByToken, projectMembers, projects } from '@galley/db';
import { hasRole, parseDocumentName, type ProjectRole, SESSION_COOKIE } from '@galley/shared';
import { and, eq, isNull } from 'drizzle-orm';

/** What collab knows about a WebSocket connection once it is authorised. */
export interface CollabContext {
  userId: string;
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
 * member of are indistinguishable to the client. Readers and reviewers get a
 * read-only connection, enforced by Hocuspocus on every update they send.
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
  if (target.kind === 'file') {
    const [file] = await db
      .select({ projectId: files.projectId })
      .from(files)
      .where(and(eq(files.id, target.id), eq(files.kind, 'text')))
      .limit(1);
    if (!file) throw new AccessDenied('forbidden');
    projectId = file.projectId;
    fileId = target.id;
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
      displayName: session.user.displayName,
      projectId,
      role: member.role,
      fileId,
    },
    readOnly: !hasRole(member.role, 'editor'),
  };
}
