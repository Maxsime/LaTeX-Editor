import type { ImportProjectResponse } from '@galley/shared';

/** Where one archive of a batch import stands. */
export type ImportItem =
  | { fileName: string; status: 'pending' | 'running' }
  | { fileName: string; status: 'done'; result: ImportProjectResponse }
  | { fileName: string; status: 'failed'; error: unknown }
  | { fileName: string; status: 'skipped' };

/**
 * Whether a picked or dropped file is meant as a zip archive. The extension
 * decides, since browsers report zip files under several MIME types (or none).
 */
export function isZipFile(file: Pick<File, 'name'>): boolean {
  return /\.zip$/i.test(file.name);
}

/** Initial state of a batch: zips wait their turn, anything else is skipped. */
export function initialItems(files: readonly Pick<File, 'name'>[]): ImportItem[] {
  return files.map((file) =>
    isZipFile(file)
      ? { fileName: file.name, status: 'pending' }
      : { fileName: file.name, status: 'skipped' },
  );
}

/**
 * Imports the zips of `files` one after the other, each as a project of its
 * own. A failed archive is recorded and the next one still runs. Imports are
 * sequential on purpose: the server unpacks each archive in full and limits
 * imports per minute, so parallel requests would only compete for both.
 *
 * `onChange` receives a fresh array after every step, ready for React state.
 */
export async function runImports<F extends Pick<File, 'name'>>(
  files: readonly F[],
  importOne: (file: F) => Promise<ImportProjectResponse>,
  onChange: (items: readonly ImportItem[]) => void,
): Promise<readonly ImportItem[]> {
  let items = initialItems(files);
  const update = (index: number, item: ImportItem): void => {
    items = items.map((current, position) => (position === index ? item : current));
    onChange(items);
  };
  onChange(items);
  for (const [index, file] of files.entries()) {
    if (items[index]?.status !== 'pending') continue;
    update(index, { fileName: file.name, status: 'running' });
    try {
      const result = await importOne(file);
      update(index, { fileName: file.name, status: 'done', result });
    } catch (error) {
      update(index, { fileName: file.name, status: 'failed', error });
    }
  }
  return items;
}
