import type { ImportWarning } from '@galley/shared';
import { create } from 'zustand';

interface NoticeState {
  /** Warnings of the last import or upload, per project, until dismissed. */
  warnings: Record<string, readonly ImportWarning[]>;
  setWarnings: (projectId: string, warnings: readonly ImportWarning[]) => void;
  dismiss: (projectId: string) => void;
}

export const useNotices = create<NoticeState>()((set) => ({
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
