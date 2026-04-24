import { getDb } from '../index.js';

const VALID_BUCKETS = new Set(['Academic', 'Co-curricular', 'Others']);
const VALID_PRIORITIES = new Set(['high', 'medium', 'low']);
const VALID_QUADRANTS = new Set(['do', 'plan', 'quick', 'later']);

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
    ai_priority: row.ai_priority || row.priority,
    user_priority: row.user_priority || null,
    ai_priority_score: row.ai_priority_score ?? null,
    user_adjusted_score: row.user_adjusted_score ?? null,
    ai_eisenhower: row.ai_eisenhower || null,
    user_eisenhower: row.user_eisenhower || null,
    ai_duration_minutes: row.ai_duration_minutes ?? null,
    user_duration_minutes: row.user_duration_minutes ?? null,
    confidence: row.confidence,
    category: row.category,
    category_bucket: row.category_bucket || 'Others',
    complexity: row.complexity || null,
    missing_fields: JSON.parse(row.missing_fields || '[]'),
    status: row.status,
    created_at: row.created_at,
    updated_at: row.updated_at ?? row.created_at,
    completed_at: row.completed_at ?? null,
    calendar_sync_enabled: row.calendar_sync_enabled ? 1 : 0,
  };
}

export function setCalendarSyncEnabled(userId, taskId, enabled) {
  const db = getDb();
  return db
    .prepare(
      'UPDATE tasks SET calendar_sync_enabled = ?, updated_at = ? WHERE user_id = ? AND id = ?'
    )
    .run(enabled ? 1 : 0, Date.now(), userId, taskId).changes;
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

export function nextTaskId() {
  const db = getDb();
  const rows = db.prepare('SELECT id FROM tasks').all();
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
  const now = Date.now();
  const bucket = VALID_BUCKETS.has(task.category_bucket) ? task.category_bucket : 'Others';
  const priority = VALID_PRIORITIES.has(task.priority) ? task.priority : 'medium';
  const aiPriority = VALID_PRIORITIES.has(task.ai_priority) ? task.ai_priority : priority;

  const aiQuadrant = VALID_QUADRANTS.has(task.ai_eisenhower) ? task.ai_eisenhower : null;
  const aiDuration = task.ai_duration_minutes == null
    ? null
    : Math.max(5, Math.min(1440, Math.round(Number(task.ai_duration_minutes))));

  db.prepare(
    `INSERT INTO tasks (
       id, user_id, task, deadline, deadline_iso, assigned_by,
       priority, confidence, category, missing_fields, status, created_at,
       ai_priority, user_priority, ai_priority_score, user_adjusted_score,
       category_bucket, updated_at, completed_at, complexity,
       ai_eisenhower, user_eisenhower, ai_duration_minutes, user_duration_minutes
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    task.id,
    userId,
    task.task,
    task.deadline ?? null,
    task.deadline_iso ?? null,
    task.assigned_by ?? null,
    priority,
    typeof task.confidence === 'number' ? task.confidence : 0.8,
    task.category || bucket,
    JSON.stringify(task.missing_fields || []),
    task.status || 'pending',
    now,
    aiPriority,
    task.user_priority ?? null,
    task.ai_priority_score ?? null,
    task.user_adjusted_score ?? null,
    bucket,
    now,
    null,
    task.complexity ?? null,
    aiQuadrant,
    null,
    aiDuration,
    null
  );
}

function stampUpdated(userId, taskId) {
  const db = getDb();
  db.prepare('UPDATE tasks SET updated_at = ? WHERE user_id = ? AND id = ?').run(
    Date.now(),
    userId,
    taskId
  );
}

export function updateTaskStatus(userId, taskId, status) {
  const db = getDb();
  const changes = db
    .prepare('UPDATE tasks SET status = ?, updated_at = ? WHERE user_id = ? AND id = ?')
    .run(status, Date.now(), userId, taskId).changes;
  return changes;
}

export function markCompleted(userId, taskId) {
  const db = getDb();
  const now = Date.now();
  return db
    .prepare(
      "UPDATE tasks SET status = 'done', completed_at = ?, updated_at = ? WHERE user_id = ? AND id = ?"
    )
    .run(now, now, userId, taskId).changes;
}

export function updateTaskField(userId, taskId, field, value) {
  if (!['deadline', 'deadline_iso', 'assigned_by', 'task'].includes(field)) {
    throw new Error(`updateTaskField: unsupported field '${field}'`);
  }
  const db = getDb();
  const changes = db
    .prepare(`UPDATE tasks SET ${field} = ?, updated_at = ? WHERE user_id = ? AND id = ?`)
    .run(value, Date.now(), userId, taskId).changes;
  return changes;
}

export function updateTaskMissingFields(userId, taskId, missingFields) {
  const db = getDb();
  const changes = db
    .prepare(
      'UPDATE tasks SET missing_fields = ?, updated_at = ? WHERE user_id = ? AND id = ?'
    )
    .run(JSON.stringify(missingFields || []), Date.now(), userId, taskId).changes;
  return changes;
}

export function setUserPriority(userId, taskId, value) {
  if (value !== null && !VALID_PRIORITIES.has(value)) {
    throw new Error(`setUserPriority: invalid priority '${value}'`);
  }
  const db = getDb();
  return db
    .prepare(
      'UPDATE tasks SET user_priority = ?, updated_at = ? WHERE user_id = ? AND id = ?'
    )
    .run(value, Date.now(), userId, taskId).changes;
}

export function setCategoryBucket(userId, taskId, bucket) {
  if (!VALID_BUCKETS.has(bucket)) {
    throw new Error(`setCategoryBucket: invalid bucket '${bucket}'`);
  }
  const db = getDb();
  return db
    .prepare(
      'UPDATE tasks SET category_bucket = ?, updated_at = ? WHERE user_id = ? AND id = ?'
    )
    .run(bucket, Date.now(), userId, taskId).changes;
}

export function setComplexity(userId, taskId, complexity) {
  if (complexity && !['simple', 'moderate', 'complex'].includes(complexity)) {
    throw new Error(`setComplexity: invalid complexity '${complexity}'`);
  }
  const db = getDb();
  return db
    .prepare(
      'UPDATE tasks SET complexity = ?, updated_at = ? WHERE user_id = ? AND id = ?'
    )
    .run(complexity || null, Date.now(), userId, taskId).changes;
}

export function setPriorityScores(userId, taskId, { aiScore, userScore }) {
  const db = getDb();
  return db
    .prepare(
      'UPDATE tasks SET ai_priority_score = ?, user_adjusted_score = ?, updated_at = ? WHERE user_id = ? AND id = ?'
    )
    .run(aiScore ?? null, userScore ?? null, Date.now(), userId, taskId).changes;
}

export function setAiEisenhower(userId, taskId, quadrant) {
  if (quadrant && !VALID_QUADRANTS.has(quadrant)) {
    throw new Error(`setAiEisenhower: invalid quadrant '${quadrant}'`);
  }
  const db = getDb();
  return db
    .prepare(
      'UPDATE tasks SET ai_eisenhower = ?, updated_at = ? WHERE user_id = ? AND id = ?'
    )
    .run(quadrant || null, Date.now(), userId, taskId).changes;
}

export function setUserEisenhower(userId, taskId, quadrant) {
  if (quadrant !== null && !VALID_QUADRANTS.has(quadrant)) {
    throw new Error(`setUserEisenhower: invalid quadrant '${quadrant}'`);
  }
  const db = getDb();
  return db
    .prepare(
      'UPDATE tasks SET user_eisenhower = ?, updated_at = ? WHERE user_id = ? AND id = ?'
    )
    .run(quadrant, Date.now(), userId, taskId).changes;
}

export function setAiDurationMinutes(userId, taskId, minutes) {
  const m = minutes == null ? null : Math.max(5, Math.min(1440, Math.round(Number(minutes))));
  const db = getDb();
  return db
    .prepare(
      'UPDATE tasks SET ai_duration_minutes = ?, updated_at = ? WHERE user_id = ? AND id = ?'
    )
    .run(m, Date.now(), userId, taskId).changes;
}

export function setUserDurationMinutes(userId, taskId, minutes) {
  const m = minutes == null ? null : Math.max(5, Math.min(1440, Math.round(Number(minutes))));
  const db = getDb();
  return db
    .prepare(
      'UPDATE tasks SET user_duration_minutes = ?, updated_at = ? WHERE user_id = ? AND id = ?'
    )
    .run(m, Date.now(), userId, taskId).changes;
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

export function renameTaskCategory(userId, oldName, newName) {
  const db = getDb();
  return db
    .prepare('UPDATE tasks SET category = ?, updated_at = ? WHERE user_id = ? AND category = ?')
    .run(newName, Date.now(), userId, oldName).changes;
}
