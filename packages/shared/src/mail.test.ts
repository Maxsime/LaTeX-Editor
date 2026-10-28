import { describe, expect, it } from 'vitest';
import { mailJob, MAX_MAIL_TEXT } from './mail.js';
import { passwordResetConfirm, passwordResetRequest } from './auth.js';
import { apiEnv } from './env.js';

describe('mailJob', () => {
  it('accepts a plain message and refuses an invalid recipient or an oversized body', () => {
    expect(mailJob.safeParse({ to: 'ada@example.org', subject: 'Hi', text: 'Body' }).success).toBe(
      true,
    );
    expect(mailJob.safeParse({ to: 'not an address', subject: 'Hi', text: 'Body' }).success).toBe(
      false,
    );
    expect(
      mailJob.safeParse({
        to: 'ada@example.org',
        subject: 'Hi',
        text: 'x'.repeat(MAX_MAIL_TEXT + 1),
      }).success,
    ).toBe(false);
  });
});

describe('password reset requests', () => {
  it('needs an address, then a token and a password long enough', () => {
    expect(passwordResetRequest.safeParse({ email: 'ada@example.org' }).success).toBe(true);
    expect(passwordResetRequest.safeParse({ email: 'ada' }).success).toBe(false);
    expect(passwordResetConfirm.safeParse({ token: 'abc', password: 'long enough!' }).success).toBe(
      true,
    );
    expect(passwordResetConfirm.safeParse({ token: 'abc', password: 'short' }).success).toBe(false);
  });
});

describe('SMTP configuration', () => {
  const base = {
    DATABASE_URL: 'postgres://u:p@localhost/db',
    VALKEY_URL: 'redis://localhost:6379',
    S3_ENDPOINT: 'http://localhost:8333',
    S3_ACCESS_KEY_ID: 'key',
    S3_SECRET_ACCESS_KEY: 'secret-key',
    S3_BUCKET: 'galley',
  };

  it('is optional, but needs a sender once a server is set', () => {
    expect(apiEnv.safeParse(base).success).toBe(true);
    expect(apiEnv.safeParse({ ...base, SMTP_URL: '', SMTP_FROM: '' }).success).toBe(true);
    expect(apiEnv.safeParse({ ...base, SMTP_URL: 'smtp://mail:25' }).success).toBe(false);
    expect(
      apiEnv.safeParse({ ...base, SMTP_URL: 'smtps://mail:465', SMTP_FROM: 'Galley <g@x.org>' })
        .success,
    ).toBe(true);
    expect(
      apiEnv.safeParse({ ...base, SMTP_URL: 'http://mail', SMTP_FROM: 'g@x.org' }).success,
    ).toBe(false);
  });
});
