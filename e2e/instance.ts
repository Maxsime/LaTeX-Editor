import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32 } from 'node:zlib';
import { expect, type Page } from '@playwright/test';
import yauzl from 'yauzl';

const repository = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Reference project archive shared with the API integration tests. */
export const referenceArchive = join(repository, 'fixtures/archives/reference-report.zip');

function compose(args: string[]): string {
  return execFileSync('docker', ['compose', ...args], { cwd: repository, encoding: 'utf8' });
}

/** Runs the operator CLI inside the API container, as the README documents. */
export function adminCli(args: string[]): string {
  return compose(['exec', '-T', 'api', 'node', 'dist/cli/admin.js', ...args]);
}

/** Setup code printed by the API while no account exists. */
export function setupCodeFromLogs(): string {
  const logs = compose(['logs', '--no-color', '--no-log-prefix', 'api']);
  const codes = [...logs.matchAll(/"setupCode":"([^"]+)"/g)].map((match) => match[1]);
  const code = codes.at(-1);
  if (code === undefined) throw new Error('no setup code in the API logs');
  return code;
}

export interface Account {
  login: string;
  password: string;
}

/** Creates an account through the CLI; names are unique per run so the suite can be replayed. */
export function createAccount(prefix: string): Account {
  const username = `${prefix}${String(Date.now())}${String(Math.floor(Math.random() * 1000))}`;
  const output = adminCli([
    'create-user',
    '--email',
    `${username}@example.org`,
    '--username',
    username,
    '--name',
    prefix,
  ]);
  const password = /Temporary password: (\S+)/.exec(output)?.[1];
  if (password === undefined) throw new Error(`unexpected CLI output: ${output}`);
  return { login: username, password };
}

export async function signIn(page: Page, account: Account): Promise<void> {
  await page.goto('/login');
  await page.getByLabel("Adresse e-mail ou nom d'utilisateur").fill(account.login);
  await page.getByLabel('Mot de passe').fill(account.password);
  await page.getByRole('button', { name: 'Se connecter' }).click();
  await expect(page).toHaveURL(/\/projects$/);
}

/** `{path: SHA-256}` of every entry of a zip archive; directories map to null. */
export async function zipDigests(path: string): Promise<Record<string, string | null>> {
  const zip = await yauzl.openPromise(path, { lazyEntries: true });
  const result: Record<string, string | null> = {};
  for await (const entry of zip.eachEntry()) {
    if (entry.fileName.endsWith('/')) {
      result[entry.fileName] = null;
      continue;
    }
    const hash = createHash('sha256');
    for await (const chunk of await zip.openReadStreamPromise(entry)) hash.update(chunk as Buffer);
    result[entry.fileName] = hash.digest('hex');
  }
  zip.close();
  return result;
}

/** A stored-only zip with one entry whose name archivers would refuse to write. */
export function hostileZip(name: string): Buffer {
  const data = Buffer.from('owned');
  const fileName = Buffer.from(name);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(fileName.length, 26);
  const crc = crc32(data);
  local.writeUInt32LE(crc, 14);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(fileName.length, 28);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + fileName.length, 12);
  end.writeUInt32LE(local.length + fileName.length + data.length, 16);
  return Buffer.concat([local, fileName, data, central, fileName, end]);
}
