import { describe, it, expect, vi } from 'vitest';

// Mock planTasks to skip the LLM call; we just want to verify the slotter pipeline.
vi.mock('../../src/modules/task2Planner.js', async (importOriginal) => {
  const real = await importOriginal();
  return {
    ...real,
    planTasks: vi.fn(async (tasks) => ({
      plans: tasks.map((t, i) => ({
        task_id: t.id,
        priority_score: 80 - i * 5,
        ai_priority_score: 80 - i * 5,
        user_adjusted_score: 80 - i * 5,
        decision: 'schedule',
        steps: [],
        conflicts: [],
        missing_info_questions: [],
        status: 'pending',
        ai_duration_minutes: t.ai_duration_minutes ?? 60,
      })),
      conflicts: [],
      dependencies: [],
    })),
  };
});

import { createUser } from '../../src/db/repos/users.js';
import { mergeNewTasks, replanAll, getDashboard } from '../../src/modules/task3Executor.js';
import { upsertPreferences } from '../../src/db/repos/userPreferences.js';

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

// 2026-04-27 (Monday), 08:00 UTC.
const NOW = new Date('2026-04-27T08:00:00Z');

describe('intelligent scheduling end-to-end', () => {
  it('writes planned_* fields on every schedulable task and surfaces them via getDashboard', async () => {
    const u = createUser('slot1@x.y', 'hash');
    upsertPreferences(u.id, { timezone: '+00:00' });

    mergeNewTasks(u.id, [
      baseTask({ id: 't1', task: 'First task', ai_duration_minutes: 60 }),
      baseTask({ id: 't2', task: 'Second task', ai_duration_minutes: 60 }),
    ]);

    await replanAll(u.id, NOW);

    const d = getDashboard(u.id);
    const all = [...d.do_now, ...d.schedule, ...d.defer, ...d.in_progress, ...d.need_info];
    const planned = all.filter((t) => t.planned_start_iso && t.planned_end_iso);
    expect(planned.length).toBeGreaterThanOrEqual(2);
    for (const item of planned) {
      expect(item.slot_origin).toBe('auto');
      const start = new Date(item.planned_start_iso);
      const end = new Date(item.planned_end_iso);
      expect(end.getTime()).toBeGreaterThan(start.getTime());
    }
    planned.sort((a, b) => new Date(a.planned_start_iso) - new Date(b.planned_start_iso));
    for (let i = 1; i < planned.length; i++) {
      expect(new Date(planned[i].planned_start_iso).getTime())
        .toBeGreaterThanOrEqual(new Date(planned[i - 1].planned_end_iso).getTime());
    }
  });

  it('reflects updated working hours on the next replan', async () => {
    const u = createUser('slot2@x.y', 'hash');
    upsertPreferences(u.id, { timezone: '+00:00', working_day_start: '09:00' });
    mergeNewTasks(u.id, [baseTask({ id: 't1', task: 'Only task', ai_duration_minutes: 30 })]);
    await replanAll(u.id, NOW);
    let d = getDashboard(u.id);
    let item = [...d.do_now, ...d.schedule, ...d.defer].find((t) => t.task_id === 't1');
    expect(item.planned_start_iso).toMatch(/T09:00:00/);

    upsertPreferences(u.id, { working_day_start: '08:00' });
    await replanAll(u.id, NOW);
    d = getDashboard(u.id);
    item = [...d.do_now, ...d.schedule, ...d.defer].find((t) => t.task_id === 't1');
    expect(item.planned_start_iso).toMatch(/T08:00:00/);
  });

  it('emits unplaceable conflicts when a task cannot fit before its deadline', async () => {
    const u = createUser('slot3@x.y', 'hash');
    upsertPreferences(u.id, { timezone: '+00:00' });
    // Deadline 15 minutes from NOW, duration 90 minutes.
    const deadline = new Date(NOW.getTime() + 15 * 60 * 1000).toISOString().replace('Z', '+00:00');
    mergeNewTasks(u.id, [baseTask({ id: 't1', task: 'Tight task', ai_duration_minutes: 90, deadline_iso: deadline })]);
    const { conflicts } = await replanAll(u.id, NOW);
    const unplaceable = conflicts.find((c) => c.kind === 'unplaceable');
    expect(unplaceable).toBeTruthy();
    expect(unplaceable.ids).toContain('t1');
  });
});
