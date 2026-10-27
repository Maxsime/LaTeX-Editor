import {
  ApiError,
  SYNCTEX_TIMEOUT_MS,
  type SynctexJob,
  type SynctexResult,
  synctexResult,
} from '@galley/shared';
import type { Queue, QueueEvents } from 'bullmq';

/** Sends a SyncTeX query to the compiler workers and waits for the answer. */
export type SynctexClient = (job: SynctexJob) => Promise<SynctexResult>;

/**
 * Builds the client over the `synctex` queue. A query is cheap and only useful
 * now, so it is never retried and leaves nothing behind in Valkey.
 */
export function createSynctexClient(queue: Queue, events: QueueEvents): SynctexClient {
  return async (data) => {
    const job = await queue.add(data.kind, data, {
      attempts: 1,
      removeOnComplete: true,
      removeOnFail: true,
    });
    let value: unknown;
    try {
      value = await job.waitUntilFinished(events, SYNCTEX_TIMEOUT_MS);
    } catch {
      // No worker, a worker too busy, or a query it could not answer.
      throw new ApiError('SERVICE_UNAVAILABLE');
    }
    const parsed = synctexResult.safeParse(value);
    if (!parsed.success) throw new ApiError('SERVICE_UNAVAILABLE');
    return parsed.data;
  };
}
