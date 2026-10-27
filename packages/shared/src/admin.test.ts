import { describe, expect, it } from 'vitest';
import {
  adminUsersQuery,
  createUserRequest,
  updateInstanceSettingsRequest,
  updateUserRequest,
} from './admin.js';

describe('quotas', () => {
  it('accepts null as unlimited for the instance and refuses zero or negatives', () => {
    const parse = (quotas: unknown) => updateInstanceSettingsRequest.safeParse({ quotas }).success;
    expect(parse({ storageMb: null, compileMinutes: 600 })).toBe(true);
    expect(parse({ storageMb: 0, compileMinutes: null })).toBe(false);
    expect(parse({ storageMb: -1, compileMinutes: null })).toBe(false);
  });

  it('lets a person be unlimited with -1, and nothing below', () => {
    const parse = (quotas: unknown) => updateUserRequest.safeParse({ quotas }).success;
    expect(parse({ storageMb: -1, compileMinutes: null })).toBe(true);
    expect(parse({ storageMb: 0, compileMinutes: 0 })).toBe(true);
    expect(parse({ storageMb: -2, compileMinutes: null })).toBe(false);
    expect(parse({ storageMb: 1.5, compileMinutes: null })).toBe(false);
  });
});

describe('instance settings', () => {
  it('accepts an empty patch and a removal of the default model', () => {
    expect(updateInstanceSettingsRequest.safeParse({}).success).toBe(true);
    expect(updateInstanceSettingsRequest.safeParse({ aiDefault: null }).success).toBe(true);
  });

  it('refuses a non-HTTP model address', () => {
    const result = updateInstanceSettingsRequest.safeParse({
      aiDefault: {
        provider: 'openai-compatible',
        model: 'llama3.1',
        baseUrl: 'file:///etc/passwd',
        vision: null,
        contextTokens: null,
      },
    });
    expect(result.success).toBe(false);
  });
});

describe('users', () => {
  it('defaults new accounts to non-administrators', () => {
    const parsed = createUserRequest.parse({
      email: 'ada@example.org',
      username: 'ada',
      displayName: 'Ada',
    });
    expect(parsed.isAdmin).toBe(false);
  });

  it('coerces the page offset from the query string', () => {
    expect(adminUsersQuery.parse({ offset: '50' }).offset).toBe(50);
    expect(adminUsersQuery.parse({}).offset).toBe(0);
    expect(adminUsersQuery.safeParse({ offset: '-1' }).success).toBe(false);
  });
});
