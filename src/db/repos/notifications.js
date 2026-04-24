import { getDb } from '../index.js';

const MAX_PER_USER = 50;

export function addNotification(userId, { type, task_id, message, fired_at_iso }) {
  const db = getDb();
  db.prepare(
    `INSERT INTO notifications (user_id, type, task_id, message, fired_at_iso)
     VALUES (?, ?, ?, ?, ?)`
  ).run(userId, type, task_id || null, message, fired_at_iso);
  db.prepare(
    `DELETE FROM notifications WHERE user_id = ? AND id NOT IN (
       SELECT id FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT ?
     )`
  ).run(userId, userId, MAX_PER_USER);
}

export function listRecent(userId, limit = 10) {
  const db = getDb();
  return db
    .prepare(
      `SELECT type, task_id, message, fired_at_iso
       FROM notifications WHERE user_id = ?
       ORDER BY id DESC LIMIT ?`
    )
    .all(userId, limit);
}
