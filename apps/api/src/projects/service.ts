import {
  ApiError,
  type ListProjectsQuery,
  type ProjectDetails,
  type ProjectRole,
  type ProjectState,
  type ProjectSummary,
  spellLanguage,
} from '@galley/shared';
import {
  and,
  asc,
  desc,
  eq,
  exists,
  ilike,
  inArray,
  isNotNull,
  isNull,
  type SQL,
} from 'drizzle-orm';
import { type Executor, projectMembers, projects, projectTags, tags, users } from '@galley/db';
import type { ProjectRow } from './access.js';

function stateOf(row: ProjectRow): ProjectState {
  if (row.deletedAt !== null) return 'trashed';
  return row.archivedAt !== null ? 'archived' : 'active';
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}

/** Lists the projects a user is a member of, with their own tags. */
export async function listProjects(
  db: Executor,
  userId: string,
  query: ListProjectsQuery,
): Promise<ProjectSummary[]> {
  const filters: SQL[] = [];
  if (query.state === 'trashed') {
    filters.push(isNotNull(projects.deletedAt));
  } else {
    filters.push(isNull(projects.deletedAt));
    filters.push(
      query.state === 'archived' ? isNotNull(projects.archivedAt) : isNull(projects.archivedAt),
    );
  }
  if (query.search !== undefined && query.search.trim() !== '') {
    filters.push(ilike(projects.name, `%${escapeLike(query.search.trim())}%`));
  }
  if (query.tagId !== undefined) {
    filters.push(
      exists(
        db
          .select()
          .from(projectTags)
          .innerJoin(tags, eq(tags.id, projectTags.tagId))
          .where(
            and(
              eq(projectTags.projectId, projects.id),
              eq(projectTags.tagId, query.tagId),
              eq(tags.userId, userId),
            ),
          ),
      ),
    );
  }
  const column = {
    updatedAt: projects.updatedAt,
    createdAt: projects.createdAt,
    name: projects.name,
  }[query.sort];

  const rows = await db
    .select({
      project: projects,
      role: projectMembers.role,
      ownerName: users.displayName,
    })
    .from(projects)
    .innerJoin(
      projectMembers,
      and(eq(projectMembers.projectId, projects.id), eq(projectMembers.userId, userId)),
    )
    .innerJoin(users, eq(users.id, projects.ownerId))
    .where(and(...filters))
    .orderBy(query.order === 'asc' ? asc(column) : desc(column), asc(projects.id))
    .limit(1000);

  const tagIds = await tagsByProject(
    db,
    userId,
    rows.map((row) => row.project.id),
  );
  return rows.map((row) =>
    toSummary(row.project, row.role, row.ownerName, tagIds.get(row.project.id) ?? []),
  );
}

async function tagsByProject(
  db: Executor,
  userId: string,
  projectIds: string[],
): Promise<Map<string, string[]>> {
  const result = new Map<string, string[]>();
  if (projectIds.length === 0) return result;
  const rows = await db
    .select({ projectId: projectTags.projectId, tagId: projectTags.tagId })
    .from(projectTags)
    .innerJoin(tags, eq(tags.id, projectTags.tagId))
    .where(and(eq(tags.userId, userId), inArray(projectTags.projectId, projectIds)));
  for (const row of rows) {
    const list = result.get(row.projectId) ?? [];
    list.push(row.tagId);
    result.set(row.projectId, list);
  }
  return result;
}

export function toSummary(
  row: ProjectRow,
  role: ProjectRole,
  ownerName: string,
  tagIds: string[],
): ProjectSummary {
  return {
    id: row.id,
    name: row.name,
    role,
    owner: { id: row.ownerId, displayName: ownerName },
    state: stateOf(row),
    tagIds,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    trashedAt: row.deletedAt?.toISOString() ?? null,
  };
}

/** Full description of one project for a given member. */
export async function projectDetails(
  db: Executor,
  userId: string,
  row: ProjectRow,
  role: ProjectRole,
): Promise<ProjectDetails> {
  const [owner] = await db
    .select({ displayName: users.displayName })
    .from(users)
    .where(eq(users.id, row.ownerId));
  const tagIds = (await tagsByProject(db, userId, [row.id])).get(row.id) ?? [];
  return {
    ...toSummary(row, role, owner?.displayName ?? '', tagIds),
    mainFileId: row.mainFileId,
    engine: row.engine,
    bibTool: row.bibTool,
    shellEscape: row.shellEscape,
    trackChanges: row.trackChanges,
    citeKeyPattern: row.citeKeyPattern,
    // Stored as text so that a language can be added without a migration.
    spellLanguage: spellLanguage.safeParse(row.spellLanguage).data ?? 'auto',
    chktexDisabled: row.chktexDisabled,
  };
}

/** Creates an empty project owned by `ownerId`. Runs inside the caller's transaction. */
export async function insertProject(
  db: Executor,
  ownerId: string,
  name: string,
): Promise<ProjectRow> {
  const [row] = await db.insert(projects).values({ ownerId, name }).returning();
  if (!row) throw new ApiError('INTERNAL_ERROR');
  await db.insert(projectMembers).values({ projectId: row.id, userId: ownerId, role: 'owner' });
  return row;
}
