import { parseArgs } from 'node:util';
import { email, displayName, username } from '@galley/shared';
import { eq } from 'drizzle-orm';
import * as z from 'zod/mini';
import { hashPassword } from '../auth/password.js';
import { deleteUserSessions } from '../auth/sessions.js';
import { randomToken, tokenDigest } from '../auth/tokens.js';
import { createUser, findUserByLogin } from '../auth/users.js';
import { temporaryPassword } from '../admin/users.js';
import { readConfig } from '../config.js';
import { createDatabase, type Database, registrationInvites, users } from '@galley/db';
import { runMigrations } from '@galley/db';
import type { S3Client } from '@aws-sdk/client-s3';
import { readPackageVersion } from '@galley/shared/node';
import { fingerprint } from '../backup/fingerprint.js';
import { exportObjects, importObjects } from '../backup/objects.js';
import { createS3Client, ensureBucket } from '../storage/s3.js';

const usage = `Usage: admin <command> [options]

Commands:
  create-user --email <e-mail> --username <name> --name <display name> [--admin]
      Creates an account and prints a temporary password.
  reset-password <e-mail or username>
      Replaces the password with a temporary one, signs the account out everywhere.
  create-invite [--days <1-90>]
      Prints a registration invite token.

Backups (used by scripts/backup.sh and scripts/restore.sh):
  backup-info
      Prints the application version and the number of applied migrations (JSON).
  export-objects
      Writes every stored object to standard output as a tar archive.
  import-objects
      Stores the objects of a tar archive read from standard input.
  fingerprint
      Prints counts and a digest of accounts, projects, files, history and objects (JSON).
`;

function print(line: string): void {
  process.stdout.write(`${line}\n`);
}

async function createUserCommand(database: Database, args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      email: { type: 'string' },
      username: { type: 'string' },
      name: { type: 'string' },
      admin: { type: 'boolean', default: false },
    },
  });
  const input = z
    .object({ email, username, displayName })
    .parse({ email: values.email, username: values.username, displayName: values.name });
  const password = temporaryPassword();
  const user = await createUser(database.db, { ...input, password }, values.admin);
  print(`Account ${user.username} created${user.isAdmin ? ' (administrator)' : ''}.`);
  print(`Temporary password: ${password}`);
}

async function resetPasswordCommand(database: Database, args: string[]): Promise<void> {
  const login = args[0];
  if (login === undefined) throw new Error(usage);
  const user = await findUserByLogin(database.db, login);
  if (!user) throw new Error(`No active account matches "${login}".`);
  const password = temporaryPassword();
  await database.db
    .update(users)
    .set({ passwordHash: await hashPassword(password) })
    .where(eq(users.id, user.id));
  await deleteUserSessions(database, user.id);
  print(`Password of ${user.username} reset; all its sessions are closed.`);
  print(`Temporary password: ${password}`);
}

async function createInviteCommand(database: Database, args: string[]): Promise<void> {
  const { values } = parseArgs({ args, options: { days: { type: 'string', default: '7' } } });
  const days = z.coerce.number().check(z.int(), z.gte(1), z.lte(90)).parse(values.days);
  const token = randomToken();
  await database.db.insert(registrationInvites).values({
    tokenHash: tokenDigest(token),
    expiresAt: new Date(Date.now() + days * 86_400_000),
  });
  print(`Invite valid ${String(days)} days: /register?invite=${token}`);
}

/** The object storage of the configuration, for the backup commands. */
function storage(): { s3: S3Client; bucket: string } {
  const config = readConfig();
  return { s3: createS3Client(config), bucket: config.S3_BUCKET };
}

async function backupInfoCommand(database: Database): Promise<void> {
  const rows = await database.sql<{ count: string }[]>`
    select count(*)::text as count from drizzle.__drizzle_migrations`;
  print(
    JSON.stringify({
      // This file sits one level deeper than the modules the helper expects.
      version: readPackageVersion(new URL('../cli.js', import.meta.url).href),
      migrations: Number(rows[0]?.count ?? 0),
    }),
  );
}

async function exportObjectsCommand(): Promise<void> {
  const { s3, bucket } = storage();
  const summary = await exportObjects(s3, bucket, process.stdout);
  // Standard output carries the archive: the summary goes to standard error.
  process.stderr.write(`${JSON.stringify(summary)}\n`);
}

async function importObjectsCommand(): Promise<void> {
  const { s3, bucket } = storage();
  await ensureBucket(s3, bucket);
  const summary = await importObjects(s3, bucket, process.stdin);
  process.stderr.write(`${JSON.stringify(summary)}\n`);
}

async function fingerprintCommand(database: Database): Promise<void> {
  const { s3, bucket } = storage();
  print(JSON.stringify(await fingerprint(database.db, s3, bucket)));
}

const commands: Record<string, (database: Database, args: string[]) => Promise<void>> = {
  'create-user': createUserCommand,
  'reset-password': resetPasswordCommand,
  'create-invite': createInviteCommand,
  'backup-info': backupInfoCommand,
  'export-objects': exportObjectsCommand,
  'import-objects': importObjectsCommand,
  fingerprint: fingerprintCommand,
};

/** Operator commands, run inside the API container (see README). */
async function main(): Promise<void> {
  const [name, ...args] = process.argv.slice(2);
  const command = name === undefined ? undefined : commands[name];
  if (!command) {
    process.stderr.write(usage);
    process.exitCode = 2;
    return;
  }
  const database = createDatabase(readConfig().DATABASE_URL);
  try {
    await runMigrations(database);
    await command(database, args);
  } finally {
    await database.sql.end({ timeout: 5 });
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
