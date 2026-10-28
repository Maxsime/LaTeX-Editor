import { ApiError, type Manifest } from '@galley/shared';
import { type Executor, projectMembers, projects, uniqueViolation } from '@galley/db';
import { and, eq, isNull } from 'drizzle-orm';
import type { AppContext } from '../context.js';
import { materializeProject } from '../materialize.js';
import type { ProjectRow } from './access.js';

async function findTexmf(db: Executor, ownerId: string): Promise<ProjectRow | null> {
  const [row] = await db
    .select()
    .from(projects)
    .where(and(eq(projects.ownerId, ownerId), eq(projects.type, 'texmf')))
    .limit(1);
  return row ?? null;
}

/**
 * Returns a person's texmf tree (SPEC §3.1), a project of type `texmf`
 * created on first request. Trashing it is undone here: the tree has no
 * place in the dashboard where it could be restored.
 */
export async function ensureTexmfProject(db: Executor, ownerId: string): Promise<ProjectRow> {
  const existing = await findTexmf(db, ownerId);
  if (existing) {
    if (existing.deletedAt === null && existing.archivedAt === null) return existing;
    const [restored] = await db
      .update(projects)
      .set({ deletedAt: null, archivedAt: null })
      .where(eq(projects.id, existing.id))
      .returning();
    return restored ?? existing;
  }
  try {
    return await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(projects)
        .values({ ownerId, name: 'texmf', type: 'texmf', aiEnabled: false })
        .returning();
      if (!row) throw new ApiError('INTERNAL_ERROR');
      await tx.insert(projectMembers).values({ projectId: row.id, userId: ownerId, role: 'owner' });
      return row;
    });
  } catch (error) {
    // Two first requests at once: the other one created it.
    if (uniqueViolation(error) === null) throw error;
    const created = await findTexmf(db, ownerId);
    if (!created) throw error;
    return created;
  }
}

/** Refuses operations meant for documents (compile, share, duplicate) on a texmf tree. */
export function requireDocument(project: ProjectRow): void {
  if (project.type !== 'document') {
    throw new ApiError('BAD_REQUEST', 'not available for a texmf tree');
  }
}

/**
 * The files of the project owner's texmf tree, mounted read-only as
 * `TEXMFHOME` for every compilation of their projects (the owner's tree
 * counts, whoever compiles).
 */
export async function texmfManifestOf(context: AppContext, ownerId: string): Promise<Manifest> {
  const [row] = await context.database.db
    .select({ id: projects.id })
    .from(projects)
    .where(
      and(eq(projects.ownerId, ownerId), eq(projects.type, 'texmf'), isNull(projects.deletedAt)),
    )
    .limit(1);
  if (!row) return {};
  return (await materializeProject(context, row.id)).manifest;
}
