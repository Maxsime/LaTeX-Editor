import { createHash, X509Certificate } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

export const host = process.env.GALLEY_HOST ?? 'localhost';
export const httpsPort = process.env.GALLEY_HTTPS_PORT ?? '443';
export const httpPort = process.env.GALLEY_HTTP_PORT ?? '80';
export const baseURL = `https://${host}${httpsPort === '443' ? '' : `:${httpsPort}`}`;
export const httpURL = `http://${host}${httpPort === '80' ? '' : `:${httpPort}`}`;

const caDir = process.env.GALLEY_CA_DIR ?? join(here, '.ca');

/** PEM of the instance's local root CA, copied out of the stack by scripts/run.js. */
export const caCertificate = readFileSync(join(caDir, 'root.crt'), 'utf8');

/** Current intermediate of the local CA; Caddy rotates it, so it is fetched on every run. */
export const intermediateCertificate = readFileSync(join(caDir, 'intermediate.crt'), 'utf8');

/** Base64 SHA-256 of a certificate's SubjectPublicKeyInfo, as Chromium's SPKI allow-list expects. */
export function spkiHash(pem: string): string {
  const der = new X509Certificate(pem).publicKey.export({ type: 'spki', format: 'der' });
  return createHash('sha256').update(der).digest('base64');
}
