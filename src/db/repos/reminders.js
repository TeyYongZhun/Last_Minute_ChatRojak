import { getDb } from '../index.js';

export function upsertReminder(userId, reminder) {
  const db = getDb();
  const exists = db
    .prepare('SELECT 1 FROM reminders WHERE id = ?')
    .get(reminder.id);
  if (exists) return;
  db.prepare(
    `INSERT INTO reminders (id, user_id, task_id, fire_at_iso, message, fired, fired_at_iso)
     VALUES (?, ?, ?, ?, ?, 0, NULL)`
  ).run(reminder.id, userId, reminder.task_id, reminder.fire_at_iso, reminder.message);
}

export function deleteRemindersForTask(taskId) {
  const db = getDb();
  db.prepare('DELETE FROM reminders WHERE task_id = ?').run(taskId);
}

export function listDueReminders(now) {
  const db = getDb();
  const iso = now.toISOString();
  return db
    .prepare(
      'SELECT * FROM reminders WHERE fired = 0 AND fire_at_iso <= ? ORDER BY fire_at_iso ASC'
    )
    .all(iso);
}

export function markReminderFired(id, firedAtIso) {
  const db = getDb();
  db.prepare(
    'UPDATE reminders SET fired = 1, fired_at_iso = ? WHERE id = ?'
  ).run(firedAtIso, id);
}
