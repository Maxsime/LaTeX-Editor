import { spawn } from 'node:child_process';
import { PassThrough, type Readable, Transform } from 'node:stream';
import { createGunzip } from 'node:zlib';
import { gitEnvironment } from './run.js';

export type GitService = 'upload-pack' | 'receive-pack';

export interface ServiceRequest {
  gitDir: string;
  service: GitService;
  /** `advertise` answers `info/refs`; `rpc` answers the POST that follows. */
  mode: 'advertise' | 'rpc';
  /** Request body of an `rpc` call. */
  body: Readable | null;
  gzip: boolean;
  /** Value of the client's Git-Protocol header, already validated. */
  gitProtocol: string | undefined;
  /** Largest request body accepted, compressed. */
  maxBodyBytes: number;
  /** Variables for the push hook. */
  env?: Record<string, string>;
  onTooLarge: () => void;
}

/** Counts bytes going through and fails past `limit`. */
function byteLimit(limit: number, onExceeded: () => void): Transform {
  let seen = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      seen += chunk.length;
      if (seen > limit) {
        onExceeded();
        callback(new Error('request body too large'));
      } else {
        callback(null, chunk);
      }
    },
  });
}

/** A pkt-line, the framing of the Git protocol. */
function pktLine(text: string): string {
  return `${(text.length + 4).toString(16).padStart(4, '0')}${text}`;
}

/** Content type of a smart HTTP response. */
export function serviceContentType(service: GitService, mode: ServiceRequest['mode']): string {
  return mode === 'advertise'
    ? `application/x-git-${service}-advertisement`
    : `application/x-git-${service}-result`;
}

/**
 * Runs `git upload-pack` or `git receive-pack` in stateless RPC mode for one
 * smart HTTP request, the way `git http-backend` does, and returns its output
 * as the response body. Protocol v2 clients get no service header.
 */
export function runService(request: ServiceRequest): Readable {
  const env = gitEnvironment({
    ...(request.gitProtocol === undefined ? {} : { GIT_PROTOCOL: request.gitProtocol }),
    ...request.env,
  });
  const args = [
    request.service,
    '--stateless-rpc',
    ...(request.mode === 'advertise' ? ['--http-backend-info-refs'] : []),
    request.gitDir,
  ];
  const child = spawn('git', args, { env, stdio: ['pipe', 'pipe', 'ignore'] });
  child.stdin.on('error', () => undefined);
  if (request.body) {
    const limit = () =>
      byteLimit(request.maxBodyBytes, () => {
        request.onTooLarge();
        child.kill('SIGKILL');
      });
    // The limit applies before and after decompression, against gzip bombs.
    const stages: NodeJS.ReadWriteStream[] = request.gzip
      ? [limit(), createGunzip(), limit()]
      : [limit()];
    let input: NodeJS.ReadableStream = request.body;
    for (const stage of stages) {
      stage.on('error', () => child.stdin.destroy());
      input = input.pipe(stage);
    }
    input.pipe(child.stdin);
  } else {
    child.stdin.end();
  }
  const output = new PassThrough();
  if (request.mode === 'advertise' && !request.gitProtocol?.includes('version=2')) {
    output.write(`${pktLine(`# service=git-${request.service}\n`)}0000`);
  }
  child.stdout.pipe(output);
  child.on('error', (error) => output.destroy(error));
  return output;
}
