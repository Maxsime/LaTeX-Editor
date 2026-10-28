import { create } from 'zustand';
import type { Participant } from '../lib/presence.js';

interface PresenceState {
  /** Other people with the open project in a tab. */
  participants: Participant[];
  setParticipants: (participants: Participant[]) => void;
  /** Person whose file and cursor this tab follows, until the reader acts. */
  following: string | null;
  setFollowing: (userId: string | null) => void;
}

export const usePresence = create<PresenceState>()((set) => ({
  participants: [],
  setParticipants: (participants) => {
    // Following ends when the person leaves the project.
    set(({ following }) => ({
      participants,
      following: participants.some(({ user }) => user.id === following) ? following : null,
    }));
  },
  following: null,
  setFollowing: (following) => {
    set({ following });
  },
}));
