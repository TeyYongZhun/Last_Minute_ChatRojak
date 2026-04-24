import { getDb } from '../index.js';

function normalisePlan(row) {
  if (!row) return null;
  return {
    task_id: row.task_id,
    user_id: row.user_id,
    priority_score: row.priority_score,
    decision: row.decision,
    steps: JSON.parse(row.steps || '[]'),
    conflicts: JSON.parse(row.conflicts || '[]'),
    missing_info_questions: JSON.parse(row.missing_info_questions || '[]'),
    status: row.status,
    updated_at: row.updated_at,
    planned_start_iso: row.planned_start_iso || null,
    planned_end_iso: row.planned_end_iso || null,
    slot_origin: row.slot_origin || null,
  };
}

export function listPlans(userId) {
  const db = getDb();
  return db
    .prepare('SELECT * FROM plans WHERE user_id = ? ORDER BY priority_score DESC')
    .all(userId)
    .map(normalisePlan);
}

export function getPlan(userId, taskId) {
  const db = getDb();
  return normalisePlan(
    db.prepare('SELECT * FROM plans WHERE user_id = ? AND task_id = ?').get(userId, taskId)
  );
}

export function upsertPlan(userId, plan) {
  const db = getDb();
  db.prepare(
    `INSERT INTO plans (task_id, user_id, priority_score, decision, steps, conflicts,
       missing_info_questions, status, updated_at,
       planned_start_iso, planned_end_iso, slot_origin)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(task_id) DO UPDATE SET
       priority_score = excluded.priority_score,
       decision = excluded.decision,
       steps = excluded.steps,
       conflicts = excluded.conflicts,
       missing_info_questions = excluded.missing_info_questions,
       status = excluded.status,
       updated_at = excluded.updated_at,
       planned_start_iso = excluded.planned_start_iso,
       planned_end_iso = excluded.planned_end_iso,
       slot_origin = excluded.slot_origin`
  ).run(
    plan.task_id,
    userId,
    plan.priority_score,
    plan.decision,
    JSON.stringify(plan.steps || []),
    JSON.stringify(plan.conflicts || []),
    JSON.stringify(plan.missing_info_questions || []),
    plan.status || 'pending',
    Date.now(),
    plan.planned_start_iso || null,
    plan.planned_end_iso || null,
    plan.slot_origin || null
  );
}

export function updatePlanStatus(userId, taskId, status) {
  const db = getDb();
  return db
    .prepare('UPDATE plans SET status = ?, updated_at = ? WHERE user_id = ? AND task_id = ?')
    .run(status, Date.now(), userId, taskId).changes;
}

export function setPlanSlot(userId, taskId, { startIso, endIso, origin }) {
  const db = getDb();
  return db
    .prepare(
      `UPDATE plans
       SET planned_start_iso = ?, planned_end_iso = ?, slot_origin = ?, updated_at = ?
       WHERE user_id = ? AND task_id = ?`
    )
    .run(startIso || null, endIso || null, origin || null, Date.now(), userId, taskId).changes;
}

export function deletePlan(userId, taskId) {
  const db = getDb();
  db.prepare('DELETE FROM plans WHERE user_id = ? AND task_id = ?').run(userId, taskId);
}
