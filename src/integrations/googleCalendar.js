import { getTokens, saveTokens, updateAccessToken, deleteTokens } from '../db/repos/googleTokens.js';
import {
  getEventForTask,
  upsertEvent as upsertEventMapping,
  markFailed,
  deleteEventMapping,
  listFailed,
} from '../db/repos/calendarEvents.js';
import { computeSchedule } from '../modules/smartReminders.js';
import { addTaskEvent } from '../db/repos/taskEvents.js';

const SCOPE = 'https://www.googleapis.com/auth/calendar.events';
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const API_BASE = 'https://www.googleapis.com/calendar/v3';
const REFRESH_WINDOW_MS = 5 * 60 * 1000;

export function isConfigured() {
  return Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
}

export function buildAuthUrl(state) {
  if (!isConfigured()) throw new Error('Google OAuth is not configured (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET).');
  const redirectUri = process.env.GOOGLE_REDIRECT_URI || 'http://localhost:8000/api/google/auth/callback';
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: SCOPE,
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    state,
  });
  return `${AUTH_URL}?${params.toString()}`;
}

export async function exchangeCode(code) {
  const redirectUri = process.env.GOOGLE_REDIRECT_URI || 'http://localhost:8000/api/google/auth/callback';
  const body = new URLSearchParams({
    code,
    client_id: process.env.GOOGLE_CLIENT_ID,
    client_secret: process.env.GOOGLE_CLIENT_SECRET,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code',
  });
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(`Google token exchange failed: ${data.error_description || data.error || res.statusText}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

async function refreshAccessToken(userId, refreshToken) {
  const body = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID,
    client_secret: process.env.GOOGLE_CLIENT_SECRET,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  });
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    const err = new Error(`Google refresh failed: ${data.error_description || data.error || res.statusText}`);
    err.status = res.status;
    throw err;
  }
  const expiresAt = Date.now() + (data.expires_in || 3600) * 1000;
  updateAccessToken(userId, { accessToken: data.access_token, expiresAt });
  return { accessToken: data.access_token, expiresAt };
}

export async function getAccessToken(userId) {
  const row = getTokens(userId);
  if (!row) return null;
  if (row.expires_at - Date.now() > REFRESH_WINDOW_MS) return row.access_token;
  if (!row.refresh_token) return null;
  const refreshed = await refreshAccessToken(userId, row.refresh_token);
  return refreshed.accessToken;
}

export async function connectUserFromCode(userId, code) {
  const data = await exchangeCode(code);
  if (!data.access_token) throw new Error('Google returned no access_token');
  const expiresAt = Date.now() + (data.expires_in || 3600) * 1000;
  saveTokens(userId, {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt,
    scope: data.scope || SCOPE,
    calendarId: 'primary',
  });
  return { linked: true };
}

export function disconnect(userId) {
  deleteTokens(userId);
}

const OFFSET_SUFFIX_RE = /(Z|[+-]\d{2}:\d{2})$/;
const RFC3339_WITH_OFFSET_RE =
  /^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

export function isValidDeadlineIso(s) {
  if (typeof s !== 'string' || !RFC3339_WITH_OFFSET_RE.test(s)) return false;
  const d = new Date(s);
  return !Number.isNaN(d.getTime());
}

function resolveDurationMinutes(task) {
  const raw = task?.user_duration_minutes ?? task?.ai_duration_minutes ?? 30;
  const n = Math.round(Number(raw));
  if (!Number.isFinite(n)) return 30;
  return Math.max(5, Math.min(1440, n));
}

export function computeEndDateTime(startIso, durationMinutes) {
  const match = startIso.match(OFFSET_SUFFIX_RE);
  const offset = match ? match[1] : 'Z';
  const endEpoch = new Date(startIso).getTime() + durationMinutes * 60 * 1000;
  const asUtc = new Date(endEpoch).toISOString();
  if (offset === 'Z') return asUtc;
  const sign = offset[0] === '-' ? -1 : 1;
  const [hh, mm] = offset.slice(1).split(':').map(Number);
  const offsetMinutes = sign * (hh * 60 + mm);
  const shifted = new Date(endEpoch + offsetMinutes * 60 * 1000).toISOString();
  return shifted.replace(/Z$/, offset);
}

function buildEventBody(task, plan, now) {
  if (!isValidDeadlineIso(task.deadline_iso)) {
    throw new Error('buildEventBody: task.deadline_iso must be a valid RFC-3339 datetime with explicit offset');
  }
  const startIso = task.deadline_iso;
  const durationMinutes = resolveDurationMinutes(task);
  const endIso = computeEndDateTime(startIso, durationMinutes);

  const schedule = computeSchedule(task, plan, now);
  const overrides = schedule.map((s) => ({
    method: 'popup',
    minutes: Math.min(40320, Math.max(1, s.hours_before * 60)),
  }));
  const description = [
    task.assigned_by ? `Assigned by: ${task.assigned_by}` : null,
    plan?.decision ? `Decision: ${plan.decision}` : null,
    plan?.priority_score != null ? `Priority score: ${plan.priority_score}` : null,
    (plan?.steps || []).length ? `Steps:\n- ${plan.steps.join('\n- ')}` : null,
    task.category_bucket ? `Bucket: ${task.category_bucket}` : null,
  ]
    .filter(Boolean)
    .join('\n\n');

  return {
    summary: task.task,
    description,
    start: { dateTime: startIso },
    end: { dateTime: endIso },
    reminders: overrides.length ? { useDefault: false, overrides } : { useDefault: true },
  };
}

export { buildEventBody };

async function apiFetch(userId, method, path, body) {
  const token = await getAccessToken(userId);
  if (!token) {
    const e = new Error('Google Calendar not linked for user');
    e.code = 'NOT_LINKED';
    throw e;
  }
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(`Google Calendar ${method} ${path} failed: ${data.error?.message || res.statusText}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

export async function upsertEvent(userId, task, plan, now = new Date()) {
  const tokens = getTokens(userId);
  if (!tokens) return { skipped: true, reason: 'not_linked' };
  const calendarId = tokens.calendar_id || 'primary';

  if (task.deadline_iso == null) {
    const existing = getEventForTask(task.id);
    if (existing?.event_id) {
      try {
        await apiFetch(
          userId,
          'DELETE',
          `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(existing.event_id)}`
        );
      } catch (err) {
        if (err.status !== 404 && err.status !== 410) {
          addTaskEvent(userId, task.id, 'calendar_sync_failed', { error: err.message, action: 'delete_on_null_deadline' });
          return { skipped: true, reason: 'no_deadline', error: err.message };
        }
      }
      deleteEventMapping(task.id);
    }
    addTaskEvent(userId, task.id, 'calendar_sync_skipped', { reason: 'no_deadline' });
    return { skipped: true, reason: 'no_deadline' };
  }

  if (!isValidDeadlineIso(task.deadline_iso)) {
    addTaskEvent(userId, task.id, 'calendar_sync_skipped', {
      reason: 'invalid_deadline',
      value_len: String(task.deadline_iso).length,
    });
    return { skipped: true, reason: 'invalid_deadline' };
  }

  const body = buildEventBody(task, plan, now);
  const existing = getEventForTask(task.id);
  try {
    let result;
    if (existing?.event_id) {
      result = await apiFetch(
        userId,
        'PATCH',
        `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(existing.event_id)}`,
        body
      );
    } else {
      result = await apiFetch(userId, 'POST', `/calendars/${encodeURIComponent(calendarId)}/events`, body);
    }
    upsertEventMapping(userId, { taskId: task.id, eventId: result.id, etag: result.etag });
    addTaskEvent(userId, task.id, 'calendar_synced', { event_id: result.id, action: existing ? 'patch' : 'insert' });
    return { synced: true, event_id: result.id };
  } catch (err) {
    if (existing?.event_id) markFailed(task.id, err.message);
    else markFailed(task.id, err.message);
    addTaskEvent(userId, task.id, 'calendar_sync_failed', { error: err.message });
    return { synced: false, error: err.message };
  }
}

export async function deleteEvent(userId, taskId) {
  const tokens = getTokens(userId);
  if (!tokens) return { skipped: true };
  const existing = getEventForTask(taskId);
  if (!existing?.event_id) return { skipped: true };
  const calendarId = tokens.calendar_id || 'primary';
  try {
    await apiFetch(
      userId,
      'DELETE',
      `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(existing.event_id)}`
    );
    deleteEventMapping(taskId);
    return { deleted: true };
  } catch (err) {
    markFailed(taskId, `delete: ${err.message}`);
    return { deleted: false, error: err.message };
  }
}

export async function retryFailed() {
  const failed = listFailed();
  return failed;
}

export { SCOPE };
