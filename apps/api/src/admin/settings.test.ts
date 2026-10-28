import { describe, expect, it } from 'vitest';
import { type EffectiveSettings, mergeSettings } from './settings.js';

const base: EffectiveSettings = {
  registrationMode: 'invite',
  quotas: { storageMb: null, compileMinutes: null },
  aiEnabled: true,
  aiDefault: null,
  overridden: [],
};

describe('mergeSettings', () => {
  it('lays stored values over the environment and names them', () => {
    const merged = mergeSettings(base, [
      { key: 'registrationMode', value: 'closed' },
      { key: 'quotas', value: { storageMb: 100, compileMinutes: null } },
    ]);
    expect(merged.registrationMode).toBe('closed');
    expect(merged.quotas.storageMb).toBe(100);
    expect(merged.aiEnabled).toBe(true);
    expect(merged.overridden).toEqual(['registrationMode', 'quotas']);
  });

  it('ignores unknown keys and values that no longer satisfy their schema', () => {
    const merged = mergeSettings(base, [
      { key: 'theme', value: 'dark' },
      { key: 'registrationMode', value: 'everyone' },
      { key: 'aiEnabled', value: 'yes' },
    ]);
    expect(merged).toEqual(base);
  });
});
