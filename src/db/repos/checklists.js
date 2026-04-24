import { getDb } from '../index.js';

export function getChecklist(taskId) {
  const db = getDb();
  const rows = db
    .prepare(
      'SELECT step, done FROM checklist_items WHERE task_id = ? ORDER BY position ASC'
    )
    .all(taskId);
  return rows.map((r) => ({ step: r.step, done: !!r.done }));
}

export function replaceChecklist(taskId, steps) {
  const db = getDb();
  db.prepare('DELETE FROM checklist_items WHERE task_id = ?').run(taskId);
  const stmt = db.prepare(
    'INSERT INTO checklist_items (task_id, position, step, done) VALUES (?, ?, ?, 0)'
  );
  for (let i = 0; i < (steps || []).length; i++) {
    stmt.run(taskId, i, steps[i]);
  }
}

export function updateChecklistItemText(taskId, position, text) {
  const db = getDb();
  return db
    .prepare('UPDATE checklist_items SET step = ? WHERE task_id = ? AND position = ?')
    .run(String(text), taskId, position).changes;
}

export function toggleChecklistItem(taskId, position) {
  const db = getDb();
  const row = db
    .prepare('SELECT done FROM checklist_items WHERE task_id = ? AND position = ?')
    .get(taskId, position);
  if (!row) return false;
  db.prepare('UPDATE checklist_items SET done = ? WHERE task_id = ? AND position = ?').run(
    row.done ? 0 : 1,
    taskId,
    position
  );
  return true;
}
