import { describe, it, expect, vi } from 'vitest';

vi.mock('../../src/client.js', async (importOriginal) => {
  const real = await importOriginal();
  return {
    ...real,
    getClient: () => ({
      chat: {
        completions: {
          create: async () => {
            throw new Error('no network in tests');
          },
        },
      },
    }),
    withRetry: async (fn) => fn(),
  };
});

import { categorizeTasks, BUCKETS } from '../../src/modules/categorizer.js';

describe('categorizer (fallback heuristic)', () => {
  it('defaults to Others for a bare task', async () => {
    const out = await categorizeTasks([{ id: 't1', task: 'buy groceries', tags: [] }]);
    expect(out.degraded).toBe(true);
    expect(BUCKETS).toContain(out.categories.t1);
    expect(out.categories.t1).toBe('Others');
  });

  it('recognises academic keywords', async () => {
    const out = await categorizeTasks([{ id: 't1', task: 'submit assignment for CS2103', tags: [] }]);
    expect(out.categories.t1).toBe('Academic');
  });

  it('recognises co-curricular keywords', async () => {
    const out = await categorizeTasks([{ id: 't1', task: 'CCA rehearsal', tags: [] }]);
    expect(out.categories.t1).toBe('Co-curricular');
  });

  it('covers every input id in output', async () => {
    const out = await categorizeTasks([
      { id: 't1', task: 'read chapter 3', tags: [] },
      { id: 't2', task: 'pay rent', tags: [] },
      { id: 't3', task: 'club meeting', tags: [] },
    ]);
    expect(Object.keys(out.categories).sort()).toEqual(['t1', 't2', 't3']);
  });
});
