import type { TreeNode } from '@galley/shared';
import { ContextMenu, DropdownMenu } from 'radix-ui';
import { type DragEvent, type KeyboardEvent, type ReactNode, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { canDrop, moveTargets, type TreeItem, visibleItems } from '../lib/tree.js';
import { fromDataTransfer, type PendingUpload } from '../lib/upload.js';
import { useTreeState } from '../stores/tree.js';
import { ConfirmDialog, Dialog, ErrorAlert, NameDialog } from './ui.js';

const NODE_TYPE = 'application/x-galley-node';

export interface TreeActions {
  rename: (id: string, name: string) => Promise<unknown>;
  move: (id: string, parentId: string | null) => Promise<unknown>;
  remove: (id: string) => Promise<unknown>;
  createFolder: (parentId: string | null, name: string) => Promise<unknown>;
  upload: (parentId: string | null, uploads: PendingUpload[]) => void;
}

type Pending =
  | { kind: 'rename' | 'move' | 'delete'; item: TreeItem }
  | { kind: 'folder'; parentId: string | null };

const menuItem =
  'cursor-pointer rounded px-2 py-1 text-sm outline-none data-[highlighted]:bg-slate-100';

function ItemMenu({
  item,
  open,
  Menu,
}: {
  item: TreeItem;
  open: (pending: Pending) => void;
  Menu: typeof DropdownMenu | typeof ContextMenu;
}) {
  const { t } = useTranslation();
  return (
    <>
      {item.kind === 'folder' && (
        <Menu.Item
          className={menuItem}
          onSelect={() => {
            open({ kind: 'folder', parentId: item.id });
          }}
        >
          {t('project.newFolder')}
        </Menu.Item>
      )}
      <Menu.Item
        className={menuItem}
        onSelect={() => {
          open({ kind: 'rename', item });
        }}
      >
        {t('project.rename')}
      </Menu.Item>
      <Menu.Item
        className={menuItem}
        onSelect={() => {
          open({ kind: 'move', item });
        }}
      >
        {t('project.move')}
      </Menu.Item>
      <Menu.Item
        className={`${menuItem} text-red-700`}
        onSelect={() => {
          open({ kind: 'delete', item });
        }}
      >
        {t('project.delete')}
      </Menu.Item>
    </>
  );
}

/**
 * Project file tree: keyboard navigation (WAI-ARIA tree pattern), context and
 * row menus, drag and drop to move nodes or to upload files from the system.
 */
export function FileTree({
  nodes,
  roots,
  mainFileId,
  actions,
  error,
  toolbar,
}: {
  nodes: readonly TreeNode[];
  roots: TreeItem[];
  mainFileId: string | null;
  actions: TreeActions;
  error: ReactNode;
  toolbar: (openFolderDialog: () => void) => ReactNode;
}) {
  const { t } = useTranslation();
  const { selectedId, expanded, select, toggleFolder, expand } = useTreeState();
  const [pending, setPending] = useState<Pending | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<unknown>(null);
  const items = visibleItems(roots, expanded);

  const close = (): void => {
    setPending(null);
    setActionError(null);
  };
  const perform = (work: Promise<unknown>): void => {
    setBusy(true);
    work.then(close, setActionError).finally(() => {
      setBusy(false);
    });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLUListElement>): void => {
    const index = items.findIndex((item) => item.id === selectedId);
    const current = items[index];
    const go = (next: TreeItem | undefined): void => {
      if (!next) return;
      event.preventDefault();
      select(next.id);
      document.getElementById(`node-${next.id}`)?.focus();
    };
    switch (event.key) {
      case 'ArrowDown':
        go(items[index + 1] ?? items[0]);
        break;
      case 'ArrowUp':
        go(items[Math.max(index - 1, 0)]);
        break;
      case 'ArrowRight':
        if (current?.kind === 'folder') {
          event.preventDefault();
          if (!expanded.has(current.id)) toggleFolder(current.id);
          else go(current.children[0]);
        }
        break;
      case 'ArrowLeft':
        if (current?.kind === 'folder' && expanded.has(current.id)) {
          event.preventDefault();
          toggleFolder(current.id);
        } else if (current?.parentId) {
          go(items.find((item) => item.id === current.parentId));
        }
        break;
      case 'F2':
        if (current) setPending({ kind: 'rename', item: current });
        break;
      case 'Delete':
        if (current) setPending({ kind: 'delete', item: current });
        break;
    }
  };

  const dropProps = (targetId: string | null) => ({
    onDragOver: (event: DragEvent) => {
      const types = event.dataTransfer.types;
      if (types.includes(NODE_TYPE) || types.includes('Files')) {
        event.preventDefault();
        event.stopPropagation();
        setDropTarget(targetId);
      }
    },
    onDragLeave: (event: DragEvent) => {
      event.stopPropagation();
      setDropTarget(undefined);
    },
    onDrop: (event: DragEvent) => {
      event.preventDefault();
      event.stopPropagation();
      setDropTarget(undefined);
      const draggedId = event.dataTransfer.getData(NODE_TYPE);
      if (draggedId !== '') {
        if (canDrop(nodes, draggedId, targetId)) {
          perform(actions.move(draggedId, targetId));
          if (targetId !== null) expand([targetId]);
        }
        return;
      }
      void fromDataTransfer(event.dataTransfer).then((uploads) => {
        if (uploads.length > 0) actions.upload(targetId, uploads);
        if (targetId !== null) expand([targetId]);
      });
    },
  });

  const moveTargetList = pending?.kind === 'move' ? moveTargets(roots, pending.item) : [];

  return (
    <div className="flex h-full flex-col">
      {toolbar(() => {
        const selected = items.find((item) => item.id === selectedId);
        setPending({
          kind: 'folder',
          parentId: selected?.kind === 'folder' ? selected.id : (selected?.parentId ?? null),
        });
      })}
      {error}
      <div
        className={`min-h-48 flex-1 overflow-auto rounded-md border p-1 ${
          dropTarget === null ? 'border-accent bg-sky-50' : 'border-slate-200'
        }`}
        data-testid="tree-dropzone"
        {...dropProps(null)}
      >
        <ul role="tree" aria-label={t('project.files')} onKeyDown={onKeyDown} className="text-sm">
          {items.map((item) => (
            <ContextMenu.Root key={item.id}>
              <ContextMenu.Trigger asChild>
                <li
                  id={`node-${item.id}`}
                  role="treeitem"
                  aria-level={item.depth + 1}
                  aria-selected={item.id === selectedId}
                  aria-expanded={item.kind === 'folder' ? expanded.has(item.id) : undefined}
                  data-path={item.path}
                  tabIndex={
                    item.id === selectedId || (selectedId === null && item === items[0]) ? 0 : -1
                  }
                  draggable
                  onDragStart={(event) => {
                    event.dataTransfer.setData(NODE_TYPE, item.id);
                    event.dataTransfer.effectAllowed = 'move';
                  }}
                  onClick={() => {
                    select(item.id);
                    if (item.kind === 'folder') toggleFolder(item.id);
                  }}
                  {...(item.kind === 'folder' ? dropProps(item.id) : {})}
                  className={`group flex cursor-pointer items-center gap-1 rounded px-1 py-0.5 outline-none focus-visible:ring-2 focus-visible:ring-accent ${
                    item.id === selectedId ? 'bg-slate-200' : 'hover:bg-slate-100'
                  } ${dropTarget === item.id ? 'ring-2 ring-accent' : ''}`}
                  style={{ paddingLeft: `${String(item.depth * 1 + 0.25)}rem` }}
                >
                  <span aria-hidden className="w-4 text-center text-slate-500">
                    {item.kind === 'folder' ? (expanded.has(item.id) ? '▾' : '▸') : ''}
                  </span>
                  <span className="truncate">{item.name}</span>
                  {item.id === mainFileId && (
                    <span className="rounded bg-accent/10 px-1 text-xs text-accent">
                      {t('project.main')}
                    </span>
                  )}
                  <DropdownMenu.Root>
                    <DropdownMenu.Trigger
                      className="ml-auto rounded px-1 text-slate-500 opacity-0 group-hover:opacity-100 focus:opacity-100 data-[state=open]:opacity-100"
                      aria-label={t('project.actions', { name: item.name })}
                      onClick={(event) => {
                        event.stopPropagation();
                      }}
                    >
                      ⋯
                    </DropdownMenu.Trigger>
                    <DropdownMenu.Portal>
                      <DropdownMenu.Content className="min-w-36 rounded-md border border-slate-200 bg-white p-1 shadow-md">
                        <ItemMenu item={item} open={setPending} Menu={DropdownMenu} />
                      </DropdownMenu.Content>
                    </DropdownMenu.Portal>
                  </DropdownMenu.Root>
                </li>
              </ContextMenu.Trigger>
              <ContextMenu.Portal>
                <ContextMenu.Content className="min-w-36 rounded-md border border-slate-200 bg-white p-1 shadow-md">
                  <ItemMenu item={item} open={setPending} Menu={ContextMenu} />
                </ContextMenu.Content>
              </ContextMenu.Portal>
            </ContextMenu.Root>
          ))}
        </ul>
        <p className="px-2 py-3 text-xs text-slate-500">{t('project.dropHint')}</p>
      </div>

      <NameDialog
        open={pending?.kind === 'rename'}
        onOpenChange={(open) => {
          if (!open) close();
        }}
        title={t('project.rename')}
        label={t('project.newName')}
        initialValue={pending?.kind === 'rename' ? pending.item.name : ''}
        submitLabel={t('common.save')}
        error={actionError}
        pending={busy}
        onSubmit={(name) => {
          if (pending?.kind === 'rename') perform(actions.rename(pending.item.id, name));
        }}
      />
      <NameDialog
        open={pending?.kind === 'folder'}
        onOpenChange={(open) => {
          if (!open) close();
        }}
        title={t('project.newFolder')}
        label={t('project.folderName')}
        submitLabel={t('common.create')}
        error={actionError}
        pending={busy}
        onSubmit={(name) => {
          if (pending?.kind !== 'folder') return;
          if (pending.parentId !== null) expand([pending.parentId]);
          perform(actions.createFolder(pending.parentId, name));
        }}
      />
      <Dialog
        open={pending?.kind === 'move'}
        onOpenChange={(open) => {
          if (!open) close();
        }}
        title={pending?.kind === 'move' ? t('project.moveTitle', { name: pending.item.name }) : ''}
      >
        <ul className="max-h-72 space-y-1 overflow-auto" aria-label={t('project.move')}>
          {moveTargetList.map((target) => (
            <li key={target?.id ?? 'root'}>
              <button
                type="button"
                disabled={busy}
                className="w-full rounded px-2 py-1 text-left text-sm hover:bg-slate-100"
                onClick={() => {
                  if (pending?.kind === 'move')
                    perform(actions.move(pending.item.id, target?.id ?? null));
                }}
              >
                {target === null ? t('project.root') : target.path}
              </button>
            </li>
          ))}
        </ul>
        <ErrorAlert error={actionError} />
      </Dialog>
      <ConfirmDialog
        open={pending?.kind === 'delete'}
        onOpenChange={(open) => {
          if (!open) close();
        }}
        title={t('project.delete')}
        description={
          pending?.kind === 'delete' ? t('project.confirmDelete', { name: pending.item.name }) : ''
        }
        confirmLabel={t('project.delete')}
        pending={busy}
        onConfirm={() => {
          if (pending?.kind !== 'delete') return;
          if (pending.item.id === selectedId) select(null);
          perform(actions.remove(pending.item.id));
        }}
      />
    </div>
  );
}
