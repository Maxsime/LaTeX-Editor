import { spawn } from 'node:child_process';
import { PassThrough, type Readable, Transform } from 'node:stream';
import { gitEnvironment } from './run.js';

export interface CgiResponse {
  status: number;
  headers: Record<string, string>;
  body: Readable;
}

export interface BackendRequest {
  projectRoot: string;
  /** `/<repository>/<service path>`, already validated. */
  pathInfo: string;
  method: 'GET' | 'POST';
  query: string;
  contentType: string | undefined;
  contentEncoding: string | undefined;
  gitProtocol: string | undefined;
  remoteUser: string;
  remoteAddress: string;
  body: Readable | null;
  /** Largest request body accepted, compressed. */
  maxBodyBytes: number;
  /** Variables for the push hook. */
  hookEnv?: Record<string, string>;
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

/** Splits CGI output into its header block and the body that follows. */
function readHead(stdout: Readable): Promise<{ head: string; body: Readable }> {
  return new Promise((resolve, reject) => {
    let buffered = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      const crlf = buffered.indexOf('\r\n\r\n');
      const lf = buffered.indexOf('\n\n');
      const end = crlf >= 0 && (lf < 0 || crlf < lf) ? crlf + 4 : lf >= 0 ? lf + 2 : -1;
      if (end < 0) {
        if (buffered.length > 64 * 1024) reject(new Error('CGI header too long'));
        return;
      }
      stdout.off('data', onData);
      stdout.off('end', onEnd);
      const body = new PassThrough();
      body.write(buffered.subarray(end));
      stdout.pipe(body);
      resolve({ head: buffered.subarray(0, end).toString('latin1'), body });
    };
    const onEnd = () => {
      reject(new Error('CGI output ended before its headers'));
    };
    stdout.on('data', onData);
    stdout.on('end', onEnd);
  });
}

/**
 * Runs `git http-backend` for one request, as a CGI program with an
 * environment reduced to what it needs.
 */
export async function runHttpBackend(request: BackendRequest): Promise<CgiResponse> {
  const env = gitEnvironment({
    GIT_PROJECT_ROOT: request.projectRoot,
    GIT_HTTP_EXPORT_ALL: '1',
    PATH_INFO: request.pathInfo,
    REQUEST_METHOD: request.method,
    QUERY_STRING: request.query,
    REMOTE_USER: request.remoteUser,
    REMOTE_ADDR: request.remoteAddress,
    ...(request.contentType === undefined ? {} : { CONTENT_TYPE: request.contentType }),
    ...(request.contentEncoding === undefined
      ? {}
      : { HTTP_CONTENT_ENCODING: request.contentEncoding }),
    ...(request.gitProtocol === undefined ? {} : { GIT_PROTOCOL: request.gitProtocol }),
    ...request.hookEnv,
  });
  const child = spawn('git', ['http-backend'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  const stderr: Buffer[] = [];
  child.stderr.on('data', (chunk: Buffer) => {
    if (stderr.length < 64) stderr.push(chunk);
  });
  child.stdin.on('error', () => undefined);
  if (request.body) {
    request.body
      .pipe(
        byteLimit(request.maxBodyBytes, () => {
          request.onTooLarge();
          child.kill('SIGKILL');
        }),
      )
      .on('error', () => child.stdin.destroy())
      .pipe(child.stdin);
  } else {
    child.stdin.end();
  }
  const exited = new Promise<void>((resolve) => {
    child.on('close', () => {
      resolve();
    });
  });
  try {
    const { head, body } = await readHead(child.stdout);
    let status = 200;
    const headers: Record<string, string> = {};
    for (const line of head.split(/\r?\n/)) {
      const colon = line.indexOf(':');
      if (colon <= 0) continue;
      const name = line.slice(0, colon).trim().toLowerCase();
      const value = line.slice(colon + 1).trim();
      if (name === 'status') status = Number.parseInt(value, 10) || 500;
      else if (['content-type', 'cache-control', 'expires', 'pragma'].includes(name)) {
        headers[name] = value;
      }
    }
    return { status, headers, body };
  } catch (error) {
    child.kill('SIGKILL');
    await exited;
    throw new Error(`git http-backend failed: ${Buffer.concat(stderr).toString('utf8')}`, {
      cause: error,
    });
  }
}
