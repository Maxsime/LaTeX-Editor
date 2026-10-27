import type { S3Client } from '@aws-sdk/client-s3';
import type { Redis } from 'ioredis';
import type { ApiConfig } from './config.js';
import type { Database } from '@galley/db';
import type { DocumentGateway } from './collab/documents.js';
import type { CompileQueue } from './compile/service.js';

/** Long-lived dependencies shared by every route. */
export interface AppContext {
  config: ApiConfig;
  database: Database;
  redis: Redis;
  s3: S3Client;
  documents: DocumentGateway;
  compileQueue: CompileQueue;
}
