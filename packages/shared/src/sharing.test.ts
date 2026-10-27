import { describe, expect, it } from 'vitest';
import {
  createProjectInviteRequest,
  createShareLinkRequest,
  PRESENCE_COLORS,
  presenceColor,
  presenceUser,
  presenceUserOf,
  shareLinkToken,
  updateMemberRequest,
} from './sharing.js';

const id = '7c9e6679-7425-40de-944b-e07fc1f90ae7';

describe('presence', () => {
  it('gives a user the same palette colour everywhere', () => {
    expect(presenceColor(id)).toBe(presenceColor(id));
    expect(PRESENCE_COLORS).toContain(presenceColor(id));
    const colours = new Set(
      Array.from({ length: 50 }, (_, index) =>
        presenceColor(`00000000-0000-4000-8000-${String(index).padStart(12, '0')}`),
      ),
    );
    expect(colours.size).toBeGreaterThan(1);
  });

  it('builds a valid awareness identity with a translucent selection colour', () => {
    const user = presenceUserOf(id, 'Alice');
    expect(presenceUser.parse(user)).toEqual(user);
    expect(user.colorLight).toBe(`${user.color}33`);
  });
});

describe('sharing requests', () => {
  it('only shares with non-owner roles', () => {
    expect(updateMemberRequest.safeParse({ role: 'reader' }).success).toBe(true);
    expect(updateMemberRequest.safeParse({ role: 'owner' }).success).toBe(false);
    expect(createProjectInviteRequest.safeParse({ identifier: 'bob', role: 'owner' }).success).toBe(
      false,
    );
    expect(createProjectInviteRequest.safeParse({ identifier: '', role: 'editor' }).success).toBe(
      false,
    );
  });

  it('bounds the validity of share links', () => {
    expect(createShareLinkRequest.safeParse({ role: 'editor' }).success).toBe(true);
    expect(createShareLinkRequest.safeParse({ role: 'editor', expiresInDays: 30 }).success).toBe(
      true,
    );
    expect(createShareLinkRequest.safeParse({ role: 'editor', expiresInDays: 0 }).success).toBe(
      false,
    );
    expect(createShareLinkRequest.safeParse({ role: 'editor', expiresInDays: 366 }).success).toBe(
      false,
    );
  });

  it('accepts only well-formed link tokens', () => {
    expect(shareLinkToken.safeParse('a'.repeat(43)).success).toBe(true);
    expect(shareLinkToken.safeParse('a'.repeat(42)).success).toBe(false);
    expect(shareLinkToken.safeParse(`${'a'.repeat(42)}/`).success).toBe(false);
  });
});
