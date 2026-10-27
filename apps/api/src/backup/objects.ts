import { createHash } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Readable, type Writable } from 'node:stream';
import {
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  type S3Client,
} from '@aws-sdk/client-s3';
import * as tar from 'tar-stream';

/** A stored object as listed by the bucket. */
export interface ObjectInfo {
  key: string;
  size: number;
}

/** Lists every object of the bucket, page after page. */
export async function* listObjects(s3: S3Client, bucket: string): AsyncGenerator<ObjectInfo> {
  let token: string | undefined;
  do {
    const page = await s3.send(
      new ListObjectsV2Command({ Bucket: bucket, ContinuationToken: token }),
    );
    for (const item of page.Contents ?? []) {
      if (item.Key !== undefined) yield { key: item.Key, size: item.Size ?? 0 };
    }
    token = page.IsTruncated === true ? page.NextContinuationToken : undefined;
  } while (token !== undefined);
}

/**
 * Keys Galley writes: blobs, compilation outputs and the like, as relative
 * paths of plain segments. Anything else in an archive is refused rather than
 * written into the bucket.
 */
export function isObjectKey(key: string): boolean {
  if (key.length === 0 || key.length > 1024) return false;
  if (!/^[A-Za-z0-9._\-/]+$/.test(key)) return false;
  return key.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

/** Adds one file to an archive, copying `body` with back-pressure. */
async function writeEntry(
  pack: tar.Pack,
  header: { name: string; size: number },
  body: Readable,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const entry = pack.entry({ ...header, mode: 0o644 }, (error) => {
      if (error) reject(error);
      else resolve();
    });
    body.on('error', reject);
    body.on('data', (chunk: Buffer) => {
      if (!entry.write(chunk)) {
        body.pause();
        entry.once('drain', () => body.resume());
      }
    });
    // The typings ask for a last chunk; an empty one adds nothing to the entry.
    body.on('end', () => entry.end(Buffer.alloc(0)));
  });
}

/**
 * Writes every object of the bucket to `output` as a tar archive, one entry
 * per key. Returns the number of objects and a digest of their keys and sizes,
 * recorded in the backup manifest.
 */
export async function exportObjects(
  s3: S3Client,
  bucket: string,
  output: Writable,
): Promise<{ count: number; bytes: number; digest: string }> {
  const pack = tar.pack();
  const written = pipeline(pack, output);
  const digest = createHash('sha256');
  let count = 0;
  let bytes = 0;
  for await (const object of listObjects(s3, bucket)) {
    const { Body } = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: object.key }));
    if (!Body) throw new Error(`object ${object.key} has no body`);
    // In Node.js the SDK returns an IncomingMessage, which is a Readable.
    await writeEntry(pack, { name: object.key, size: object.size }, Body as Readable);
    digest.update(`${object.key}\0${String(object.size)}\n`);
    count += 1;
    bytes += object.size;
  }
  pack.finalize();
  await written;
  return { count, bytes, digest: digest.digest('hex') };
}

/** Reads a tar archive of {@link exportObjects} and stores each entry under its key. */
export async function importObjects(
  s3: S3Client,
  bucket: string,
  input: Readable,
): Promise<{ count: number; bytes: number }> {
  const extract = tar.extract();
  const done = pipeline(input, extract);
  let count = 0;
  let bytes = 0;
  try {
    for await (const entry of extract) {
      const { name, size, type } = entry.header;
      if (type === 'directory') {
        entry.resume();
        continue;
      }
      if (type !== 'file' || !isObjectKey(name)) {
        throw new Error(`refused archive entry: ${name}`);
      }
      // tar-stream's streams are not Node streams: the SDK gets a Node one.
      await s3.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: name,
          Body: Readable.from(entry),
          ContentLength: size,
        }),
      );
      count += 1;
      bytes += size;
    }
  } catch (error) {
    // Stopping early closes the archive stream: that is a consequence, not the cause.
    await done.catch(() => undefined);
    throw error;
  }
  await done;
  return { count, bytes };
}
