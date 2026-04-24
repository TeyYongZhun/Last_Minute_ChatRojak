import { describe, it, expect } from 'vitest';
import {
  buildEventBody,
  isValidDeadlineIso,
  computeEndDateTime,
} from '../../src/integrations/googleCalendar.js';

function makeTask(overrides = {}) {
  return {
    id: 't1',
    task: 'Submit lab report',
    deadline_iso: '2026-05-01T10:00:00+08:00',
    ai_duration_minutes: null,
    user_duration_minutes: null,
    ...overrides,
  };
}

describe('isValidDeadlineIso', () => {
  it('accepts explicit-offset RFC 3339', () => {
    expect(isValidDeadlineIso('2026-05-01T10:00:00+08:00')).toBe(true);
    expect(isValidDeadlineIso('2026-05-01T10:00:00Z')).toBe(true);
    expect(isValidDeadlineIso('2026-05-01T10:00:00.123Z')).toBe(true);
    expect(isValidDeadlineIso('2026-05-01T10:00:00-05:30')).toBe(true);
  });

  it('rejects naive/offset-less strings', () => {
    expect(isValidDeadlineIso('2026-05-01T10:00:00')).toBe(false);
    expect(isValidDeadlineIso('2026-05-01')).toBe(false);
    expect(isValidDeadlineIso('not a date')).toBe(false);
    expect(isValidDeadlineIso(null)).toBe(false);
    expect(isValidDeadlineIso(undefined)).toBe(false);
    expect(isValidDeadlineIso(42)).toBe(false);
  });
});

describe('computeEndDateTime', () => {
  it('preserves +08:00 offset in end time', () => {
    const end = computeEndDateTime('2026-05-01T10:00:00+08:00', 30);
    expect(end).toMatch(/\+08:00$/);
    expect(end).toContain('10:30:00');
  });

  it('returns Z when input is Z', () => {
    const end = computeEndDateTime('2026-05-01T10:00:00Z', 60);
    expect(end).toMatch(/Z$/);
    expect(end).toContain('11:00:00');
  });

  it('preserves negative offset', () => {
    const end = computeEndDateTime('2026-05-01T10:00:00-05:30', 30);
    expect(end).toMatch(/-05:30$/);
  });
});

describe('buildEventBody — strict consistency', () => {
  it('summary equals task.task verbatim (whitespace, emoji, multibyte)', () => {
    const cases = [
      'Submit lab report',
      '  leading+trailing  ',
      'ナイト テスト',
      'emoji ✅ 🗓️ 🚀',
      'a'.repeat(1000),
    ];
    for (const title of cases) {
      const body = buildEventBody(makeTask({ task: title }), {}, new Date());
      expect(body.summary).toBe(title);
    }
  });

  it('start.dateTime === task.deadline_iso character-for-character', () => {
    const iso = '2026-05-01T10:00:00+08:00';
    const body = buildEventBody(makeTask({ deadline_iso: iso }), {}, new Date());
    expect(body.start.dateTime).toBe(iso);
    expect(body.start.timeZone).toBeUndefined();
  });

  it('end derives from start + duration (default 30 min)', () => {
    const body = buildEventBody(makeTask(), {}, new Date());
    expect(body.end.dateTime).toMatch(/\+08:00$/);
    expect(body.end.dateTime).toContain('10:30:00');
  });

  it('uses user_duration_minutes over ai_duration_minutes', () => {
    const body = buildEventBody(
      makeTask({ user_duration_minutes: 90, ai_duration_minutes: 45 }),
      {},
      new Date()
    );
    expect(body.end.dateTime).toContain('11:30:00');
  });

  it('uses ai_duration_minutes when user is null', () => {
    const body = buildEventBody(
      makeTask({ user_duration_minutes: null, ai_duration_minutes: 45 }),
      {},
      new Date()
    );
    expect(body.end.dateTime).toContain('10:45:00');
  });

  it('throws when deadline_iso is invalid (defensive)', () => {
    expect(() => buildEventBody(makeTask({ deadline_iso: null }), {}, new Date()))
      .toThrow(/valid RFC-3339/);
    expect(() => buildEventBody(makeTask({ deadline_iso: '2026-05-01T10:00:00' }), {}, new Date()))
      .toThrow(/valid RFC-3339/);
  });

  it('end - start equals duration_minutes * 60000 ms for representative durations', () => {
    for (const mins of [5, 60, 75, 1440]) {
      const body = buildEventBody(
        makeTask({ user_duration_minutes: mins, deadline_iso: '2026-05-01T10:00:00+08:00' }),
        {},
        new Date()
      );
      const deltaMs = new Date(body.end.dateTime).getTime() - new Date(body.start.dateTime).getTime();
      expect(deltaMs).toBe(mins * 60 * 1000);
    }
  });

  it('falls back to ai_duration_minutes when user override is null', () => {
    const body = buildEventBody(
      makeTask({ user_duration_minutes: null, ai_duration_minutes: 45 }),
      {},
      new Date()
    );
    const deltaMs = new Date(body.end.dateTime).getTime() - new Date(body.start.dateTime).getTime();
    expect(deltaMs).toBe(45 * 60 * 1000);
  });

  it('falls back to 30 min only when both durations are null', () => {
    const body = buildEventBody(makeTask({}), {}, new Date());
    const deltaMs = new Date(body.end.dateTime).getTime() - new Date(body.start.dateTime).getTime();
    expect(deltaMs).toBe(30 * 60 * 1000);
  });
});
