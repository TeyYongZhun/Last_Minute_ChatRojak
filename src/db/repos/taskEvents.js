import { getDb } from '../index.js';

const MAX_PER_TASK = 200;

export function addTaskEvent(userId, taskId, kind, payload = {}) {
  const db = getDb();
  db.prepare(
    `INSERT INTO task_events (user_id, task_id, kind, payload, created_at)
     VALUES (?, ?, ?, ?, ?)`
  ).run(userId, taskId, kind, JSON.stringify(payload || {}), Date.now());
  db.prepare(
    `DELETE FROM task_events WHERE task_id = ? AND id NOT IN (
       SELECT id FROM task_events WHERE task_id = ? ORDER BY id DESC LIMIT ?
     )`
  ).run(taskId, taskId, MAX_PER_TASK);
}

export function listTaskEvents(userId, taskId, limit = 50) {
  const db = getDb();
  return db
    .prepare(
      `SELECT id, kind, payload, created_at
       FROM task_events WHERE user_id = ? AND task_id = ?
       ORDER BY id DESC LIMIT ?`
    )
    .all(userId, taskId, limit)
    .map((r) => ({ id: r.id, kind: r.kind, payload: JSON.parse(r.payload || '{}'), created_at: r.created_at }))
    .reverse();
}

export function listRecentUserEvents(userId, limit = 100) {
  const db = getDb();
  return db
    .prepare(
      `SELECT id, task_id, kind, payload, created_at
       FROM task_events WHERE user_id = ?
       ORDER BY id DESC LIMIT ?`
    )
    .all(userId, limit)
    .map((r) => ({ id: r.id, task_id: r.task_id, kind: r.kind, payload: JSON.parse(r.payload || '{}'), created_at: r.created_at }));
}
