import * as z from 'zod/mini';
import { projectRole } from './projects.js';

/** Roles a project can be shared with; ownership only moves by transfer. */
export const sharedRole = z.enum(['editor', 'reviewer', 'reader']);
export type SharedRole = z.infer<typeof sharedRole>;

/** A member as other members see them; `email` only reaches the owner. */
export const projectMember = z.object({
  userId: z.uuid(),
  username: z.string(),
  displayName: z.string(),
  email: z.nullable(z.string()),
  role: projectRole,
});
export type ProjectMember = z.infer<typeof projectMember>;

export const membersResponse = z.object({ members: z.array(projectMember) });
export type MembersResponse = z.infer<typeof membersResponse>;

export const updateMemberRequest = z.object({ role: sharedRole });

export const transferOwnershipRequest = z.object({ userId: z.uuid() });

/** Body of `POST /api/projects/:id/invites`: an e-mail address or a username. */
export const createProjectInviteRequest = z.object({
  identifier: z.string().check(z.minLength(1), z.maxLength(320)),
  role: sharedRole,
});

/** A pending invitation, as its project's owner sees it. */
export const projectInvite = z.object({
  id: z.uuid(),
  user: z.object({ id: z.uuid(), username: z.string(), displayName: z.string() }),
  role: projectRole,
  createdAt: z.string(),
});
export type ProjectInvite = z.infer<typeof projectInvite>;

export const projectInvitesResponse = z.object({ invites: z.array(projectInvite) });
export type ProjectInvitesResponse = z.infer<typeof projectInvitesResponse>;

/** A pending invitation, as the invited user sees it on their dashboard. */
export const receivedInvite = z.object({
  id: z.uuid(),
  project: z.object({ id: z.uuid(), name: z.string() }),
  invitedBy: z.nullable(z.object({ displayName: z.string() })),
  role: projectRole,
  createdAt: z.string(),
});
export type ReceivedInvite = z.infer<typeof receivedInvite>;

export const receivedInvitesResponse = z.object({ invites: z.array(receivedInvite) });
export type ReceivedInvitesResponse = z.infer<typeof receivedInvitesResponse>;

/** Days a share link may stay valid; none means until revoked. */
export const shareLinkExpiryDays = z.optional(z.int().check(z.gte(1), z.lte(365)));

export const createShareLinkRequest = z.object({
  role: sharedRole,
  expiresInDays: shareLinkExpiryDays,
});

/** A share link as its project's owner sees it; the token is only shown once. */
export const shareLink = z.object({
  id: z.uuid(),
  role: projectRole,
  expiresAt: z.nullable(z.string()),
  uses: z.number(),
  createdAt: z.string(),
});
export type ShareLink = z.infer<typeof shareLink>;

export const shareLinksResponse = z.object({ links: z.array(shareLink) });
export type ShareLinksResponse = z.infer<typeof shareLinksResponse>;

/** Answer to the creation of a link: the only time its token leaves the server. */
export const createdShareLink = z.object({ link: shareLink, token: z.string() });
export type CreatedShareLink = z.infer<typeof createdShareLink>;

/** What a signed-in user sees before joining through a link. */
export const shareLinkPreview = z.object({
  project: z.object({ id: z.uuid(), name: z.string() }),
  role: projectRole,
  /** The visitor's current role, if already a member. */
  currentRole: z.nullable(projectRole),
});
export type ShareLinkPreview = z.infer<typeof shareLinkPreview>;

/** Share link tokens: 32 random bytes in base64url. */
export const shareLinkToken = z.string().check(z.regex(/^[A-Za-z0-9_-]{43}$/));

/**
 * Colour of a participant's cursor and badge, the same for a user in every
 * browser. Picked from a palette readable on light and dark backgrounds.
 */
export const PRESENCE_COLORS = [
  '#d1495b',
  '#00798c',
  '#c06c00',
  '#2e7d32',
  '#6a4c93',
  '#1565c0',
  '#ad1457',
  '#5d6d00',
] as const;

export function presenceColor(userId: string): string {
  let hash = 0;
  for (const char of userId) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return PRESENCE_COLORS[hash % PRESENCE_COLORS.length] ?? PRESENCE_COLORS[0];
}

/**
 * Awareness field identifying a participant. collab overwrites it with the
 * connection's own identity, so a client cannot pose as someone else.
 */
export const presenceUser = z.object({
  id: z.uuid(),
  name: z.string(),
  color: z.string(),
  /** Lighter colour for selections, as `y-codemirror.next` expects. */
  colorLight: z.string(),
});
export type PresenceUser = z.infer<typeof presenceUser>;

/** Builds the trusted awareness identity of a user. */
export function presenceUserOf(userId: string, displayName: string): PresenceUser {
  const color = presenceColor(userId);
  return { id: userId, name: displayName, color, colorLight: `${color}33` };
}
