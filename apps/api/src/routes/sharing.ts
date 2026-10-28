import {
  projectInvites,
  projectLinks,
  projectMembers,
  projects,
  users,
  type Executor,
} from '@galley/db';
import {
  ApiError,
  createProjectInviteRequest,
  createShareLinkRequest,
  type CreatedShareLink,
  hasRole,
  type MembersResponse,
  type ProjectInvitesResponse,
  type ProjectRole,
  type ReceivedInvitesResponse,
  type ShareLink,
  type ShareLinkPreview,
  type ShareLinksResponse,
  shareLinkToken,
  transferOwnershipRequest,
  updateMemberRequest,
} from '@galley/shared';
import { and, asc, desc, eq, gt, isNull, or, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import * as z from 'zod/mini';
import { requireAuth } from '../auth/plugin.js';
import { publicOrigin } from '../auth/oidc.js';
import { randomToken, tokenDigest } from '../auth/tokens.js';
import type { AppContext } from '../context.js';
import { parse } from '../http/validate.js';
import { projectInviteMail } from '../mail/messages.js';
import { requireDocument } from '../projects/texmf.js';
import { loadProject } from '../projects/access.js';
import { publishProjectEvent } from '../projects/events.js';
import { projectParams } from './projects.js';

const memberParams = z.object({ id: z.uuid(), userId: z.uuid() });
const inviteParams = z.object({ id: z.uuid(), inviteId: z.uuid() });
const linkParams = z.object({ id: z.uuid(), linkId: z.uuid() });
const receivedInviteParams = z.object({ inviteId: z.uuid() });
const tokenParams = z.object({ token: shareLinkToken });

// Invitations reveal whether an account exists; the limit keeps that from becoming a lookup service.
const inviteRateLimit = { rateLimit: { max: 30, timeWindow: '1 hour' } };
// Link tokens are 256-bit, but a limit keeps a guessing attempt visible and cheap.
const linkRateLimit = { rateLimit: { max: 30, timeWindow: '1 minute' } };

function iso(date: Date | null): string | null {
  return date === null ? null : date.toISOString();
}

function toShareLink(row: typeof projectLinks.$inferSelect): ShareLink {
  return {
    id: row.id,
    role: row.role,
    expiresAt: iso(row.expiresAt),
    uses: row.uses,
    createdAt: row.createdAt.toISOString(),
  };
}

/** Role of a user in a project, or null when not a member. */
async function currentRole(
  db: Executor,
  projectId: string,
  userId: string,
): Promise<ProjectRole | null> {
  const [row] = await db
    .select({ role: projectMembers.role })
    .from(projectMembers)
    .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, userId)))
    .limit(1);
  return row?.role ?? null;
}

/**
 * Makes a user a member with `role`, or raises their role to it. A role is
 * never lowered this way: an editor who opens a reader link stays an editor.
 */
async function grantRole(
  db: Executor,
  projectId: string,
  userId: string,
  role: ProjectRole,
): Promise<boolean> {
  const existing = await currentRole(db, projectId, userId);
  if (existing !== null && hasRole(existing, role)) return false;
  await db
    .insert(projectMembers)
    .values({ projectId, userId, role })
    .onConflictDoUpdate({
      target: [projectMembers.projectId, projectMembers.userId],
      set: { role },
    });
  return true;
}

/** A share link usable now, with its project, or LINK_INVALID. */
async function usableLink(db: Executor, token: string) {
  const [row] = await db
    .select({ link: projectLinks, project: projects })
    .from(projectLinks)
    .innerJoin(projects, eq(projects.id, projectLinks.projectId))
    .where(
      and(
        eq(projectLinks.tokenHash, tokenDigest(token)),
        isNull(projectLinks.revokedAt),
        isNull(projects.deletedAt),
        or(isNull(projectLinks.expiresAt), gt(projectLinks.expiresAt, new Date())),
      ),
    )
    .limit(1);
  if (!row) throw new ApiError('LINK_INVALID');
  return row;
}

/**
 * Sharing of a project (SPEC §3.4): members and their roles, invitations of
 * existing accounts, revocable share links, transfer of ownership. Only the
 * owner changes who has access; every member can see who else does.
 */
