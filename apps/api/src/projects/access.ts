import { ApiError, hasRole, type ProjectRole } from '@galley/shared';
import { and, eq } from 'drizzle-orm';
import type { Executor } from '../db/client.js';
import { projectMembers, projects } from '../db/schema.js';

export type ProjectRow = typeof projects.$inferSelect;

export interface ProjectAccess {
  project: ProjectRow;
  role: ProjectRole;
}

/**
 * Loads a project on behalf of a user and checks their role. A project the
 * user cannot see answers NOT_FOUND, never FORBIDDEN, so that its existence is
 * not revealed. Trashed projects are hidden unless `trashed` is allowed.
 */
export async function loadProject(
  db: Executor,
  projectId: string,
  userId: string,
  required: ProjectRole,
  options: { trashed?: boolean } = {},
): Promise<ProjectAccess> {
  const [row] = await db
    .select({ project: projects, role: projectMembers.role })
    .from(projects)
    .innerJoin(
      projectMembers,
      and(eq(projectMembers.projectId, projects.id), eq(projectMembers.userId, userId)),
    )
    .where(eq(projects.id, projectId))
    .limit(1);
  if (!row || (row.project.deletedAt !== null && options.trashed !== true)) {
    throw new ApiError('NOT_FOUND');
  }
  if (!hasRole(row.role, required)) {
    // Members know the project exists; telling them they lack the right is fine.
    throw new ApiError('FORBIDDEN');
  }
  return row;
}
