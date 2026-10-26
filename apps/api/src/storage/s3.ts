import {
  CreateBucketCommand,
  HeadBucketCommand,
  S3Client,
  S3ServiceException,
} from '@aws-sdk/client-s3';
import type { ApiConfig } from '../config.js';

/** Creates an S3 client for the configured object store (SeaweedFS by default). */
export function createS3Client(config: ApiConfig): S3Client {
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

/** Resolves when the bucket exists and the credentials can reach it. */
export async function headBucket(client: S3Client, bucket: string): Promise<void> {
  await client.send(new HeadBucketCommand({ Bucket: bucket }));
}

/**
 * Creates the bucket if it does not exist yet, so a fresh instance needs no
 * manual setup. Safe to call on every start and from concurrent instances.
 */
export async function ensureBucket(client: S3Client, bucket: string): Promise<void> {
  try {
    await headBucket(client, bucket);
    return;
  } catch (error) {
    if (!isNotFound(error)) {
      throw error;
    }
  }
  try {
    await client.send(new CreateBucketCommand({ Bucket: bucket }));
  } catch (error) {
    // Another instance won the race; the bucket exists, which is all we need.
    if (!(error instanceof S3ServiceException && isAlreadyOwned(error))) {
      throw error;
    }
  }
}

function isNotFound(error: unknown): boolean {
  return (
    error instanceof S3ServiceException &&
    (error.name === 'NotFound' ||
      error.name === 'NoSuchBucket' ||
      error.$metadata.httpStatusCode === 404)
  );
}

function isAlreadyOwned(error: S3ServiceException): boolean {
  return error.name === 'BucketAlreadyOwnedByYou' || error.name === 'BucketAlreadyExists';
}
