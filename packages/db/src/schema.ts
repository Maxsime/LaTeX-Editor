import type { CompileOptions, CompileResult } from '@galley/shared';
import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  customType,
  index,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';

const citext = customType<{ data: string }>({ dataType: () => 'citext' });
const bytea = customType<{ data: Uint8Array; driverData: Uint8Array }>({
  dataType: () => 'bytea',
});
const timestamps = {
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
};

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: citext('email').notNull().unique(),
  username: citext('username').notNull().unique(),
  displayName: text('display_name').notNull(),
  passwordHash: text('password_hash').notNull(),
  isAdmin: boolean('is_admin').notNull().default(false),
  disabledAt: timestamp('disabled_at', { withTimezone: true }),
  ...timestamps,
});

export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** SHA-256 of the cookie token; the token itself is never stored. */
    tokenHash: text('token_hash').notNull().unique(),
    csrfToken: text('csrf_token').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    userAgent: text('user_agent'),
    ...timestamps,
  },
  (table) => [index('sessions_user_idx').on(table.userId)],
);

export const registrationInvites = pgTable('registration_invites', {
  id: uuid('id').primaryKey().defaultRandom(),
  tokenHash: text('token_hash').notNull().unique(),
  createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  usedAt: timestamp('used_at', { withTimezone: true }),
  usedBy: uuid('used_by').references(() => users.id, { onDelete: 'set null' }),
  ...timestamps,
});

export const projectType = pgEnum('project_type', ['document', 'texmf']);
export const engineEnum = pgEnum('engine', ['pdflatex', 'xelatex', 'lualatex']);
export const bibToolEnum = pgEnum('bib_tool', ['biber', 'bibtex']);
export const shellEscapeEnum = pgEnum('shell_escape', ['disabled', 'restricted', 'full']);
export const projectRoleEnum = pgEnum('project_role', ['owner', 'editor', 'reviewer', 'reader']);
export const fileKindEnum = pgEnum('file_kind', ['folder', 'text', 'binary']);

export const projects = pgTable(
  'projects',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    mainFileId: uuid('main_file_id').references((): AnyPgColumn => files.id, {
      onDelete: 'set null',
    }),
    engine: engineEnum('engine').notNull().default('pdflatex'),
    bibTool: bibToolEnum('bib_tool').notNull().default('biber'),
    shellEscape: shellEscapeEnum('shell_escape').notNull().default('restricted'),
    aiEnabled: boolean('ai_enabled').notNull().default(true),
    type: projectType('type').notNull().default('document'),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    ...timestamps,
  },
  (table) => [
    index('projects_owner_idx').on(table.ownerId),
    index('projects_deleted_idx')
      .on(table.deletedAt)
      .where(sql`${table.deletedAt} is not null`),
  ],
);

export const projectMembers = pgTable(
  'project_members',
  {
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: projectRoleEnum('role').notNull(),
    ...timestamps,
  },
  (table) => [
    primaryKey({ columns: [table.projectId, table.userId] }),
    index('project_members_user_idx').on(table.userId),
  ],
);

export const tags = pgTable(
  'tags',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    color: text('color').notNull(),
    ...timestamps,
  },
  (table) => [unique('tags_user_name_unique').on(table.userId, table.name)],
);

export const projectTags = pgTable(
  'project_tags',
  {
    tagId: uuid('tag_id')
      .notNull()
      .references(() => tags.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
  },
  (table) => [primaryKey({ columns: [table.tagId, table.projectId] })],
);

export const files = pgTable(
  'files',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    parentId: uuid('parent_id').references((): AnyPgColumn => files.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    kind: fileKindEnum('kind').notNull(),
    /** SHA-256 of the content for binary files; text content lives in `yjs_states`. */
    blobHash: text('blob_hash').references(() => blobs.hash),
    /** Content size in bytes at the last write, for display only. */
    size: bigint('size', { mode: 'number' }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    ...timestamps,
  },
  (table) => [
    unique('files_sibling_name_unique')
      .on(table.projectId, table.parentId, table.name)
      .nullsNotDistinct(),
    index('files_project_idx').on(table.projectId),
  ],
);

export const yjsStates = pgTable('yjs_states', {
  fileId: uuid('file_id')
    .primaryKey()
    .references(() => files.id, { onDelete: 'cascade' }),
  state: bytea('state').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const blobs = pgTable('blobs', {
  hash: text('hash').primaryKey(),
  size: bigint('size', { mode: 'number' }).notNull(),
  mimeType: text('mime_type').notNull(),
  ...timestamps,
});

export const compileStatusEnum = pgEnum('compile_status', [
  'queued',
  'running',
  'success',
  'failure',
  'timeout',
  'cancelled',
  'superseded',
  'error',
]);

/** One compilation request and, once a worker finished it, its result (SPEC §6.3). */
export const compileRuns = pgTable(
  'compile_runs',
  {
    id: uuid('id').primaryKey(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    status: compileStatusEnum('status').notNull().default('queued'),
    engine: engineEnum('engine').notNull(),
    mainFile: text('main_file').notNull(),
    options: jsonb('options').$type<CompileOptions>().notNull(),
    /** SHA-256 of the manifest, to tell whether two compilations saw the same sources. */
    manifestDigest: text('manifest_digest').notNull(),
    /** Worker result with diagnostics and published outputs; null until finished. */
    result: jsonb('result').$type<Omit<CompileResult, 'outcome'>>(),
    /** Machine reason of an `error` status, such as INVALID_JOB or LOST. */
    failureCode: text('failure_code'),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    ...timestamps,
  },
  (table) => [index('compile_runs_project_idx').on(table.projectId, table.createdAt)],
);
