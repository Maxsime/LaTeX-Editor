import { create } from 'zustand';
import type { ProjectConnection } from '../editor/connection.js';

/** A selection the user chose to comment, waiting for the comment's text. */
export interface PendingComment {
  fileId: string;
  from: number;
  to: number;
  quote: string;
}

interface ReviewState {
  /** Connection of the open project, shared by the editor and the review panel. */
  connection: ProjectConnection | null;
  setConnection: (connection: ProjectConnection | null) => void;
  /** Threads whose anchors are drawn: the open ones. */
  openThreads: ReadonlySet<string>;
  setOpenThreads: (ids: ReadonlySet<string>) => void;
  pending: PendingComment | null;
  setPending: (pending: PendingComment | null) => void;
  /** Bumped per file when its document was reloaded, so editors rebind. */
  reloads: Record<string, number>;
  noteReload: (fileId: string) => void;
  /** Set from the dashboard's mentions: the project opens on its review panel. */
  showReview: boolean;
  setShowReview: (show: boolean) => void;
  /** Personal choice of an editor to suggest rather than edit. */
  suggesting: boolean;
  setSuggesting: (suggesting: boolean) => void;
}

export const useReview = create<ReviewState>()((set) => ({
  connection: null,
  setConnection: (connection) => {
    set({ connection });
  },
  openThreads: new Set(),
  setOpenThreads: (openThreads) => {
    set({ openThreads });
  },
  pending: null,
  setPending: (pending) => {
    set({ pending });
  },
  reloads: {},
  noteReload: (fileId) => {
    set((state) => ({ reloads: { ...state.reloads, [fileId]: (state.reloads[fileId] ?? 0) + 1 } }));
  },
  showReview: false,
  setShowReview: (showReview) => {
    set({ showReview });
  },
  suggesting: false,
  setSuggesting: (suggesting) => {
    set({ suggesting });
  },
}));
