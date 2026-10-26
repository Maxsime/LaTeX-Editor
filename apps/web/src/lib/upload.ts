/** A file to upload with its path below the drop target. */
export interface PendingUpload {
  path: string;
  file: File;
}

/** Uploads at most this many files per request, matching the API limit. */
export const UPLOAD_BATCH = 200;

/** Builds the multipart body expected by `POST /api/projects/:id/files`. */
export function uploadForm(parentId: string | null, uploads: readonly PendingUpload[]): FormData {
  const form = new FormData();
  form.append('parentId', parentId ?? '');
  for (const { path, file } of uploads) {
    form.append('path', path);
    form.append('file', file, file.name);
  }
  return form;
}

/** Splits a list into batches of at most `size` items. */
export function batches<T>(items: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    result.push(items.slice(index, index + size));
  }
  return result;
}

/** Files chosen with `<input type="file" webkitdirectory>` carry their relative path. */
export function fromFileList(files: Iterable<File>): PendingUpload[] {
  return [...files].map((file) => ({
    path: file.webkitRelativePath === '' ? file.name : file.webkitRelativePath,
    file,
  }));
}

function readEntries(reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> {
  return new Promise((resolve, reject) => {
    reader.readEntries(resolve, reject);
  });
}

async function walk(entry: FileSystemEntry, prefix: string, out: PendingUpload[]): Promise<void> {
  const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
  // isFile and isDirectory are the documented way to narrow a FileSystemEntry.
  if (entry.isFile) {
    const file = await new Promise<File>((resolve, reject) => {
      (entry as FileSystemFileEntry).file(resolve, reject);
    });
    out.push({ path, file });
    return;
  }
  const reader = (entry as FileSystemDirectoryEntry).createReader();
  // readEntries returns results in chunks; an empty chunk marks the end.
  for (let chunk = await readEntries(reader); chunk.length > 0; chunk = await readEntries(reader)) {
    for (const child of chunk) await walk(child, path, out);
  }
}

/** Collects dropped files and folders, keeping the folder structure. */
export async function fromDataTransfer(transfer: DataTransfer): Promise<PendingUpload[]> {
  const entries = [...transfer.items]
    .filter((item) => item.kind === 'file')
    .map((item) => item.webkitGetAsEntry())
    .filter((entry): entry is FileSystemEntry => entry !== null);
  if (entries.length === 0) return fromFileList(transfer.files);
  const out: PendingUpload[] = [];
  for (const entry of entries) await walk(entry, '', out);
  return out;
}
