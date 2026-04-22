import { describe, it, expect } from 'vitest';
import { createUser } from '../../src/db/repos/users.js';
import { mergeNewTasks, getDashboard } from '../../src/modules/task3Executor.js';
import { upsertPlan } from '../../src/db/repos/plans.js';

function baseTask(partial) {
  return {
    task: 'Some task',
    deadline: null,
    deadline_iso: null,
    assigned_by: null,
    priority: 'medium',
    confidence: 0.9,
    category: 'Academic',
    missing_fields: [],
    status: 'pending',
    tags: [],
    ...partial,
  };
}

function seedDashboardUser() {
  const u = createUser(`u${Math.random().toString(16).slice(2)}@x.y`, 'hash');
  mergeNewTasks(u.id, [
    baseTask({
      id: 't1',
      task: 'Submit assignment',
      priority: 'high',
      category: 'Academic',
      tags: ['urgent', 'solo'],
    }),
    baseTask({
      id: 't2',
      task: 'Help with lab report',
      priority: 'medium',
      category: 'Academic',
      tags: ['group-work', 'short'],
    }),
    baseTask({
      id: 't3',
      task: 'Buy groceries',
      priority: 'low',
      category: 'Errand',
      tags: ['short', 'solo'],
    }),
  ]);
  upsertPlan(u.id, { task_id: 't1', priority_score: 90, decision: 'do_now', steps: [], status: 'pending' });
  upsertPlan(u.id, { task_id: 't2', priority_score: 60, decision: 'schedule', steps: [], status: 'pending' });
  upsertPlan(u.id, { task_id: 't3', priority_score: 30, decision: 'defer', steps: [], status: 'pending' });
  return u;
}

function allItemIds(dash) {
  return [...dash.do_now, ...dash.schedule, ...dash.defer, ...dash.need_info, ...dash.in_progress, ...dash.done]
    .map((i) => i.task_id)
    .sort();
}

describe('getDashboard filters', () => {
  it('returns every task when no filters applied', () => {
    const u = seedDashboardUser();
    expect(allItemIds(getDashboard(u.id, {}))).toEqual(['t1', 't2', 't3']);
  });

  it('filters by category (case-insensitive)', () => {
    const u = seedDashboardUser();
    expect(allItemIds(getDashboard(u.id, { category: 'academic' }))).toEqual(['t1', 't2']);
    expect(allItemIds(getDashboard(u.id, { category: 'Errand' }))).toEqual(['t3']);
  });

  it('filters by priority', () => {
    const u = seedDashboardUser();
    expect(allItemIds(getDashboard(u.id, { priority: 'high' }))).toEqual(['t1']);
    expect(allItemIds(getDashboard(u.id, { priority: 'low' }))).toEqual(['t3']);
  });

  it('filters by tag with AND semantics across multiple tags', () => {
    const u = seedDashboardUser();
    expect(allItemIds(getDashboard(u.id, { tags: ['urgent'] }))).toEqual(['t1']);
    expect(allItemIds(getDashboard(u.id, { tags: ['short'] }))).toEqual(['t2', 't3']);
    expect(allItemIds(getDashboard(u.id, { tags: ['short', 'solo'] }))).toEqual(['t3']);
    expect(allItemIds(getDashboard(u.id, { tags: ['urgent', 'group-work'] }))).toEqual([]);
  });

  it('filters by substring search', () => {
    const u = seedDashboardUser();
    expect(allItemIds(getDashboard(u.id, { q: 'grocer' }))).toEqual(['t3']);
    expect(allItemIds(getDashboard(u.id, { q: 'assignment' }))).toEqual(['t1']);
  });

  it('returns available_tags with counts', () => {
    const u = seedDashboardUser();
    const dash = getDashboard(u.id, {});
    const byTag = Object.fromEntries(dash.available_tags.map((t) => [t.tag, t.count]));
    expect(byTag['short']).toBe(2);
    expect(byTag['solo']).toBe(2);
    expect(byTag['urgent']).toBe(1);
    expect(byTag['group-work']).toBe(1);
  });

  it('"active" status excludes done tasks', () => {
    const u = seedDashboardUser();
    const dash = getDashboard(u.id, { status: 'active' });
    expect(allItemIds(dash)).toEqual(['t1', 't2', 't3']);
  });
});
