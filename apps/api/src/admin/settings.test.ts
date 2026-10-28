import { describe, expect, it } from 'vitest';
import { type EffectiveSettings, mergeSettings } from './settings.js';

const base: EffectiveSettings = {
  registrationMode: 'invite',
  quotas: { storageMb: null, compileMinutes: null },
  aiEnabled: true,
  aiDefault: null,
  aiAgentTokenBudget: 200_000,
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
    expect(mergeSettings(base, [{ key: 'aiAgentTokenBudget', value: 50_000 }])).toMatchObject({
      aiAgentTokenBudget: 50_000,
      overridden: ['aiAgentTokenBudget'],
    });
  });

  it('ignores unknown keys and values that no longer satisfy their schema', () => {
    const merged = mergeSettings(base, [
      { key: 'theme', value: 'dark' },
      { key: 'registrationMode', value: 'everyone' },
      { key: 'aiEnabled', value: 'yes' },
      { key: 'aiAgentTokenBudget', value: 5 },
    ]);
    expect(merged).toEqual(base);
  });
});
