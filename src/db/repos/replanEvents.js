import { getDb } from '../index.js';

const MAX_PER_USER = 100;

export function addReplanEvent(userId, event) {
  const db = getDb();
  db.prepare(
    'INSERT INTO replan_events (user_id, event, created_at) VALUES (?, ?, ?)'
  ).run(userId, event, Date.now());
  db.prepare(
    `DELETE FROM replan_events WHERE user_id = ? AND id NOT IN (
       SELECT id FROM replan_events WHERE user_id = ? ORDER BY id DESC LIMIT ?
     )`
  ).run(userId, userId, MAX_PER_USER);
}

export function listRecent(userId, limit = 15) {
  const db = getDb();
  return db
    .prepare(
      `SELECT event FROM replan_events WHERE user_id = ? ORDER BY id DESC LIMIT ?`
    )
    .all(userId, limit)
    .map((r) => r.event)
    .reverse();
}

export function hasEventContaining(userId, substr) {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT 1 FROM replan_events WHERE user_id = ? AND event LIKE ? LIMIT 1`
    )
    .get(userId, `%${substr}%`);
  return !!row;
}
