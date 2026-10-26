import { type Executor, files, projects, yjsStates } from '@galley/db';
import { and, eq } from 'drizzle-orm';

/** Stored state of a text file, or `null` when the file is gone or no longer text. */
export async function loadFileState(
  db: Executor,
  fileId: string,
): Promise<{ projectId: string; state: Uint8Array | null } | null> {
  const [row] = await db
    .select({ projectId: files.projectId, state: yjsStates.state })
    .from(files)
    .leftJoin(yjsStates, eq(yjsStates.fileId, files.id))
    .where(and(eq(files.id, fileId), eq(files.kind, 'text')))
    .limit(1);
  return row ?? null;
}

/**
 * Writes the state of a text file and touches the file and its project.
 * Returns `false` without writing when the file was deleted or became binary
 * while open, so a late flush never resurrects content.
 */
export async function storeFileState(
  db: Executor,
  fileId: string,
  state: Uint8Array,
  size: number,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const now = new Date();
    const [file] = await tx
      .update(files)
      .set({ size, updatedAt: now })
      .where(and(eq(files.id, fileId), eq(files.kind, 'text')))
      .returning({ projectId: files.projectId });
    if (!file) return false;
    await tx
      .insert(yjsStates)
      .values({ fileId, state, updatedAt: now })
      .onConflictDoUpdate({ target: yjsStates.fileId, set: { state, updatedAt: now } });
    await tx.update(projects).set({ updatedAt: now }).where(eq(projects.id, file.projectId));
    return true;
  });
}
