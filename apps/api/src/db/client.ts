import type { PgDatabase } from 'drizzle-orm/pg-core';
import {
  drizzle,
  type PostgresJsDatabase,
  type PostgresJsQueryResultHKT,
} from 'drizzle-orm/postgres-js';
import postgres, { type Sql } from 'postgres';
import * as schema from './schema.js';

export interface Database {
  sql: Sql;
  db: PostgresJsDatabase<typeof schema>;
}

/** Either the pool or an open transaction: query helpers accept both. */
export type Executor = PgDatabase<PostgresJsQueryResultHKT, typeof schema>;

/** Opens a PostgreSQL connection pool. Connections are established lazily. */
export function createDatabase(url: string): Database {
  const sql = postgres(url, {
    max: 10,
    // Connection errors surface through queries; keep the driver quiet otherwise.
    onnotice: () => undefined,
  });
  return { sql, db: drizzle(sql, { schema }) };
}
