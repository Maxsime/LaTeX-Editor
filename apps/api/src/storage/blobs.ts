import { createReadStream } from 'node:fs';
import type { Readable } from 'node:stream';
import { GetObjectCommand, PutObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import { inArray } from 'drizzle-orm';
import { type Executor, blobs } from '@galley/db';

/** Content to store, either already in memory or spooled to a temporary file. */
export type BlobSource =
  | { hash: string; size: number; mimeType: string; bytes: Uint8Array }
  | { hash: string; size: number; mimeType: string; path: string };

/** Object key of a content-addressed blob. */
export function blobKey(hash: string): string {
  return `blobs/${hash}`;
}

/**
 * Uploads the blobs that the database does not know yet and records them.
 * A `blobs` row is only written after its object is stored, so a row always
 * means the object exists; an object without a row is merely garbage.
 */
export async function storeBlobs(
  db: Executor,
  s3: S3Client,
  bucket: string,
  sources: readonly BlobSource[],
): Promise<void> {
  const unique = new Map(sources.map((source) => [source.hash, source]));
  if (unique.size === 0) return;
  const known = await db
    .select({ hash: blobs.hash })
    .from(blobs)
    .where(inArray(blobs.hash, [...unique.keys()]));
  for (const { hash } of known) unique.delete(hash);

  for (const source of unique.values()) {
    await s3.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: blobKey(source.hash),
        Body: 'bytes' in source ? source.bytes : createReadStream(source.path),
        ContentLength: source.size,
        ContentType: source.mimeType,
      }),
    );
    await db
      .insert(blobs)
      .values({ hash: source.hash, size: source.size, mimeType: source.mimeType })
      .onConflictDoNothing();
  }
}

/** Opens a stored blob for reading. */
export async function readBlob(s3: S3Client, bucket: string, hash: string): Promise<Readable> {
  const { Body } = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: blobKey(hash) }));
  if (!Body) throw new Error(`blob ${hash} has no body`);
  // In Node.js the SDK returns an IncomingMessage, which is a Readable.
  return Body as Readable;
}

/** Reads a whole stored blob into memory; callers bound its size beforehand. */
export async function readBlobBytes(s3: S3Client, bucket: string, hash: string): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of await readBlob(s3, bucket, hash)) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}
