import { describe, expect, it } from 'vitest';
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH, registerRequest, username } from './auth.js';

const valid = {
  email: 'ada@example.org',
  username: 'ada',
  displayName: 'Ada Lovelace',
  password: 'correct horse battery',
};

describe('password policy', () => {
  it('accepts a password within bounds', () => {
    expect(registerRequest.safeParse(valid).success).toBe(true);
  });

  it.each([PASSWORD_MIN_LENGTH - 1, PASSWORD_MAX_LENGTH + 1])('refuses %i characters', (length) => {
    const result = registerRequest.safeParse({ ...valid, password: 'x'.repeat(length) });
    expect(result.success).toBe(false);
  });
});

describe('username', () => {
  it.each(['ada', 'a.b-c_d', 'A1'])('accepts %j', (value) => {
    expect(username.safeParse(value).success).toBe(true);
  });

  it.each(['a', '-ada', 'ada lovelace', 'ada@home', 'x'.repeat(40)])('refuses %j', (value) => {
    expect(username.safeParse(value).success).toBe(false);
  });
});
