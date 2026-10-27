import type { Readable } from 'node:stream';
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { blobKey, compileOutputKey } from '@galley/shared';
import type { CompilerConfig } from './config.js';

/** Creates the client of the object store holding blobs and compilation outputs. */
export function createS3Client(config: CompilerConfig): S3Client {
  return new S3Client({
    endpoint: config.S3_ENDPOINT,
    region: config.S3_REGION,
    forcePathStyle: config.S3_FORCE_PATH_STYLE,
    credentials: {
      accessKeyId: config.S3_ACCESS_KEY_ID,
      secretAccessKey: config.S3_SECRET_ACCESS_KEY,
    },
  });
}

/** Opens a project blob for reading. */
export async function readBlob(s3: S3Client, bucket: string, hash: string): Promise<Readable> {
  const { Body } = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: blobKey(hash) }));
  if (!Body) throw new Error(`blob ${hash} has no body`);
  // In Node.js the SDK returns an IncomingMessage, which is a Readable.
  return Body as Readable;
}

/** Opens a file published by a compilation. */
export async function readOutput(
  s3: S3Client,
  bucket: string,
  compileId: string,
  name: string,
): Promise<Readable> {
  const { Body } = await s3.send(
    new GetObjectCommand({ Bucket: bucket, Key: compileOutputKey(compileId, name) }),
  );
  if (!Body) throw new Error(`output ${name} of ${compileId} has no body`);
  return Body as Readable;
}

const CONTENT_TYPES: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.gz': 'application/gzip',
};

/** Publishes one output file of a compilation. */
export async function putOutput(
  s3: S3Client,
  bucket: string,
  compileId: string,
  name: string,
  body: Readable,
  size: number,
): Promise<void> {
  const extension = name.slice(name.lastIndexOf('.'));
  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: compileOutputKey(compileId, name),
      Body: body,
      ContentLength: size,
      ContentType: CONTENT_TYPES[extension] ?? 'text/plain; charset=utf-8',
    }),
  );
}
