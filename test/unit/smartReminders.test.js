import { describe, it, expect } from 'vitest';
import { computeSchedule } from '../../src/modules/smartReminders.js';

const HOUR = 3_600_000;

describe('smartReminders.computeSchedule', () => {
  const now = new Date('2026-04-22T00:00:00Z');

  it('returns [] when no deadline', () => {
    expect(computeSchedule({ task: 'x' }, { decision: 'do_now' }, now)).toEqual([]);
  });

  it('schedules multiple offsets for complex do_now tasks', () => {
    const deadline = new Date(now.getTime() + 100 * HOUR).toISOString();
    const schedule = computeSchedule(
      { task: 'x', deadline_iso: deadline, complexity: 'complex' },
      { decision: 'do_now' },
      now
    );
    expect(schedule.length).toBeGreaterThan(2);
    const hours = schedule.map((s) => s.hours_before).sort((a, b) => b - a);
    expect(hours[0]).toBeGreaterThan(hours[hours.length - 1]);
  });

  it('schedules fewer offsets for simple tasks', () => {
    const deadline = new Date(now.getTime() + 10 * HOUR).toISOString();
    const schedule = computeSchedule(
      { task: 'x', deadline_iso: deadline, complexity: 'simple' },
      { decision: 'schedule' },
      now
    );
    expect(schedule.length).toBeLessThanOrEqual(1);
  });

  it('skips offsets that fall before now', () => {
    const deadline = new Date(now.getTime() + 2 * HOUR).toISOString();
    const schedule = computeSchedule(
      { task: 'x', deadline_iso: deadline, complexity: 'complex' },
      { decision: 'do_now' },
      now
    );
    for (const s of schedule) {
      expect(new Date(s.fire_at_iso).getTime()).toBeGreaterThan(now.getTime());
    }
  });
});
