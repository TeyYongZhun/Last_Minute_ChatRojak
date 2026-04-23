import { describe, it, expect } from 'vitest';
import { createUser } from '../../src/db/repos/users.js';
import { recordEdit, shapeWeights, reset } from '../../src/modules/adaptiveScoring.js';
import { getWeights } from '../../src/db/repos/adaptation.js';

function makeTask(partial = {}) {
  return {
    task: 'Short task',
    deadline_iso: new Date(Date.now() + 10 * 3_600_000).toISOString(),
    assigned_by: 'Classmate',
    ...partial,
  };
}

describe('adaptiveScoring', () => {
  it('suppresses bias during cold start', () => {
    const u = createUser(`cs${Math.random().toString(16).slice(2)}@x.y`, 'hash');
    recordEdit(u.id, { task: makeTask(), aiPriority: 'medium', userPriority: 'high' });
    const shaped = shapeWeights(u.id);
    expect(shaped.active).toBe(false);
  });

  it('activates after enough samples', () => {
    const u = createUser(`cs${Math.random().toString(16).slice(2)}@x.y`, 'hash');
    for (let i = 0; i < 6; i++) {
      recordEdit(u.id, { task: makeTask(), aiPriority: 'medium', userPriority: 'high' });
    }
    const shaped = shapeWeights(u.id);
    expect(shaped.active).toBe(true);
    expect(shaped.sample_count).toBeGreaterThanOrEqual(6);
  });

  it('clamps bias to ±0.25', () => {
    const u = createUser(`cs${Math.random().toString(16).slice(2)}@x.y`, 'hash');
    for (let i = 0; i < 200; i++) {
      recordEdit(u.id, { task: makeTask(), aiPriority: 'low', userPriority: 'high' });
    }
    const w = getWeights(u.id);
    const maxBias = Math.max(Math.abs(w.urgency_bias), Math.abs(w.importance_bias), Math.abs(w.effort_bias));
    expect(maxBias).toBeLessThanOrEqual(0.25 + 1e-9);
  });

  it('reset() clears weights', () => {
    const u = createUser(`cs${Math.random().toString(16).slice(2)}@x.y`, 'hash');
    for (let i = 0; i < 10; i++) {
      recordEdit(u.id, { task: makeTask(), aiPriority: 'medium', userPriority: 'high' });
    }
    reset(u.id);
    const w = getWeights(u.id);
    expect(w.sample_count).toBe(0);
  });

  it('is a no-op when user_priority equals ai_priority', () => {
    const u = createUser(`cs${Math.random().toString(16).slice(2)}@x.y`, 'hash');
    recordEdit(u.id, { task: makeTask(), aiPriority: 'medium', userPriority: 'medium' });
    const w = getWeights(u.id);
    expect(w.sample_count).toBe(0);
  });
});
