import {
  projectChannel,
  projectDocumentName,
  projectEventMessage,
  type ProjectEventMessage,
} from '@galley/shared';
import type { Logger } from '@galley/shared/node';
import type { Redis } from 'ioredis';

/**
 * Relays the project events published by the API on Valkey to the browsers
 * connected to each project's event channel. Every collab instance subscribes
 * on its own, so the payload is delivered locally and never re-broadcast.
 *
 * @returns a function that stops the relay.
 */
export async function relayProjectEvents(
  subscriber: Redis,
  logger: Logger,
  deliver: (documentName: string, message: ProjectEventMessage) => void,
): Promise<() => Promise<void>> {
  const pattern = projectChannel('*');
  const onMessage = (_pattern: string, _channel: string, raw: string): void => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = undefined;
    }
    const result = projectEventMessage.safeParse(parsed);
    if (!result.success) {
      logger.warn('ignored malformed project event');
      return;
    }
    deliver(projectDocumentName(result.data.projectId), result.data);
  };
  subscriber.on('pmessage', onMessage);
  await subscriber.psubscribe(pattern);
  return async () => {
    subscriber.off('pmessage', onMessage);
    await subscriber.punsubscribe(pattern);
  };
}
