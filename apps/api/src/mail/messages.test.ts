import { mailJob } from '@galley/shared';
import { describe, expect, it } from 'vitest';
import { mentionMail, passwordResetMail, projectInviteMail } from './messages.js';

describe('mail messages', () => {
  it('builds a reset message in both languages around the link', () => {
    const mail = passwordResetMail({
      to: 'ada@example.org',
      displayName: 'Ada',
      link: 'https://galley.test/reset-password?token=abc',
    });
    expect(mailJob.parse(mail)).toEqual(mail);
    expect(mail.text).toContain('Bonjour Ada');
    expect(mail.text).toContain('Hello Ada');
    expect(mail.text.match(/reset-password\?token=abc/g)).toHaveLength(2);
    expect(mail.text).toContain('60');
  });

  it('names the inviter, project and role of an invitation', () => {
    const mail = projectInviteMail({
      to: 'bob@example.org',
      inviter: 'Ada',
      project: 'Thèse',
      role: 'reviewer',
      link: 'https://galley.test/projects',
    });
    expect(mail.subject).toContain('Thèse');
    expect(mail.text).toContain('en tant que relecteur');
    expect(mail.text).toContain('as reviewer');
  });

  it('flattens user text so it cannot fake lines of the message', () => {
    const mail = mentionMail({
      to: 'bob@example.org',
      author: 'Mallory\n\nhttps://evil.example/reset',
      project: 'P',
      comment: `@bob regarde\n\nici ${'x'.repeat(1_000)}`,
      link: 'https://galley.test/projects/1',
      settings: 'https://galley.test/account',
    });
    expect(mail.subject).not.toContain('\n');
    expect(mail.text).toContain('Mallory https://evil.example/reset vous a mentionné');
    expect(mail.text).toContain('@bob regarde ici x');
    // The excerpt is cut: 500 characters at most, ending with an ellipsis.
    const excerpt = mail.text.split('\n').find((line) => line.startsWith('  @bob')) ?? '';
    expect(excerpt.trim()).toHaveLength(500);
    expect(excerpt.endsWith('…')).toBe(true);
    expect(mail.text).toContain('https://galley.test/account');
  });
});
