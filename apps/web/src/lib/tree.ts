import type { TreeNode } from '@galley/shared';

/** A tree node with its children, as displayed. */
export interface TreeItem extends TreeNode {
  path: string;
  depth: number;
  children: TreeItem[];
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/** Folders first, then natural name order ("chap2" before "chap10"). */
export function compareNodes(a: TreeNode, b: TreeNode): number {
  if ((a.kind === 'folder') !== (b.kind === 'folder')) return a.kind === 'folder' ? -1 : 1;
  return collator.compare(a.name, b.name) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
}

/** Rebuilds the hierarchy from the flat list returned by the API. */
export function buildTree(nodes: readonly TreeNode[]): TreeItem[] {
  const children = new Map<string | null, TreeNode[]>();
  for (const node of nodes) {
    const list = children.get(node.parentId) ?? [];
    list.push(node);
    children.set(node.parentId, list);
  }
  const build = (parentId: string | null, prefix: string, depth: number): TreeItem[] =>
    (children.get(parentId) ?? [])
      .slice()
      .sort(compareNodes)
      .map((node) => {
        const path = prefix === '' ? node.name : `${prefix}/${node.name}`;
        return { ...node, path, depth, children: build(node.id, path, depth + 1) };
      });
  return build(null, '', 0);
}

/** Depth-first list of the items whose ancestors are all expanded. */
export function visibleItems(
  roots: readonly TreeItem[],
  expanded: ReadonlySet<string>,
): TreeItem[] {
  const result: TreeItem[] = [];
  const walk = (items: readonly TreeItem[]): void => {
    for (const item of items) {
      result.push(item);
      if (item.kind === 'folder' && expanded.has(item.id)) walk(item.children);
    }
  };
  walk(roots);
  return result;
}

/** Every item, depth first. */
export function flatten(roots: readonly TreeItem[]): TreeItem[] {
  return visibleItems(roots, new Set(flattenIds(roots)));
}

function flattenIds(items: readonly TreeItem[]): string[] {
  return items.flatMap((item) => [item.id, ...flattenIds(item.children)]);
}

/**
 * Folders a node may be moved into: not itself, not one of its descendants,
 * and not its current parent. `null` stands for the project root.
 */
export function moveTargets(roots: readonly TreeItem[], node: TreeItem): (TreeItem | null)[] {
  const excluded = new Set([node.id, ...flattenIds(node.children)]);
  const folders = flatten(roots).filter(
    (item) => item.kind === 'folder' && !excluded.has(item.id) && item.id !== node.parentId,
  );
  return node.parentId === null ? folders : [null, ...folders];
}

/** Whether dropping `dragged` onto folder `targetId` (null: root) is a valid move. */
export function canDrop(
  nodes: readonly TreeNode[],
  draggedId: string,
  targetId: string | null,
): boolean {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const dragged = byId.get(draggedId);
  if (!dragged || dragged.parentId === targetId) return false;
  for (let current = targetId; current !== null; current = byId.get(current)?.parentId ?? null) {
    if (current === draggedId) return false;
  }
  return true;
}

/** Lowercased extension, without the dot. */
export function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot <= 0 ? '' : name.slice(dot + 1).toLowerCase();
}

export type PreviewKind = 'image' | 'pdf' | 'text' | 'none';

/** How the project page previews a file. */
export function previewKind(node: Pick<TreeNode, 'kind' | 'name'>): PreviewKind {
  if (node.kind === 'text') return 'text';
  if (node.kind === 'folder') return 'none';
  const extension = extensionOf(node.name);
  if (['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(extension)) return 'image';
  return extension === 'pdf' ? 'pdf' : 'none';
}
