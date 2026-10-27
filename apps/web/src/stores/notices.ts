import type { ImportWarning } from '@galley/shared';
import { create } from 'zustand';

/** One-off message shown on the dashboard after being sent back there. */
export type Flash = 'accessLost' | 'projectDeleted';

interface NoticeState {
  flash: Flash | null;
  setFlash: (flash: Flash | null) => void;
  /** Warnings of the last import or upload, per project, until dismissed. */
  warnings: Record<string, readonly ImportWarning[]>;
  setWarnings: (projectId: string, warnings: readonly ImportWarning[]) => void;
  dismiss: (projectId: string) => void;
}

export const useNotices = create<NoticeState>()((set) => ({
  flash: null,
  setFlash: (flash) => {
    set({ flash });
  },
  warnings: {},
  setWarnings: (projectId, warnings) => {
    set((state) => ({ warnings: { ...state.warnings, [projectId]: warnings } }));
  },
  dismiss: (projectId) => {
    set((state) => ({
      warnings: Object.fromEntries(
        Object.entries(state.warnings).filter(([id]) => id !== projectId),
      ),
    }));
  },
}));
