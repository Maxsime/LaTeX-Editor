import { projectChannel, type ProjectEvent, type ProjectEventMessage } from '@galley/shared';
import type { Redis } from 'ioredis';

/** Publishes an event after the change is committed; failures only cost a refresh. */
export async function publishProjectEvent(
  redis: Redis,
  projectId: string,
  event: ProjectEvent,
): Promise<void> {
  const message: ProjectEventMessage = { ...event, projectId };
  await redis.publish(projectChannel(projectId), JSON.stringify(message));
}
