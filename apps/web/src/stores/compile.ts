import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

export type ViewMode = 'both' | 'editor' | 'pdf';

/** Delays offered for compiling after a typing pause, in milliseconds. */
export const AUTO_COMPILE_DELAYS = [1000, 2000, 3000, 5000] as const;

interface CompilePreferences {
  autoCompile: boolean;
  autoCompileDelay: number;
  viewMode: ViewMode;
  setAutoCompile: (on: boolean) => void;
  setAutoCompileDelay: (delay: number) => void;
  setViewMode: (mode: ViewMode) => void;
}

/** Compilation preferences, kept in this browser only. */
export const useCompilePreferences = create<CompilePreferences>()(
  persist(
    (set) => ({
      autoCompile: true,
      autoCompileDelay: 2000,
      viewMode: 'both',
      setAutoCompile: (autoCompile) => {
        set({ autoCompile });
      },
      setAutoCompileDelay: (autoCompileDelay) => {
        set({ autoCompileDelay });
      },
      setViewMode: (viewMode) => {
        set({ viewMode });
      },
    }),
    {
      name: 'galley.compile.preferences',
      storage: createJSONStorage(() => localStorage),
    },
  ),
);

interface CompileSession {
  draft: boolean;
  haltOnError: boolean;
  /** Resolves once the server acknowledged every local edit; set by the open editor. */
  waitForSaved: () => Promise<void>;
  setDraft: (on: boolean) => void;
  setHaltOnError: (on: boolean) => void;
  setWaitForSaved: (wait: () => Promise<void>) => void;
}

/** Options of the current session, reset on reload. */
export const useCompileStore = create<CompileSession>()((set) => ({
  draft: false,
  haltOnError: false,
  waitForSaved: () => Promise.resolve(),
  setDraft: (draft) => {
    set({ draft });
  },
  setHaltOnError: (haltOnError) => {
    set({ haltOnError });
  },
  setWaitForSaved: (waitForSaved) => {
    set({ waitForSaved });
  },
}));
