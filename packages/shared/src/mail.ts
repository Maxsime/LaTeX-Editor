import * as z from 'zod/mini';
import { email } from './auth.js';

/** BullMQ queue carrying outgoing e-mail, sent by the API with retries. */
export const MAIL_QUEUE = 'mail';

/** Longest body of a message; notifications quote at most a short excerpt. */
export const MAX_MAIL_TEXT = 20_000;

/** One plain-text message, as queued. */
export const mailJob = z.object({
  to: email,
  subject: z.string().check(z.minLength(1), z.maxLength(300)),
  text: z.string().check(z.minLength(1), z.maxLength(MAX_MAIL_TEXT)),
});
export type MailJob = z.infer<typeof mailJob>;
