import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import type { Database } from '@galley/db';

/** Arbitrary constant identifying the migration lock among PostgreSQL advisory locks. */
const MIGRATION_LOCK_KEY = 7_265_830_141;

/** Versioned SQL migrations shipped next to `src/` and `dist/`. */
export const migrationsFolder = fileURLToPath(new URL('../../migrations', import.meta.url));

/**
 * Applies pending migrations. A session-level advisory lock serialises
 * concurrent starts, so two API instances never migrate the same schema at
 * the same time; the second one waits, then finds nothing left to apply.
 */
export async function runMigrations(
  { sql, db }: Database,
  folder = migrationsFolder,
): Promise<void> {
  const lock = await sql.reserve();
  try {
    await lock`select pg_advisory_lock(${MIGRATION_LOCK_KEY})`;
    await migrate(db, { migrationsFolder: folder });
  } finally {
    await lock`select pg_advisory_unlock(${MIGRATION_LOCK_KEY})`;
    lock.release();
  }
}
