import { ApiError, type PublicUser } from '@galley/shared';
import { count, eq, or } from 'drizzle-orm';
import { type Executor, uniqueViolation, users } from '@galley/db';
import { ValidationError } from '../http/validate.js';
import { hashPassword } from './password.js';

export interface NewUser {
  email: string;
  username: string;
  displayName: string;
  password: string;
}

export function toPublicUser(row: typeof users.$inferSelect): PublicUser {
  return {
    id: row.id,
    email: row.email,
    username: row.username,
    displayName: row.displayName,
    isAdmin: row.isAdmin,
  };
}

export async function countUsers(db: Executor): Promise<number> {
  const [row] = await db.select({ value: count() }).from(users);
  return row?.value ?? 0;
}

/**
 * Creates an account. A duplicate e-mail or username is reported as a field
 * error rather than a conflict, so the form can point at the right input.
 */
export async function createUser(
  db: Executor,
  input: NewUser,
  isAdmin = false,
): Promise<PublicUser> {
  const lowered = input.password.toLowerCase();
  if (lowered === input.email.toLowerCase() || lowered === input.username.toLowerCase()) {
    throw new ValidationError([
      { path: 'password', messageKey: 'validation.password_matches_identity' },
    ]);
  }
  const passwordHash = await hashPassword(input.password);
  try {
    const [row] = await db
      .insert(users)
      .values({
        email: input.email,
        username: input.username,
        displayName: input.displayName.trim(),
        passwordHash,
        isAdmin,
      })
      .returning();
    if (!row) throw new ApiError('INTERNAL_ERROR');
    return toPublicUser(row);
  } catch (error) {
    const constraint = uniqueViolation(error);
    if (constraint?.includes('email')) {
      throw new ValidationError([{ path: 'email', messageKey: 'validation.email_taken' }]);
    }
    if (constraint?.includes('username')) {
      throw new ValidationError([{ path: 'username', messageKey: 'validation.username_taken' }]);
    }
    throw error;
  }
}

/** Finds an active account by e-mail address or username (both case-insensitive). */
export async function findUserByLogin(
  db: Executor,
  login: string,
): Promise<typeof users.$inferSelect | undefined> {
  const [row] = await db
    .select()
    .from(users)
    .where(or(eq(users.email, login), eq(users.username, login)))
    .limit(1);
  return row?.disabledAt === null ? row : undefined;
}
