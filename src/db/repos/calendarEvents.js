import { getDb } from '../index.js';

export function getEventForTask(taskId) {
  const db = getDb();
  return db.prepare('SELECT * FROM calendar_events WHERE task_id = ?').get(taskId) || null;
}

export function upsertEvent(userId, { taskId, eventId, etag }) {
  const db = getDb();
  db.prepare(
    `INSERT INTO calendar_events (task_id, user_id, event_id, etag, last_synced, sync_state, attempts, last_error)
     VALUES (?, ?, ?, ?, ?, 'ok', 0, NULL)
     ON CONFLICT(task_id) DO UPDATE SET
       event_id = excluded.event_id,
       etag = excluded.etag,
       last_synced = excluded.last_synced,
       sync_state = 'ok',
       attempts = 0,
       last_error = NULL`
  ).run(taskId, userId, eventId, etag ?? null, Date.now());
}

export function markFailed(taskId, errorMessage) {
  const db = getDb();
  db.prepare(
    `UPDATE calendar_events SET sync_state = 'failed', attempts = attempts + 1, last_error = ?
     WHERE task_id = ?`
  ).run(String(errorMessage || '').slice(0, 500), taskId);
}

export function listFailed(limit = 20) {
  const db = getDb();
  return db
    .prepare(
      `SELECT task_id, user_id, event_id, attempts, last_error
       FROM calendar_events WHERE sync_state = 'failed' AND attempts < 5
       ORDER BY last_synced ASC LIMIT ?`
    )
    .all(limit);
}

export function deleteEventMapping(taskId) {
  const db = getDb();
  db.prepare('DELETE FROM calendar_events WHERE task_id = ?').run(taskId);
}

export function deleteAllForUser(userId) {
  const db = getDb();
  return db.prepare('DELETE FROM calendar_events WHERE user_id = ?').run(userId).changes;
}

export function listForUser(userId) {
  const db = getDb();
  return db.prepare('SELECT task_id, event_id, sync_state FROM calendar_events WHERE user_id = ?').all(userId);
}
