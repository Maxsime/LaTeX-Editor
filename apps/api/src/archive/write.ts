import type { Readable } from 'node:stream';
import yazl from 'yazl';
import type { MaterializedProject } from '../materialize.js';

/**
 * Streams a materialized project as a zip archive. Blobs are opened one at a
 * time, when the archiver reaches them, so memory use does not grow with the
 * project.
 */
export function writeArchive(
  snapshot: MaterializedProject,
  openBlob: (hash: string) => Promise<Readable>,
): Readable {
  const zip = new yazl.ZipFile();
  const mtime = new Date();
  for (const folder of snapshot.folders) {
    zip.addEmptyDirectory(folder, { mtime });
  }
  const paths = Object.keys(snapshot.manifest).sort();
  for (const path of paths) {
    const hash = snapshot.manifest[path];
    if (hash === undefined) continue;
    zip.addReadStreamLazy(path, { mtime }, (callback) => {
      openBlob(hash).then(
        (stream) => {
          callback(null, stream);
        },
        (error: unknown) => {
          callback(error, undefined as never);
        },
      );
    });
  }
  zip.end();
  // yazl's output is a PassThrough, typed loosely as a NodeJS.ReadableStream.
  return zip.outputStream as Readable;
}
