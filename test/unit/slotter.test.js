import { describe, it, expect } from 'vitest';
import { assignSlots, detectSlotOverlaps } from '../../src/modules/slotter.js';

const PREFS = {
  working_day_start: '09:00',
  working_day_end: '18:00',
  working_days: 'Mon,Tue,Wed,Thu,Fri',
  slot_granularity_minutes: 15,
  timezone: '+00:00',
};

function task(id, extras = {}) {
  return {
    id,
    task: `Task ${id}`,
    deadline: null,
    deadline_iso: null,
    assigned_by: null,
    priority: 'medium',
    confidence: 0.9,
    category: 'Academic',
    missing_fields: [],
    status: 'pending',
    user_duration_minutes: null,
    ai_duration_minutes: 60,
    ...extras,
  };
}

function plan(id, extras = {}) {
  return {
    task_id: id,
    priority_score: 70,
    decision: 'schedule',
    steps: [],
    conflicts: [],
    missing_info_questions: [],
    status: 'pending',
    ...extras,
  };
}

// 2026-04-27 is a Monday (UTC).
const MONDAY_0800_UTC = new Date('2026-04-27T08:00:00+00:00');

describe('slotter.assignSlots', () => {
  it('places tasks inside working hours starting from the window open time', () => {
    const tasks = [task('a', { ai_duration_minutes: 60 })];
    const plans = [plan('a')];
    const { slots, unplaceable } = assignSlots({
      tasks, plans, dependencies: [], prefs: PREFS, now: MONDAY_0800_UTC,
    });
    expect(unplaceable).toHaveLength(0);
    expect(slots).toHaveLength(1);
    expect(slots[0].planned_start_iso).toMatch(/^2026-04-27T09:00:00(Z|\+00:00)/);
    expect(slots[0].planned_end_iso).toMatch(/^2026-04-27T10:00:00(Z|\+00:00)/);
    expect(slots[0].origin).toBe('auto');
  });

  it('respects topological order when a dependency is present', () => {
    const tasks = [task('a', { ai_duration_minutes: 90 }), task('b', { ai_duration_minutes: 60 })];
    const plans = [plan('a'), plan('b')];
    const deps = [{ task_id: 'b', depends_on: 'a' }];
    const { slots } = assignSlots({ tasks, plans, dependencies: deps, prefs: PREFS, now: MONDAY_0800_UTC });
    const a = slots.find((s) => s.task_id === 'a');
    const b = slots.find((s) => s.task_id === 'b');
    expect(a).toBeTruthy();
    expect(b).toBeTruthy();
    expect(new Date(b.planned_start_iso).getTime()).toBeGreaterThanOrEqual(new Date(a.planned_end_iso).getTime());
  });

  it('pushes a task to the next working day when it would overflow the current day', () => {
    // Long task at 17:00 Monday with day ending 18:00 → must push to Tuesday 09:00.
    const start = new Date('2026-04-27T17:00:00+00:00');
    const tasks = [task('a', { ai_duration_minutes: 120 })];
    const plans = [plan('a')];
    const { slots } = assignSlots({ tasks, plans, dependencies: [], prefs: PREFS, now: start });
    expect(slots[0].planned_start_iso).toMatch(/^2026-04-28T09:00:00(Z|\+00:00)/);
  });

  it('skips Saturday and Sunday', () => {
    // Friday 17:00 with a 3-hour task → must land Monday 09:00.
    const fri = new Date('2026-04-24T17:00:00+00:00');
    const tasks = [task('a', { ai_duration_minutes: 180 })];
    const plans = [plan('a')];
    const { slots } = assignSlots({ tasks, plans, dependencies: [], prefs: PREFS, now: fri });
    expect(slots[0].planned_start_iso).toMatch(/^2026-04-27T09:00:00(Z|\+00:00)/);
  });

  it('marks unplaceable when the deadline is before any valid working window', () => {
    // Deadline in 15 minutes; task is 60 minutes; working hours 09:00–18:00.
    const deadline = new Date(MONDAY_0800_UTC.getTime() + 15 * 60 * 1000).toISOString();
    const tasks = [task('a', { ai_duration_minutes: 60, deadline_iso: deadline.replace('Z', '+00:00') })];
    const plans = [plan('a')];
    const { slots, unplaceable } = assignSlots({ tasks, plans, dependencies: [], prefs: PREFS, now: MONDAY_0800_UTC });
    expect(slots).toHaveLength(0);
    expect(unplaceable).toHaveLength(1);
    expect(unplaceable[0].task_id).toBe('a');
    expect(unplaceable[0].reason).toBe('deadline_too_close');
  });

  it('leaves ask_user and waiting tasks unslotted', () => {
    const tasks = [task('a'), task('b'), task('c')];
    const plans = [
      plan('a', { decision: 'ask_user' }),
      plan('b', { decision: 'waiting' }),
      plan('c', { decision: 'schedule' }),
    ];
    const { slots } = assignSlots({ tasks, plans, dependencies: [], prefs: PREFS, now: MONDAY_0800_UTC });
    expect(slots.map((s) => s.task_id)).toEqual(['c']);
  });

  it('preserves user-pinned slots and advances auto slots past them', () => {
    const pinnedStart = '2026-04-27T10:00:00+00:00';
    const pinnedEnd = '2026-04-27T11:00:00+00:00';
    const tasks = [task('pinned', { ai_duration_minutes: 60 }), task('auto', { ai_duration_minutes: 60 })];
    const plans = [
      plan('pinned', {
        slot_origin: 'user',
        planned_start_iso: pinnedStart,
        planned_end_iso: pinnedEnd,
      }),
      plan('auto'),
    ];
    const { slots } = assignSlots({ tasks, plans, dependencies: [], prefs: PREFS, now: MONDAY_0800_UTC });
    const pinned = slots.find((s) => s.task_id === 'pinned');
    const auto = slots.find((s) => s.task_id === 'auto');
    expect(pinned.origin).toBe('user');
    expect(pinned.planned_start_iso).toBe(pinnedStart);
    expect(pinned.planned_end_iso).toBe(pinnedEnd);
    expect(new Date(auto.planned_start_iso).getTime()).toBeGreaterThanOrEqual(new Date(pinnedEnd).getTime());
  });

  it('honours custom working-hour preferences', () => {
    const prefs = { ...PREFS, working_day_start: '08:00', working_day_end: '12:00' };
    const tasks = [task('a', { ai_duration_minutes: 60 })];
    const plans = [plan('a')];
    const { slots } = assignSlots({ tasks, plans, dependencies: [], prefs, now: MONDAY_0800_UTC });
    expect(slots[0].planned_start_iso).toMatch(/^2026-04-27T08:00:00(Z|\+00:00)/);
  });

  it('does not overlap sequential auto slots', () => {
    const tasks = [
      task('a', { ai_duration_minutes: 60 }),
      task('b', { ai_duration_minutes: 60 }),
      task('c', { ai_duration_minutes: 60 }),
    ];
    const plans = [plan('a'), plan('b'), plan('c')];
    const { slots } = assignSlots({ tasks, plans, dependencies: [], prefs: PREFS, now: MONDAY_0800_UTC });
    const overlaps = detectSlotOverlaps(
      slots.map((s) => ({ task_id: s.task_id, planned_start_iso: s.planned_start_iso, planned_end_iso: s.planned_end_iso }))
    );
    expect(overlaps).toHaveLength(0);
    expect(slots).toHaveLength(3);
  });
});

describe('slotter.detectSlotOverlaps', () => {
  it('flags intersecting planned blocks', () => {
    const overlaps = detectSlotOverlaps([
      { task_id: 'a', planned_start_iso: '2026-04-27T09:00:00+00:00', planned_end_iso: '2026-04-27T10:30:00+00:00' },
      { task_id: 'b', planned_start_iso: '2026-04-27T10:00:00+00:00', planned_end_iso: '2026-04-27T11:00:00+00:00' },
    ]);
    expect(overlaps).toHaveLength(1);
    expect(overlaps[0].kind).toBe('slot_overlap');
    expect(overlaps[0].ids.sort()).toEqual(['a', 'b']);
  });

  it('ignores adjacent blocks that merely touch', () => {
    const overlaps = detectSlotOverlaps([
      { task_id: 'a', planned_start_iso: '2026-04-27T09:00:00+00:00', planned_end_iso: '2026-04-27T10:00:00+00:00' },
      { task_id: 'b', planned_start_iso: '2026-04-27T10:00:00+00:00', planned_end_iso: '2026-04-27T11:00:00+00:00' },
    ]);
    expect(overlaps).toHaveLength(0);
  });
});
