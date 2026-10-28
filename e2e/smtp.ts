import { once } from 'node:events';
import { createServer, type Server } from 'node:net';

/** A message as the test server received it. */
export interface ReceivedMail {
  from: string;
  to: string[];
  /** Raw message: headers, blank line, body. */
  data: string;
}

/**
 * Smallest SMTP server that nodemailer talks to (a copy of apps/api/test/smtp.ts,
 * which the end-to-end package cannot import): no TLS, no authentication,
 * every message accepted and kept in `messages`. Enough to test that what the
 * API queues reaches a real SMTP conversation.
 */
export class TestSmtpServer {
  readonly messages: ReceivedMail[] = [];
  private readonly server: Server;
  private waiters: (() => void)[] = [];

  constructor() {
    this.server = createServer((socket) => {
      let buffer = '';
      let inData = false;
      let current: ReceivedMail = { from: '', to: [], data: '' };
      const reply = (line: string) => socket.write(`${line}\r\n`);
      reply('220 galley-test ESMTP');
      socket.setEncoding('utf8');
      socket.on('data', (chunk: string) => {
        buffer += chunk;
        for (let end = buffer.indexOf('\r\n'); end !== -1; end = buffer.indexOf('\r\n')) {
          const line = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          if (inData) {
            if (line === '.') {
              inData = false;
              this.messages.push(current);
              current = { from: '', to: [], data: '' };
              reply('250 queued');
              for (const wake of this.waiters.splice(0)) wake();
            } else {
              current.data += `${line.startsWith('..') ? line.slice(1) : line}\n`;
            }
            continue;
          }
          const verb = line.slice(0, 4).toUpperCase();
          if (verb === 'EHLO' || verb === 'HELO') reply('250 galley-test');
          else if (verb === 'MAIL') {
            current.from = /<([^>]*)>/.exec(line)?.[1] ?? '';
            reply('250 ok');
          } else if (verb === 'RCPT') {
            current.to.push(/<([^>]*)>/.exec(line)?.[1] ?? '');
            reply('250 ok');
          } else if (verb === 'DATA') {
            inData = true;
            reply('354 go on');
          } else if (verb === 'QUIT') {
            reply('221 bye');
            socket.end();
          } else reply('250 ok');
        }
      });
      socket.on('error', () => undefined);
    });
  }

  /** Listens on every interface: the API container reaches it through the Docker host. */
  async start(port: number): Promise<void> {
    this.server.listen(port, '0.0.0.0');
    await once(this.server, 'listening');
  }

  /** Resolves with the first message to `to` that `match` accepts, received now or later. */
  async waitFor(
    to: string,
    match: (mail: ReceivedMail) => boolean = () => true,
    timeoutMs = 30_000,
  ): Promise<ReceivedMail> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = this.messages.find((mail) => mail.to.includes(to) && match(mail));
      if (found) return found;
      const left = deadline - Date.now();
      if (left <= 0) throw new Error(`no e-mail to ${to}`);
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, left);
        this.waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  }

  async stop(): Promise<void> {
    this.server.close();
    await once(this.server, 'close');
  }
}

/** Body of a message, with quoted-printable soft breaks and escapes undone. */
export function bodyOf(mail: ReceivedMail): string {
  const body = mail.data.slice(mail.data.indexOf('\n\n') + 2);
  if (!/content-transfer-encoding:\s*quoted-printable/i.test(mail.data)) return body;
  return Buffer.from(
    body.replace(/=\n/g, '').replace(/=([0-9A-F]{2})/g, (_, hex: string) => `%${hex}`),
    'utf8',
  )
    .toString()
    .replace(/(%[0-9A-F]{2})+/g, (encoded) => decodeURIComponent(encoded));
}
