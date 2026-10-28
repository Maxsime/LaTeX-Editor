import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import { BlockList, isIP, type LookupFunction } from 'node:net';
import { ApiError } from '@galley/shared';

/** Largest linked file fetched from the web. */
export const MAX_LINKED_BYTES = 20 * 1024 * 1024;
const TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 5;

/**
 * Addresses a linked file may never be fetched from: the instance's own
 * network, loopback, link-local (cloud metadata services), multicast and the
 * reserved ranges, in IPv4 and IPv6 (RFC 6890).
 */
const blocked = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  blocked.addSubnet(network, prefix, 'ipv4');
}
for (const [network, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['64:ff9b:1::', 48],
  ['100::', 64],
  ['2001::', 23],
  ['2001:db8::', 32],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
] as const) {
  blocked.addSubnet(network, prefix, 'ipv6');
}

/**
 * Whether an address is public. IPv4-mapped IPv6 addresses (`::ffff:a.b.c.d`)
 * are judged by the IPv4 address they carry.
 */
export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !blocked.check(address, 'ipv4');
  if (family !== 6) return false;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  if (mapped?.[1] !== undefined) return isPublicAddress(mapped[1]);
  return !blocked.check(address, 'ipv6');
}

/** Decides which resolved addresses may be connected to. */
export type AddressPolicy = (address: string) => boolean;

/**
 * Resolves like `dns.lookup`, then refuses the whole answer if any address is
 * not allowed. The socket connects to the address checked here, so a name
 * that resolves differently on a second query cannot reach another host.
 */
function guardedLookup(allowed: AddressPolicy): LookupFunction {
  return (hostname, options, callback) => {
    dnsLookup(hostname, { ...options, all: true }, (error, addresses: LookupAddress[]) => {
      if (error) {
        callback(error, '', 0);
        return;
      }
      const refused = addresses.length === 0 || addresses.some((entry) => !allowed(entry.address));
      if (refused) {
        callback(Object.assign(new Error('address refused'), { code: 'EREFUSED_ADDRESS' }), '', 0);
        return;
      }
      if (options.all) {
        callback(null, addresses);
        return;
      }
      const [first] = addresses;
      callback(null, first?.address ?? '', first?.family ?? 4);
    });
  };
}

/** Content of a linked file read from the web. */
export interface FetchedLink {
  bytes: Uint8Array;
  /** Final URL after redirects. */
  url: string;
}

/** Reads a linked file's source; injectable so that tests can serve it locally. */
export type LinkFetcher = (url: string) => Promise<FetchedLink>;

function requestOnce(
  url: URL,
  allowed: AddressPolicy,
): Promise<{ redirect: string } | { bytes: Uint8Array }> {
  return new Promise((resolve, reject) => {
    const literal = url.hostname.replace(/^\[|\]$/g, '');
    if (isIP(literal) !== 0 && !allowed(literal)) {
      reject(new ApiError('LINK_ADDRESS_REFUSED'));
      return;
    }
    const client = url.protocol === 'https:' ? https : http;
    const request = client.get(
      url,
      {
        lookup: guardedLookup(allowed),
        timeout: TIMEOUT_MS,
        headers: { 'user-agent': 'Galley linked files', accept: '*/*' },
        // Sockets are not reused: each one went through the address check.
        agent: false,
      },
      (response) => {
        const status = response.statusCode ?? 0;
        if (status >= 300 && status < 400 && response.headers.location !== undefined) {
          response.resume();
          resolve({ redirect: response.headers.location });
          return;
        }
        if (status < 200 || status >= 300) {
          response.resume();
          reject(new ApiError('LINK_FETCH_FAILED', `status ${String(status)}`));
          return;
        }
        const declared = Number(response.headers['content-length'] ?? 0);
        if (declared > MAX_LINKED_BYTES) {
          response.destroy();
          reject(new ApiError('PAYLOAD_TOO_LARGE'));
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        response.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_LINKED_BYTES) {
            response.destroy();
            reject(new ApiError('PAYLOAD_TOO_LARGE'));
            return;
          }
          chunks.push(chunk);
        });
        response.on('end', () => {
          resolve({ bytes: new Uint8Array(Buffer.concat(chunks)) });
        });
        response.on('error', () => {
          reject(new ApiError('LINK_FETCH_FAILED'));
        });
      },
    );
    request.on('timeout', () => {
      request.destroy(new Error('timeout'));
    });
    request.on('error', (error: NodeJS.ErrnoException) => {
      reject(
        error.code === 'EREFUSED_ADDRESS'
          ? new ApiError('LINK_ADDRESS_REFUSED')
          : new ApiError('LINK_FETCH_FAILED'),
      );
    });
  });
}

/**
 * Creates a fetcher that reads `http` and `https` URLs from allowed addresses
 * only, following at most five redirects (each one checked again), within
 * 15 s and {@link MAX_LINKED_BYTES}. No cookie or credential is ever sent.
 */
export function createLinkFetcher(allowed: AddressPolicy = isPublicAddress): LinkFetcher {
  return async (start) => {
    let url = new URL(start);
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw new ApiError('LINK_ADDRESS_REFUSED');
      }
      if (url.username !== '' || url.password !== '') throw new ApiError('LINK_ADDRESS_REFUSED');
      const result = await requestOnce(url, allowed);
      if ('bytes' in result) return { bytes: result.bytes, url: url.href };
      url = new URL(result.redirect, url);
    }
    throw new ApiError('LINK_FETCH_FAILED', 'too many redirects');
  };
}
