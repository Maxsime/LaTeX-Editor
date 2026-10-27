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
  uniqueIndex,
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
    /** Every editor's changes are recorded as suggestions (SPEC §3.4). */
    trackChanges: boolean('track_changes').notNull().default(false),
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

/**
 * Invitation of an existing account to a project (SPEC §3.4), pending until
 * the invited user accepts or declines it, or the owner revokes it.
 */
export const projectInvites = pgTable(
  'project_invites',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: projectRoleEnum('role').notNull(),
    invitedBy: uuid('invited_by').references(() => users.id, { onDelete: 'set null' }),
    /** Set once answered or revoked; a pending invitation has neither. */
    closedAt: timestamp('closed_at', { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    index('project_invites_user_idx').on(table.userId),
    // At most one pending invitation per project and person.
    uniqueIndex('project_invites_pending_idx')
      .on(table.projectId, table.userId)
      .where(sql`${table.closedAt} is null`),
  ],
);

/** Revocable link that lets any signed-in user join a project with a role. */
export const projectLinks = pgTable(
  'project_links',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull().unique(),
    role: projectRoleEnum('role').notNull(),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    uses: bigint('uses', { mode: 'number' }).notNull().default(0),
    ...timestamps,
  },
  (table) => [index('project_links_project_idx').on(table.projectId)],
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

export const snapshotKindEnum = pgEnum('snapshot_kind', [
  'auto',
  'compile',
  'named',
  'restore',
  'git',
]);

/**
 * A recorded state of a project (SPEC §6.7): every file path with the SHA-256
 * of its content, plus the folders, so that empty ones survive a restore.
 */
export const snapshots = pgTable(
  'snapshots',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    kind: snapshotKindEnum('kind').notNull(),
    /** Name given by a user; named versions are kept forever. */
    label: text('label'),
    /** Users who changed the project since the previous snapshot. */
    authorIds: uuid('author_ids')
      .array()
      .notNull()
      .default(sql`'{}'::uuid[]`),
    manifest: jsonb('manifest').$type<Record<string, string>>().notNull(),
    folders: jsonb('folders').$type<string[]>().notNull(),
    /** SHA-256 of manifest and folders, to skip snapshots of an unchanged state. */
    digest: text('digest').notNull(),
    ...timestamps,
  },
  (table) => [index('snapshots_project_idx').on(table.projectId, table.createdAt)],
);

/** Who changed a project since its last snapshot; emptied by each snapshot. */
export const projectActivity = pgTable(
  'project_activity',
  {
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** First change since the last snapshot. */
    since: timestamp('since', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.projectId, table.userId] })],
);

/** Token a user creates to authenticate Git over HTTP (SPEC §3.5). */
export const personalAccessTokens = pgTable(
  'personal_access_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    tokenHash: text('token_hash').notNull().unique(),
    /** Last four characters, so that the user can tell tokens apart. */
    hint: text('hint').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    ...timestamps,
  },
  (table) => [index('personal_access_tokens_user_idx').on(table.userId)],
);

/** The last commit the Git bridge served for a project, and the state it holds. */
export const gitRepositories = pgTable('git_repositories', {
  projectId: uuid('project_id')
    .primaryKey()
    .references(() => projects.id, { onDelete: 'cascade' }),
  commit: text('commit').notNull(),
  /** Digest of the project state the commit was made from (see `snapshots.digest`). */
  digest: text('digest').notNull(),
  /** Git object id of each blob served or received, by SHA-256, to skip rehashing. */
  objects: jsonb('objects').$type<Record<string, string>>().notNull().default({}),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * A comment thread on a file (SPEC §3.4). Its anchor lives in the file's Yjs
 * document, under the thread's id; `quote` is the text it was attached to,
 * shown when the anchor is lost.
 */
export const commentThreads = pgTable(
  'comment_threads',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    fileId: uuid('file_id').references(() => files.id, { onDelete: 'set null' }),
    authorId: uuid('author_id').references(() => users.id, { onDelete: 'set null' }),
    quote: text('quote').notNull(),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    resolvedBy: uuid('resolved_by').references(() => users.id, { onDelete: 'set null' }),
    ...timestamps,
  },
  (table) => [index('comment_threads_project_idx').on(table.projectId, table.createdAt)],
);

export const comments = pgTable(
  'comments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    threadId: uuid('thread_id')
      .notNull()
      .references(() => commentThreads.id, { onDelete: 'cascade' }),
    authorId: uuid('author_id').references(() => users.id, { onDelete: 'set null' }),
    body: text('body').notNull(),
    editedAt: timestamp('edited_at', { withTimezone: true }),
    /** Deleted comments keep their place in the thread, without their body. */
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    ...timestamps,
  },
  (table) => [index('comments_thread_idx').on(table.threadId, table.createdAt)],
);

/** A member named with `@username` in a comment, until they open the thread. */
export const commentMentions = pgTable(
  'comment_mentions',
  {
    commentId: uuid('comment_id')
      .notNull()
      .references(() => comments.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    readAt: timestamp('read_at', { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    primaryKey({ columns: [table.commentId, table.userId] }),
    index('comment_mentions_unread_idx')
      .on(table.userId)
      .where(sql`${table.readAt} is null`),
  ],
);

/** The project's chat (SPEC §3.4). */
export const projectMessages = pgTable(
  'project_messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    authorId: uuid('author_id').references(() => users.id, { onDelete: 'set null' }),
    body: text('body').notNull(),
    ...timestamps,
  },
  (table) => [index('project_messages_project_idx').on(table.projectId, table.createdAt)],
);
