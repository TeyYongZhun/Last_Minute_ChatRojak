import { getDb } from '../index.js';

const DEFAULTS = {
  working_day_start: '09:00',
  working_day_end: '18:00',
  working_days: 'Mon,Tue,Wed,Thu,Fri',
  slot_granularity_minutes: 15,
  timezone: null,
};

const ALLOWED_DAYS = new Set(['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']);

function normaliseTimeOfDay(value, fallback) {
  if (typeof value !== 'string') return fallback;
  const m = value.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return fallback;
  const hh = Math.max(0, Math.min(23, parseInt(m[1], 10)));
  const mm = Math.max(0, Math.min(59, parseInt(m[2], 10)));
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

function normaliseDays(value, fallback) {
  if (typeof value !== 'string') return fallback;
  const parts = value
    .split(',')
    .map((s) => s.trim())
    .filter((s) => ALLOWED_DAYS.has(s));
  return parts.length ? parts.join(',') : fallback;
}

function normaliseGranularity(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(5, Math.min(120, Math.round(n)));
}

export function getPreferences(userId) {
  const db = getDb();
  const row = db
    .prepare('SELECT * FROM user_preferences WHERE user_id = ?')
    .get(userId);
  if (!row) {
    return { user_id: userId, ...DEFAULTS };
  }
  return {
    user_id: row.user_id,
    working_day_start: row.working_day_start,
    working_day_end: row.working_day_end,
    working_days: row.working_days,
    slot_granularity_minutes: row.slot_granularity_minutes,
    timezone: row.timezone || null,
  };
}

export function upsertPreferences(userId, patch = {}) {
  const db = getDb();
  const existing = getPreferences(userId);
  const next = {
    working_day_start: normaliseTimeOfDay(patch.working_day_start, existing.working_day_start),
    working_day_end: normaliseTimeOfDay(patch.working_day_end, existing.working_day_end),
    working_days: normaliseDays(patch.working_days, existing.working_days),
    slot_granularity_minutes: normaliseGranularity(patch.slot_granularity_minutes, existing.slot_granularity_minutes),
    timezone: typeof patch.timezone === 'string' ? patch.timezone.trim() || null : existing.timezone,
  };
  db.prepare(
    `INSERT INTO user_preferences (user_id, working_day_start, working_day_end, working_days,
       slot_granularity_minutes, timezone, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET
       working_day_start = excluded.working_day_start,
       working_day_end = excluded.working_day_end,
       working_days = excluded.working_days,
       slot_granularity_minutes = excluded.slot_granularity_minutes,
       timezone = excluded.timezone,
       updated_at = excluded.updated_at`
  ).run(
    userId,
    next.working_day_start,
    next.working_day_end,
    next.working_days,
    next.slot_granularity_minutes,
    next.timezone,
    Date.now()
  );
  return getPreferences(userId);
}
