import { SESSION_COOKIE } from '@galley/shared';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import type { multipart } from './zip.js';

type Body = Record<string, unknown>;

/** A browser-like session: keeps the cookie and sends the CSRF token. */
export class Client {
  private cookie: string | undefined;
  csrf: string | undefined;

  constructor(
    private readonly app: FastifyInstance,
    private readonly ip: string,
  ) {}

  async send(
    method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
    url: string,
    options: {
      json?: unknown;
      form?: ReturnType<typeof multipart>;
      headers?: Record<string, string>;
    } = {},
  ): Promise<LightMyRequestResponse> {
    const headers: Record<string, string> = { ...options.form?.headers, ...options.headers };
    if (this.cookie !== undefined) headers.cookie = `${SESSION_COOKIE}=${this.cookie}`;
    if (this.csrf !== undefined && method !== 'GET') headers['x-csrf-token'] ??= this.csrf;
    const response = await this.app.inject({
      method,
      url,
      headers,
      remoteAddress: this.ip,
      ...(options.json === undefined ? {} : { payload: options.json as Body }),
      ...(options.form === undefined ? {} : { payload: options.form.payload }),
    });
    const set = response.cookies.find((cookie) => cookie.name === SESSION_COOKIE);
    if (set) {
      this.cookie = set.value === '' ? undefined : set.value;
      const session = await this.app.inject({
        method: 'GET',
        url: '/api/auth/session',
        headers: this.cookie === undefined ? {} : { cookie: `${SESSION_COOKIE}=${this.cookie}` },
      });
      this.csrf = session.json<{ csrfToken: string | null }>().csrfToken ?? undefined;
    }
    return response;
  }
}
