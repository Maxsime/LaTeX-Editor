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

const usage = `Usage: admin <command> [options]

Commands:
  create-user --email <e-mail> --username <name> --name <display name> [--admin]
      Creates an account and prints a temporary password.
  reset-password <e-mail or username>
      Replaces the password with a temporary one, signs the account out everywhere.
  create-invite [--days <1-90>]
      Prints a registration invite token.
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

const commands: Record<string, (database: Database, args: string[]) => Promise<void>> = {
  'create-user': createUserCommand,
  'reset-password': resetPasswordCommand,
  'create-invite': createInviteCommand,
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
