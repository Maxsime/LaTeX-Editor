import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createLinkFetcher, isPublicAddress } from './fetch.js';

describe('isPublicAddress', () => {
  it.each([
    '127.0.0.1',
    '10.1.2.3',
    '172.20.0.5',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.0.1',
    '0.0.0.0',
    '224.0.0.1',
    '::1',
    '::',
    'fe80::1',
    'fd00::1',
    '::ffff:127.0.0.1',
    '::ffff:10.0.0.1',
    'not an address',
  ])('refuses %s', (address) => {
    expect(isPublicAddress(address)).toBe(false);
  });

  it.each(['1.1.1.1', '93.184.216.34', '2606:4700:4700::1111', '::ffff:8.8.8.8'])(
    'accepts %s',
    (address) => {
      expect(isPublicAddress(address)).toBe(true);
    },
  );
});

describe('createLinkFetcher', () => {
  let server: Server;
  let base: string;

  beforeAll(async () => {
    server = createServer((request, response) => {
      if (request.url === '/file.bib') {
        response.end('@book{knuth, title={TAOCP}}');
      } else if (request.url === '/redirect') {
        response.writeHead(302, { location: '/file.bib' });
        response.end();
      } else if (request.url === '/internal') {
        response.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data' });
        response.end();
      } else if (request.url === '/large') {
        response.writeHead(200, { 'content-length': String(30 * 1024 * 1024) });
        response.end();
      } else {
        response.writeHead(404);
        response.end();
      }
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    base = `http://localhost:${String((server.address() as AddressInfo).port)}`;
  });

  afterAll(() => {
    server.close();
  });

  it('refuses the local network by default, by name and by literal address', async () => {
    const fetcher = createLinkFetcher();
    await expect(fetcher(`${base}/file.bib`)).rejects.toMatchObject({
      code: 'LINK_ADDRESS_REFUSED',
    });
    await expect(fetcher(base.replace('localhost', '127.0.0.1'))).rejects.toMatchObject({
      code: 'LINK_ADDRESS_REFUSED',
    });
    await expect(fetcher('http://[::1]/')).rejects.toMatchObject({
      code: 'LINK_ADDRESS_REFUSED',
    });
  });

  it('refuses credentials and other protocols', async () => {
    const fetcher = createLinkFetcher(() => true);
    await expect(fetcher(`${base.replace('//', '//user:secret@')}/file.bib`)).rejects.toMatchObject(
      { code: 'LINK_ADDRESS_REFUSED' },
    );
    await expect(fetcher('file:///etc/passwd')).rejects.toMatchObject({
      code: 'LINK_ADDRESS_REFUSED',
    });
  });

  it('reads a file and follows redirects that stay allowed', async () => {
    const fetcher = createLinkFetcher((address) => address === '127.0.0.1' || address === '::1');
    const direct = await fetcher(`${base}/file.bib`);
    expect(new TextDecoder().decode(direct.bytes)).toContain('TAOCP');
    const redirected = await fetcher(`${base}/redirect`);
    expect(redirected.url).toBe(`${base}/file.bib`);
  });

  it('checks the target of every redirect again', async () => {
    const fetcher = createLinkFetcher((address) => address === '127.0.0.1' || address === '::1');
    await expect(fetcher(`${base}/internal`)).rejects.toMatchObject({
      code: 'LINK_ADDRESS_REFUSED',
    });
  });

  it('refuses missing and oversized sources', async () => {
    const fetcher = createLinkFetcher((address) => address === '127.0.0.1' || address === '::1');
    await expect(fetcher(`${base}/missing`)).rejects.toMatchObject({ code: 'LINK_FETCH_FAILED' });
    await expect(fetcher(`${base}/large`)).rejects.toMatchObject({ code: 'PAYLOAD_TOO_LARGE' });
  });
});
