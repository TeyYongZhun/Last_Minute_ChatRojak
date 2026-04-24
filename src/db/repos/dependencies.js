import { getDb } from '../index.js';

export function listDependencies(userId) {
  const db = getDb();
  return db
    .prepare(
      'SELECT task_id, depends_on, reason, created_at FROM task_dependencies WHERE user_id = ? ORDER BY created_at ASC'
    )
    .all(userId);
}

export function getDependenciesFor(userId, taskId) {
  const db = getDb();
  return db
    .prepare(
      'SELECT depends_on, reason FROM task_dependencies WHERE user_id = ? AND task_id = ?'
    )
    .all(userId, taskId);
}

export function getDependentsOf(userId, taskId) {
  const db = getDb();
  return db
    .prepare(
      'SELECT task_id FROM task_dependencies WHERE user_id = ? AND depends_on = ?'
    )
    .all(userId, taskId)
    .map((r) => r.task_id);
}

export function addDependency(userId, taskId, dependsOn, reason = null) {
  if (taskId === dependsOn) {
    throw new Error('A task cannot depend on itself');
  }
  const db = getDb();
  db.prepare(
    `INSERT OR IGNORE INTO task_dependencies (task_id, depends_on, user_id, reason, created_at)
     VALUES (?, ?, ?, ?, ?)`
  ).run(taskId, dependsOn, userId, reason, Date.now());
}

export function removeDependency(userId, taskId, dependsOn) {
  const db = getDb();
  return db
    .prepare(
      'DELETE FROM task_dependencies WHERE user_id = ? AND task_id = ? AND depends_on = ?'
    )
    .run(userId, taskId, dependsOn).changes;
}

export function removeAllFor(taskId) {
  const db = getDb();
  db.prepare(
    'DELETE FROM task_dependencies WHERE task_id = ? OR depends_on = ?'
  ).run(taskId, taskId);
}