export function sharingRoutes(app: FastifyInstance, context: AppContext): void {
  const { database, redis } = context;
  const { db } = database;

  app.get('/api/projects/:id/members', async (request): Promise<MembersResponse> => {
    const auth = requireAuth(request);
    const { id } = parse(projectParams, request.params);
    const { role } = await loadProject(db, id, auth.user.id, 'reader');
    const rows = await db
      .select({
        userId: users.id,
        username: users.username,
        displayName: users.displayName,
        email: users.email,
        role: projectMembers.role,
      })
      .from(projectMembers)
      .innerJoin(users, eq(users.id, projectMembers.userId))
      .where(eq(projectMembers.projectId, id))
      .orderBy(
        sql`case ${projectMembers.role} when 'owner' then 0 when 'editor' then 1 when 'reviewer' then 2 else 3 end`,
        asc(users.displayName),
      );
    return {
      members: rows.map((row) => ({ ...row, email: role === 'owner' ? row.email : null })),
    };
  });

  app.patch('/api/projects/:id/members/:userId', async (request, reply) => {
    const auth = requireAuth(request);
    const { id, userId } = parse(memberParams, request.params);
    const body = parse(updateMemberRequest, request.body);
    await loadProject(db, id, auth.user.id, 'owner');
    // The owner's own role only changes by transferring ownership.
    if (userId === auth.user.id) throw new ApiError('BAD_REQUEST', 'use a transfer');
    const updated = await db
      .update(projectMembers)
      .set({ role: body.role })
      .where(and(eq(projectMembers.projectId, id), eq(projectMembers.userId, userId)))
      .returning({ userId: projectMembers.userId });
    if (updated.length === 0) throw new ApiError('NOT_FOUND');
    await publishProjectEvent(redis, id, { type: 'members.changed', userId });
    return reply.status(204).send();
  });

  app.delete('/api/projects/:id/members/:userId', async (request, reply) => {
    const auth = requireAuth(request);
    const { id, userId } = parse(memberParams, request.params);
    const leaving = userId === auth.user.id;
    const { role } = await loadProject(db, id, auth.user.id, leaving ? 'reader' : 'owner');
    if (leaving && role === 'owner') throw new ApiError('OWNER_CANNOT_LEAVE');
    const removed = await db
      .delete(projectMembers)
      .where(and(eq(projectMembers.projectId, id), eq(projectMembers.userId, userId)))
      .returning({ userId: projectMembers.userId });
    if (removed.length === 0) throw new ApiError('NOT_FOUND');
    await publishProjectEvent(redis, id, { type: 'members.changed', userId });
    return reply.status(204).send();
  });

  app.post('/api/projects/:id/transfer', async (request, reply) => {
    const auth = requireAuth(request);
    const { id } = parse(projectParams, request.params);
    const { userId } = parse(transferOwnershipRequest, request.body);
    requireDocument((await loadProject(db, id, auth.user.id, 'owner')).project);
    if (userId === auth.user.id) throw new ApiError('BAD_REQUEST', 'already the owner');
    await db.transaction(async (tx) => {
      const promoted = await tx
        .update(projectMembers)
        .set({ role: 'owner' })
        .where(and(eq(projectMembers.projectId, id), eq(projectMembers.userId, userId)))
        .returning({ userId: projectMembers.userId });
      if (promoted.length === 0) throw new ApiError('NOT_FOUND');
      await tx
        .update(projectMembers)
        .set({ role: 'editor' })
        .where(and(eq(projectMembers.projectId, id), eq(projectMembers.userId, auth.user.id)));
      await tx.update(projects).set({ ownerId: userId }).where(eq(projects.id, id));
    });
    // Both members' rights changed; the event names the former owner, who lost the most.
    await publishProjectEvent(redis, id, { type: 'members.changed', userId: auth.user.id });
    await publishProjectEvent(redis, id, { type: 'project.updated' });
    return reply.status(204).send();
  });

  app.get('/api/projects/:id/invites', async (request): Promise<ProjectInvitesResponse> => {
    const auth = requireAuth(request);
    const { id } = parse(projectParams, request.params);
    await loadProject(db, id, auth.user.id, 'owner');
    const rows = await db
      .select({ invite: projectInvites, user: users })
      .from(projectInvites)
      .innerJoin(users, eq(users.id, projectInvites.userId))
      .where(and(eq(projectInvites.projectId, id), isNull(projectInvites.closedAt)))
      .orderBy(desc(projectInvites.createdAt));
    return {
      invites: rows.map(({ invite, user }) => ({
        id: invite.id,
        user: { id: user.id, username: user.username, displayName: user.displayName },
        role: invite.role,
        createdAt: invite.createdAt.toISOString(),
      })),
    };
  });

  app.post('/api/projects/:id/invites', { config: inviteRateLimit }, async (request, reply) => {
    const auth = requireAuth(request);
    const { id } = parse(projectParams, request.params);
    const body = parse(createProjectInviteRequest, request.body);
    const { project } = await loadProject(db, id, auth.user.id, 'owner');
    requireDocument(project);
    const identifier = body.identifier.trim();
    const [user] = await db
      .select({ id: users.id, email: users.email })
      .from(users)
      .where(
        and(
          identifier.includes('@') ? eq(users.email, identifier) : eq(users.username, identifier),
          isNull(users.disabledAt),
        ),
      )
      .limit(1);
    if (!user) throw new ApiError('USER_NOT_FOUND');
    if ((await currentRole(db, id, user.id)) !== null) throw new ApiError('ALREADY_MEMBER');
    // A new invitation replaces a pending one, so the owner can change the offered role.
    const invite = await db.transaction(async (tx) => {
      await tx
        .update(projectInvites)
        .set({ closedAt: new Date() })
        .where(
          and(
            eq(projectInvites.projectId, id),
            eq(projectInvites.userId, user.id),
            isNull(projectInvites.closedAt),
          ),
        );
      const [row] = await tx
        .insert(projectInvites)
        .values({ projectId: id, userId: user.id, role: body.role, invitedBy: auth.user.id })
        .returning();
      return row;
    });
    if (!invite) throw new ApiError('INTERNAL_ERROR');
    await publishProjectEvent(redis, id, { type: 'members.changed', userId: null });
    if (context.mailer) {
      // The invitation stands even if the message cannot be queued: it shows on the dashboard.
      await context.mailer
        .send(
          projectInviteMail({
            to: user.email,
            inviter: auth.user.displayName,
            project: project.name,
            role: body.role,
            link: `${publicOrigin(context.config)}/projects`,
          }),
        )
        .catch((error: unknown) => {
          request.log.warn({ err: error, inviteId: invite.id }, 'invitation e-mail not queued');
        });
    }
    return reply.status(201).send({ id: invite.id });
  });

  app.delete('/api/projects/:id/invites/:inviteId', async (request, reply) => {
    const auth = requireAuth(request);
    const { id, inviteId } = parse(inviteParams, request.params);
    await loadProject(db, id, auth.user.id, 'owner');
    const closed = await db
      .update(projectInvites)
      .set({ closedAt: new Date() })
      .where(
        and(
          eq(projectInvites.id, inviteId),
          eq(projectInvites.projectId, id),
          isNull(projectInvites.closedAt),
        ),
      )
      .returning({ id: projectInvites.id });
    if (closed.length === 0) throw new ApiError('NOT_FOUND');
    await publishProjectEvent(redis, id, { type: 'members.changed', userId: null });
    return reply.status(204).send();
  });

  app.get('/api/invites', async (request): Promise<ReceivedInvitesResponse> => {
    const auth = requireAuth(request);
    const inviter = sql<
      string | null
    >`(select ${users.displayName} from ${users} where ${users.id} = ${projectInvites.invitedBy})`;
    const rows = await db
      .select({ invite: projectInvites, project: projects, inviter })
      .from(projectInvites)
      .innerJoin(projects, eq(projects.id, projectInvites.projectId))
      .where(
        and(
          eq(projectInvites.userId, auth.user.id),
          isNull(projectInvites.closedAt),
          isNull(projects.deletedAt),
        ),
      )
      .orderBy(desc(projectInvites.createdAt));
    return {
      invites: rows.map(({ invite, project, inviter: name }) => ({
        id: invite.id,
        project: { id: project.id, name: project.name },
        invitedBy: name === null ? null : { displayName: name },
        role: invite.role,
        createdAt: invite.createdAt.toISOString(),
      })),
    };
  });

  /** Closes one of the user's pending invitations; returns it, or NOT_FOUND. */
  async function closeOwnInvite(executor: Executor, inviteId: string, userId: string) {
    const [invite] = await executor
      .update(projectInvites)
      .set({ closedAt: new Date() })
      .where(
        and(
          eq(projectInvites.id, inviteId),
          eq(projectInvites.userId, userId),
          isNull(projectInvites.closedAt),
        ),
      )
      .returning();
    if (!invite) throw new ApiError('NOT_FOUND');
    return invite;
  }

  app.post('/api/invites/:inviteId/accept', async (request) => {
    const auth = requireAuth(request);
    const { inviteId } = parse(receivedInviteParams, request.params);
    const projectId = await db.transaction(async (tx) => {
      const invite = await closeOwnInvite(tx, inviteId, auth.user.id);
      const [project] = await tx
        .select({ deletedAt: projects.deletedAt })
        .from(projects)
        .where(eq(projects.id, invite.projectId));
      if (project?.deletedAt !== null) throw new ApiError('NOT_FOUND');
      await grantRole(tx, invite.projectId, auth.user.id, invite.role);
      return invite.projectId;
    });
    await publishProjectEvent(redis, projectId, { type: 'members.changed', userId: null });
    return { projectId };
  });

  app.post('/api/invites/:inviteId/decline', async (request, reply) => {
    const auth = requireAuth(request);
    const { inviteId } = parse(receivedInviteParams, request.params);
    const invite = await closeOwnInvite(db, inviteId, auth.user.id);
    await publishProjectEvent(redis, invite.projectId, { type: 'members.changed', userId: null });
    return reply.status(204).send();
  });

  app.get('/api/projects/:id/links', async (request): Promise<ShareLinksResponse> => {
    const auth = requireAuth(request);
    const { id } = parse(projectParams, request.params);
    await loadProject(db, id, auth.user.id, 'owner');
    const rows = await db
      .select()
      .from(projectLinks)
      .where(
        and(
          eq(projectLinks.projectId, id),
          isNull(projectLinks.revokedAt),
          or(isNull(projectLinks.expiresAt), gt(projectLinks.expiresAt, new Date())),
        ),
      )
      .orderBy(desc(projectLinks.createdAt));
    return { links: rows.map(toShareLink) };
  });

  app.post('/api/projects/:id/links', async (request, reply) => {
    const auth = requireAuth(request);
    const { id } = parse(projectParams, request.params);
    const body = parse(createShareLinkRequest, request.body);
    requireDocument((await loadProject(db, id, auth.user.id, 'owner')).project);
    const token = randomToken();
    const [row] = await db
      .insert(projectLinks)
      .values({
        projectId: id,
        tokenHash: tokenDigest(token),
        role: body.role,
        createdBy: auth.user.id,
        expiresAt:
          body.expiresInDays === undefined
            ? null
            : new Date(Date.now() + body.expiresInDays * 24 * 3600 * 1000),
      })
      .returning();
    if (!row) throw new ApiError('INTERNAL_ERROR');
    const created: CreatedShareLink = { link: toShareLink(row), token };
    return reply.status(201).send(created);
  });

  app.delete('/api/projects/:id/links/:linkId', async (request, reply) => {
    const auth = requireAuth(request);
    const { id, linkId } = parse(linkParams, request.params);
    await loadProject(db, id, auth.user.id, 'owner');
    const revoked = await db
      .update(projectLinks)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(projectLinks.id, linkId),
          eq(projectLinks.projectId, id),
          isNull(projectLinks.revokedAt),
        ),
      )
      .returning({ id: projectLinks.id });
    if (revoked.length === 0) throw new ApiError('NOT_FOUND');
    return reply.status(204).send();
  });

  app.get(
    '/api/links/:token',
    { config: linkRateLimit },
    async (request): Promise<ShareLinkPreview> => {
      const auth = requireAuth(request);
      const { token } = parse(tokenParams, request.params);
      const { link, project } = await usableLink(db, token);
      return {
        project: { id: project.id, name: project.name },
        role: link.role,
        currentRole: await currentRole(db, project.id, auth.user.id),
      };
    },
  );

  app.post('/api/links/:token/join', { config: linkRateLimit }, async (request) => {
    const auth = requireAuth(request);
    const { token } = parse(tokenParams, request.params);
    const projectId = await db.transaction(async (tx) => {
      const { link, project } = await usableLink(tx, token);
      if (await grantRole(tx, project.id, auth.user.id, link.role)) {
        await tx
          .update(projectLinks)
          .set({ uses: sql`${projectLinks.uses} + 1` })
          .where(eq(projectLinks.id, link.id));
      }
      return project.id;
    });
    await publishProjectEvent(redis, projectId, { type: 'members.changed', userId: null });
    return { projectId };
  });
}
