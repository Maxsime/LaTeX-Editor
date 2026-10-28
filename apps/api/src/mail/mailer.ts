import { MAIL_QUEUE, type MailJob, mailJob } from '@galley/shared';
import { Queue, Worker } from 'bullmq';
import type { FastifyBaseLogger } from 'fastify';
import type { Redis } from 'ioredis';
import { createTransport } from 'nodemailer';
import type { ApiConfig } from '../config.js';

/** Sends e-mail on behalf of the routes; absent when the instance has no SMTP server. */
export interface Mailer {
  /** Queues a message. Resolves once it is queued, not once it is delivered. */
  send(message: MailJob): Promise<void>;
}

/** Attempts per message: a mail server down for a few minutes loses nothing. */
const ATTEMPTS = 6;
/** First retry delay, doubled at each attempt (30 s … 16 min). */
const BACKOFF_MS = 30_000;

/**
 * Delivers one message through the configured SMTP server. A transport is
 * created per call: messages are rare, and a pooled connection would hold a
 * socket that the server closes after its idle timeout anyway.
 */
export async function deliver(
  config: Pick<ApiConfig, 'SMTP_URL' | 'SMTP_FROM'>,
  message: MailJob,
): Promise<void> {
  if (!config.SMTP_URL || !config.SMTP_FROM) throw new Error('SMTP is not configured');
  const transport = createTransport(config.SMTP_URL);
  try {
    await transport.sendMail({
      from: config.SMTP_FROM,
      to: message.to,
      subject: message.subject,
      text: message.text,
    });
  } finally {
    transport.close();
  }
}

/**
 * Starts the mail queue and its worker. Messages go through BullMQ so that a
 * request never waits for the mail server, and a failed delivery is retried
 * with exponential backoff. Null when `SMTP_URL` is empty.
 */
export function startMailer(
  config: ApiConfig,
  connection: Redis,
  logger: FastifyBaseLogger,
): { mailer: Mailer; close: () => Promise<void> } | null {
  if (!config.SMTP_URL) return null;
  const queue = new Queue<MailJob>(MAIL_QUEUE, { connection });
  const worker = new Worker<unknown, void>(
    MAIL_QUEUE,
    async (job) => {
      await deliver(config, mailJob.parse(job.data));
    },
    { connection, concurrency: 2 },
  );
  worker.on('failed', (job, error) => {
    // The message itself (recipient, text) stays out of the logs.
    logger.warn(
      { job: job?.id, attempt: job?.attemptsMade, reason: error.message.slice(0, 200) },
      'e-mail delivery failed',
    );
  });
  return {
    mailer: {
      async send(message) {
        await queue.add('send', mailJob.parse(message), {
          attempts: ATTEMPTS,
          backoff: { type: 'exponential', delay: BACKOFF_MS },
          removeOnComplete: true,
          removeOnFail: { age: 7 * 86_400 },
        });
      },
    },
    close: async () => {
      await worker.close();
      await queue.close();
    },
  };
}
