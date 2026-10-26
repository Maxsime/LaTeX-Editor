import { create } from 'zustand';

interface TreeState {
  projectId: string | null;
  selectedId: string | null;
  expanded: ReadonlySet<string>;
  /** Resets the state when another project is opened. */
  open: (projectId: string) => void;
  select: (id: string | null) => void;
  toggleFolder: (id: string) => void;
  expand: (ids: readonly string[]) => void;
}

export const useTreeState = create<TreeState>()((set, get) => ({
  projectId: null,
  selectedId: null,
  expanded: new Set(),
  open: (projectId) => {
    if (get().projectId !== projectId) set({ projectId, selectedId: null, expanded: new Set() });
  },
  select: (selectedId) => {
    set({ selectedId });
  },
  toggleFolder: (id) => {
    set(({ expanded }) => {
      const next = new Set(expanded);
      if (!next.delete(id)) next.add(id);
      return { expanded: next };
    });
  },
  expand: (ids) => {
    set(({ expanded }) => ({ expanded: new Set([...expanded, ...ids]) }));
  },
}));
