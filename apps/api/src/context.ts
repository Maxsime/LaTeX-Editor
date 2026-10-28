import type { S3Client } from '@aws-sdk/client-s3';
import type { Redis } from 'ioredis';
import type { ApiConfig } from './config.js';
import type { Database } from '@galley/db';
import type { DocumentGateway } from './collab/documents.js';
import type { CompileQueue } from './compile/service.js';
import type { SynctexClient } from './compile/synctex.js';
import type { SnippetCompiler } from './ai/snippets.js';
import type { LinkFetcher } from './links/fetch.js';

/** Long-lived dependencies shared by every route. */
export interface AppContext {
  config: ApiConfig;
  database: Database;
  redis: Redis;
  s3: S3Client;
  documents: DocumentGateway;
  compileQueue: CompileQueue;
  synctex: SynctexClient;
  /** Compiles assistant previews; absent where no worker serves them (some tests). */
  snippets?: SnippetCompiler;
  /** Reads linked files from the web; tests replace it to reach a local server. */
  linkFetcher?: LinkFetcher;
}
