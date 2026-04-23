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

import { validateRun } from '../../src/modules/validator.js';

describe('validator.validateRun (local fallback)', () => {
  it('flags missing deadline when not in missing_fields', async () => {
    const out = await validateRun({
      tasks: [
        { id: 't1', task: 'x', confidence: 0.9, category_bucket: 'Academic', missing_fields: [] },
      ],
      plans: [{ task_id: 't1', decision: 'schedule', steps: ['a'] }],
      dependencies: [],
    });
    const codes = out.issues.map((i) => i.code);
    expect(codes).toContain('missing_deadline');
  });

  it('flags bad bucket', async () => {
    const out = await validateRun({
      tasks: [
        {
          id: 't1',
          task: 'x',
          confidence: 0.9,
          category_bucket: 'NotABucket',
          missing_fields: ['deadline'],
        },
      ],
      plans: [{ task_id: 't1', decision: 'schedule', steps: ['a'] }],
      dependencies: [],
    });
    const codes = out.issues.map((i) => i.code);
    expect(codes).toContain('bad_bucket');
  });

  it('flags empty steps for do_now tasks', async () => {
    const out = await validateRun({
      tasks: [
        {
          id: 't1',
          task: 'x',
          confidence: 0.9,
          category_bucket: 'Academic',
          deadline_iso: '2030-01-01T00:00:00Z',
          missing_fields: [],
        },
      ],
      plans: [{ task_id: 't1', decision: 'do_now', steps: [] }],
      dependencies: [],
    });
    const codes = out.issues.map((i) => i.code);
    expect(codes).toContain('empty_do_now_steps');
  });

  it('accepts a clean task', async () => {
    const out = await validateRun({
      tasks: [
        {
          id: 't1',
          task: 'x',
          confidence: 0.9,
          category_bucket: 'Academic',
          deadline_iso: '2030-01-01T00:00:00Z',
          missing_fields: [],
        },
      ],
      plans: [{ task_id: 't1', decision: 'schedule', steps: ['a'] }],
      dependencies: [],
    });
    expect(out.issues).toEqual([]);
    expect(out.verdict).toBe('ok');
  });

  it('flags dangling dependencies', async () => {
    const out = await validateRun({
      tasks: [
        {
          id: 't1',
          task: 'x',
          confidence: 0.9,
          category_bucket: 'Academic',
          deadline_iso: '2030-01-01T00:00:00Z',
          missing_fields: [],
        },
      ],
      plans: [{ task_id: 't1', decision: 'schedule', steps: ['a'] }],
      dependencies: [{ task_id: 't1', depends_on: 'unknown' }],
    });
    const codes = out.issues.map((i) => i.code);
    expect(codes).toContain('dangling_dependency');
  });
});
