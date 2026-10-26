import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import type { SyncStatus } from '../editor/connection.js';

/** A place to show in the editor: a search result or an outline entry. */
export interface Reveal {
  fileId: string;
  /** 1-based line. */
  line: number;
  /** UTF-16 column of the selection start, 0 by default. */
  column?: number;
  length?: number;
  /** Distinguishes two reveals of the same place, so both take effect. */
  nonce: number;
}

interface EditorState {
  projectId: string | null;
  tabs: string[];
  activeId: string | null;
  status: Record<string, SyncStatus>;
  reveal: Reveal | null;
  /** Line of the cursor in the active tab, for the outline highlight. */
  cursorLine: number;
  /** Bumped on every local edit, to refresh the outline after a pause. */
  editCount: number;
  /** Resets tabs when another project is opened. */
  openProject: (projectId: string) => void;
  openTab: (fileId: string) => void;
  closeTab: (fileId: string) => void;
  /** Closes the tabs of files that no longer exist. */
  keepTabs: (existing: ReadonlySet<string>) => void;
  setStatus: (fileId: string, status: SyncStatus) => void;
  revealAt: (place: Omit<Reveal, 'nonce'>) => void;
  setCursorLine: (line: number) => void;
  noteEdit: () => void;
}

/** Tab after `fileId` (or before it at the end), the one shown when `fileId` closes. */
export function neighbourTab(tabs: readonly string[], fileId: string): string | null {
  const index = tabs.indexOf(fileId);
  if (index === -1) return null;
  return tabs[index + 1] ?? tabs[index - 1] ?? null;
}

export const useEditor = create<EditorState>()((set, get) => ({
  projectId: null,
  tabs: [],
  activeId: null,
  status: {},
  reveal: null,
  cursorLine: 1,
  editCount: 0,
  openProject: (projectId) => {
    if (get().projectId === projectId) return;
    set({ projectId, tabs: [], activeId: null, status: {}, reveal: null, cursorLine: 1 });
  },
  openTab: (fileId) => {
    set(({ tabs }) => ({
      tabs: tabs.includes(fileId) ? tabs : [...tabs, fileId],
      activeId: fileId,
    }));
  },
  closeTab: (fileId) => {
    set(({ tabs, activeId }) => ({
      tabs: tabs.filter((id) => id !== fileId),
      activeId: activeId === fileId ? neighbourTab(tabs, fileId) : activeId,
    }));
  },
  keepTabs: (existing) => {
    const { tabs, activeId } = get();
    const kept = tabs.filter((id) => existing.has(id));
    if (kept.length === tabs.length) return;
    const active = activeId !== null && existing.has(activeId) ? activeId : (kept[0] ?? null);
    set({ tabs: kept, activeId: active });
  },
  setStatus: (fileId, status) => {
    set((state) => ({ status: { ...state.status, [fileId]: status } }));
  },
  revealAt: (place) => {
    set(({ tabs }) => ({
      tabs: tabs.includes(place.fileId) ? tabs : [...tabs, place.fileId],
      activeId: place.fileId,
      reveal: { ...place, nonce: Date.now() + Math.random() },
    }));
  },
  setCursorLine: (cursorLine) => {
    if (get().cursorLine !== cursorLine) set({ cursorLine });
  },
  noteEdit: () => {
    set(({ editCount }) => ({ editCount: editCount + 1 }));
  },
}));

export type EditorTheme = 'light' | 'dark';

interface Preferences {
  theme: EditorTheme;
  fontSize: number;
  lineWrapping: boolean;
  setTheme: (theme: EditorTheme) => void;
  setFontSize: (size: number) => void;
  setLineWrapping: (on: boolean) => void;
}

export const FONT_SIZES = [11, 12, 13, 14, 15, 16, 18, 20] as const;

/** Editor preferences, kept in this browser only. */
export const usePreferences = create<Preferences>()(
  persist(
    (set) => ({
      theme: 'light',
      fontSize: 14,
      lineWrapping: true,
      setTheme: (theme) => {
        set({ theme });
      },
      setFontSize: (fontSize) => {
        set({ fontSize });
      },
      setLineWrapping: (lineWrapping) => {
        set({ lineWrapping });
      },
    }),
    {
      name: 'galley.editor.preferences',
      // Storage may be unavailable (private browsing); preferences then last for the session.
      storage: createJSONStorage(() => localStorage),
    },
  ),
);
