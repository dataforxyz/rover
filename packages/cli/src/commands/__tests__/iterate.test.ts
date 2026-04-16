import { describe, expect, it } from 'vitest';

import { getExpansionContextForModel } from '../iterate.js';

describe('getExpansionContextForModel', () => {
  it('returns the original context for models without trimming rules', () => {
    const previousContext = {
      iterationNumber: 2,
      plan: 'plan',
      changes: 'changes',
    };

    expect(getExpansionContextForModel(previousContext, 'codex', 'gpt-5.4')).toEqual(previousContext);
  });

  it('trims oversized plan and changes context for codex spark', () => {
    const plan = 'P'.repeat(14000);
    const changes = 'C'.repeat(10000);

    const trimmed = getExpansionContextForModel(
      { iterationNumber: 3, plan, changes },
      'codex',
      'gpt-5.3-codex-spark'
    );

    expect(trimmed.iterationNumber).toBe(3);
    expect(trimmed.plan).toContain('[trimmed previous plan; omitted');
    expect(trimmed.changes).toContain('[trimmed previous changes; omitted');
    expect(trimmed.plan?.length).toBeLessThanOrEqual(12000);
    expect(trimmed.changes?.length).toBeLessThanOrEqual(8000);
    expect(trimmed.plan?.startsWith('P')).toBe(true);
    expect(trimmed.plan?.endsWith('P')).toBe(true);
    expect(trimmed.changes?.startsWith('C')).toBe(true);
    expect(trimmed.changes?.endsWith('C')).toBe(true);
  });

  it('does not trim short spark context', () => {
    const previousContext = {
      iterationNumber: 1,
      plan: 'short plan',
      changes: 'short changes',
    };

    expect(
      getExpansionContextForModel(
        previousContext,
        'codex',
        'gpt-5.3-codex-spark'
      )
    ).toEqual(previousContext);
  });
});
