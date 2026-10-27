import { create } from 'zustand';
import type { Participant } from '../lib/presence.js';

interface PresenceState {
  /** Other people with the open project in a tab. */
  participants: Participant[];
  setParticipants: (participants: Participant[]) => void;
}

export const usePresence = create<PresenceState>()((set) => ({
  participants: [],
  setParticipants: (participants) => {
    set({ participants });
  },
}));
