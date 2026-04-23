import { getDb } from '../index.js';

const DEFAULT = {
  urgency_bias: 0,
  importance_bias: 0,
  effort_bias: 0,
  sample_count: 0,
};

export function getWeights(userId) {
  const db = getDb();
  const row = db
    .prepare(
      'SELECT urgency_bias, importance_bias, effort_bias, sample_count, updated_at FROM adaptation_weights WHERE user_id = ?'
    )
    .get(userId);
  if (!row) return { ...DEFAULT, updated_at: null };
  return {
    urgency_bias: row.urgency_bias,
    importance_bias: row.importance_bias,
    effort_bias: row.effort_bias,
    sample_count: row.sample_count,
    updated_at: row.updated_at,
  };
}

export function upsertWeights(userId, w) {
  const db = getDb();
  db.prepare(
    `INSERT INTO adaptation_weights
       (user_id, urgency_bias, importance_bias, effort_bias, sample_count, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET
       urgency_bias = excluded.urgency_bias,
       importance_bias = excluded.importance_bias,
       effort_bias = excluded.effort_bias,
       sample_count = excluded.sample_count,
       updated_at = excluded.updated_at`
  ).run(
    userId,
    w.urgency_bias,
    w.importance_bias,
    w.effort_bias,
    w.sample_count,
    Date.now()
  );
}

export function resetWeights(userId) {
  const db = getDb();
  db.prepare('DELETE FROM adaptation_weights WHERE user_id = ?').run(userId);
}
