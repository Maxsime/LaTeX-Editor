import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres, { type Sql } from 'postgres';
import * as schema from './schema.js';

export interface Database {
  sql: Sql;
  db: PostgresJsDatabase<typeof schema>;
}

/** Opens a PostgreSQL connection pool. Connections are established lazily. */
export function createDatabase(url: string): Database {
  const sql = postgres(url, {
    max: 10,
    // Connection errors surface through queries; keep the driver quiet otherwise.
    onnotice: () => undefined,
  });
  return { sql, db: drizzle(sql, { schema }) };
}
