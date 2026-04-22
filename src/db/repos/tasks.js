import { getDb } from '../index.js';

function normaliseRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    user_id: row.user_id,
    task: row.task,
    deadline: row.deadline,
    deadline_iso: row.deadline_iso,
    assigned_by: row.assigned_by,
    priority: row.priority,
    confidence: row.confidence,
    category: row.category,
    missing_fields: JSON.parse(row.missing_fields || '[]'),
    status: row.status,
    created_at: row.created_at,
  };
}

export function listTasks(userId) {
  const db = getDb();
  const rows = db
    .prepare('SELECT * FROM tasks WHERE user_id = ? ORDER BY created_at ASC')
    .all(userId);
  return rows.map(normaliseRow);
}

export function listOpenTasks(userId) {
  const db = getDb();
  const rows = db
    .prepare(
      "SELECT * FROM tasks WHERE user_id = ? AND status != 'done' ORDER BY created_at ASC"
    )
    .all(userId);
  return rows.map(normaliseRow);
}

export function getTask(userId, taskId) {
  const db = getDb();
  return normaliseRow(
    db.prepare('SELECT * FROM tasks WHERE user_id = ? AND id = ?').get(userId, taskId)
  );
}

export function nextTaskId(userId) {
  const db = getDb();
  const rows = db.prepare('SELECT id FROM tasks WHERE user_id = ?').all(userId);
  let maxN = 0;
  for (const r of rows) {
    const m = /^t(\d+)$/.exec(r.id);
    if (m) maxN = Math.max(maxN, Number(m[1]));
  }
  return `t${maxN + 1}`;
}

export function countTasks(userId) {
  const db = getDb();
  return db.prepare('SELECT COUNT(*) AS n FROM tasks WHERE user_id = ?').get(userId).n;
}

export function insertTask(userId, task) {
  const db = getDb();
  db.prepare(
    `INSERT INTO tasks (id, user_id, task, deadline, deadline_iso, assigned_by,
       priority, confidence, category, missing_fields, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    task.id,
    userId,
    task.task,
    task.deadline ?? null,
    task.deadline_iso ?? null,
    task.assigned_by ?? null,
    task.priority || 'medium',
    typeof task.confidence === 'number' ? task.confidence : 0.8,
    task.category || 'Other',
    JSON.stringify(task.missing_fields || []),
    task.status || 'pending',
    Date.now()
  );
}

export function updateTaskStatus(userId, taskId, status) {
  const db = getDb();
  return db
    .prepare('UPDATE tasks SET status = ? WHERE user_id = ? AND id = ?')
    .run(status, userId, taskId).changes;
}

export function updateTaskField(userId, taskId, field, value) {
  if (!['deadline', 'deadline_iso', 'assigned_by', 'task'].includes(field)) {
    throw new Error(`updateTaskField: unsupported field '${field}'`);
  }
  const db = getDb();
  return db
    .prepare(`UPDATE tasks SET ${field} = ? WHERE user_id = ? AND id = ?`)
    .run(value, userId, taskId).changes;
}

export function updateTaskMissingFields(userId, taskId, missingFields) {
  const db = getDb();
  return db
    .prepare(
      'UPDATE tasks SET missing_fields = ? WHERE user_id = ? AND id = ?'
    )
    .run(JSON.stringify(missingFields || []), userId, taskId).changes;
}

export function setTaskTags(taskId, tags) {
  const db = getDb();
  db.prepare('DELETE FROM task_tags WHERE task_id = ?').run(taskId);
  const stmt = db.prepare('INSERT INTO task_tags (task_id, tag) VALUES (?, ?)');
  for (const tag of tags || []) stmt.run(taskId, tag);
}

export function getTagsForTask(taskId) {
  const db = getDb();
  return db
    .prepare('SELECT tag FROM task_tags WHERE task_id = ? ORDER BY tag')
    .all(taskId)
    .map((r) => r.tag);
}

export function getTagsForTasks(taskIds) {
  if (!taskIds.length) return {};
  const db = getDb();
  const placeholders = taskIds.map(() => '?').join(',');
  const rows = db
    .prepare(`SELECT task_id, tag FROM task_tags WHERE task_id IN (${placeholders})`)
    .all(...taskIds);
  const out = {};
  for (const r of rows) (out[r.task_id] ||= []).push(r.tag);
  return out;
}

export function listTagCounts(userId) {
  const db = getDb();
  return db
    .prepare(
      `SELECT tt.tag AS tag, COUNT(*) AS count
       FROM task_tags tt JOIN tasks t ON t.id = tt.task_id
       WHERE t.user_id = ?
       GROUP BY tt.tag
       ORDER BY count DESC, tag ASC`
    )
    .all(userId);
}

export function deleteAllForUser(userId) {
  const db = getDb();
  db.prepare('DELETE FROM tasks WHERE user_id = ?').run(userId);
}
