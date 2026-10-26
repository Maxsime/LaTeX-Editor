import type { Redis } from 'ioredis';

/** Changes other participants of a project must hear about (relayed by collab from J2 on). */
export type ProjectEvent =
  { type: 'tree.changed' } | { type: 'project.updated' } | { type: 'project.deleted' };

/** Channel carrying the events of one project. */
export function projectChannel(projectId: string): string {
  return `project:${projectId}`;
}

/** Publishes an event after the change is committed; failures only cost a refresh. */
export async function publishProjectEvent(
  redis: Redis,
  projectId: string,
  event: ProjectEvent,
): Promise<void> {
  await redis.publish(projectChannel(projectId), JSON.stringify({ ...event, projectId }));
}
