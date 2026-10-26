import type { ListProjectsQuery, ProjectState } from '@galley/shared';
import { create } from 'zustand';

type Sort = ListProjectsQuery['sort'];

interface DashboardState {
  state: ProjectState;
  search: string;
  sort: Sort;
  order: 'asc' | 'desc';
  tagId: string | null;
  selected: ReadonlySet<string>;
  setState: (state: ProjectState) => void;
  setSearch: (search: string) => void;
  setSort: (sort: Sort, order: 'asc' | 'desc') => void;
  setTag: (tagId: string | null) => void;
  toggle: (id: string) => void;
  selectAll: (ids: readonly string[]) => void;
  clearSelection: () => void;
}

/** Filters and selection of the project list; changing a filter clears the selection. */
export const useDashboard = create<DashboardState>()((set) => ({
  state: 'active',
  search: '',
  sort: 'updatedAt',
  order: 'desc',
  tagId: null,
  selected: new Set(),
  setState: (state) => {
    set({ state, selected: new Set() });
  },
  setSearch: (search) => {
    set({ search, selected: new Set() });
  },
  setSort: (sort, order) => {
    set({ sort, order });
  },
  setTag: (tagId) => {
    set({ tagId, selected: new Set() });
  },
  toggle: (id) => {
    set(({ selected }) => {
      const next = new Set(selected);
      if (!next.delete(id)) next.add(id);
      return { selected: next };
    });
  },
  selectAll: (ids) => {
    set({ selected: new Set(ids) });
  },
  clearSelection: () => {
    set({ selected: new Set() });
  },
}));
