import type { Readable } from 'node:stream';
import { DeleteObjectsCommand, GetObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import { compileOutputKey } from '@galley/shared';

/** Opens a file published by a compilation. */
export async function readCompileOutput(
  s3: S3Client,
  bucket: string,
  compileId: string,
  name: string,
): Promise<Readable> {
  const { Body } = await s3.send(
    new GetObjectCommand({ Bucket: bucket, Key: compileOutputKey(compileId, name) }),
  );
  if (!Body) throw new Error(`compile output ${name} has no body`);
  // In Node.js the SDK returns an IncomingMessage, which is a Readable.
  return Body as Readable;
}

/** S3 accepts at most this many keys per DeleteObjects request. */
const DELETE_BATCH = 1000;

/** Deletes the published files of a compilation. Missing keys are not an error. */
export async function deleteCompileOutputs(
  s3: S3Client,
  bucket: string,
  compileId: string,
  names: readonly string[],
): Promise<void> {
  for (let start = 0; start < names.length; start += DELETE_BATCH) {
    const keys = names.slice(start, start + DELETE_BATCH);
    await s3.send(
      new DeleteObjectsCommand({
        Bucket: bucket,
        Delete: {
          Objects: keys.map((name) => ({ Key: compileOutputKey(compileId, name) })),
          Quiet: true,
        },
      }),
    );
  }
}
