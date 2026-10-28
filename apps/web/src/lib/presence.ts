import { type PresenceUser, presenceUser } from '@galley/shared';
import * as Y from 'yjs';

/** Someone else with the project open, and the file shown in their active tab. */
export interface Participant {
  user: PresenceUser;
  fileId: string | null;
}

/**
 * Participants of a project, one per user, from the awareness states of its
 * event channel. The local user is left out, including their other tabs;
 * malformed states are ignored. Sorted by name for a stable display.
 */
export function participantsOf(
  states: ReadonlyMap<number, Record<string, unknown>>,
  selfId: string | null,
): Participant[] {
  const byUser = new Map<string, Participant>();
  for (const state of states.values()) {
    const user = presenceUser.safeParse(state.user);
    if (!user.success || user.data.id === selfId) continue;
    const fileId = typeof state.fileId === 'string' ? state.fileId : null;
    const known = byUser.get(user.data.id);
    // A tab showing a file says more than one that shows none.
    if (known === undefined || (known.fileId === null && fileId !== null)) {
      byUser.set(user.data.id, { user: user.data, fileId });
    }
  }
  return [...byUser.values()].sort((a, b) => a.user.name.localeCompare(b.user.name));
}

/** One or two letters standing for a name on a presence badge. */
export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const first = words[0];
  if (first === undefined) return '';
  const last = words.length > 1 ? words.at(-1) : undefined;
  const letters =
    last === undefined
      ? graphemes(first).slice(0, 2).join('')
      : `${graphemes(first)[0] ?? ''}${graphemes(last)[0] ?? ''}`;
  return letters.toLocaleUpperCase();
}

/** User-perceived characters, so that accents and emoji stay whole. */
function graphemes(text: string): string[] {
  return Array.from(new Intl.Segmenter().segment(text), (part) => part.segment);
}

/**
 * Offset of a person's cursor in a shared text, from the awareness states of
 * the file's document (`y-codemirror.next` stores it as a relative position).
 * Null when the person has no cursor in this file.
 */
export function cursorOf(
  states: ReadonlyMap<number, Record<string, unknown>>,
  userId: string,
  text: Y.Text,
): number | null {
  const doc = text.doc;
  if (doc === null) return null;
  for (const state of states.values()) {
    const user = presenceUser.safeParse(state.user);
    if (!user.success || user.data.id !== userId) continue;
    const cursor = state.cursor;
    if (typeof cursor !== 'object' || cursor === null || !('head' in cursor)) continue;
    try {
      const relative = Y.createRelativePositionFromJSON(cursor.head);
      const absolute = Y.createAbsolutePositionFromRelativePosition(relative, doc);
      if (absolute?.type === text) return absolute.index;
    } catch {
      // A malformed position from another client: no cursor to follow.
    }
  }
  return null;
}
