import { getWeights, upsertWeights, resetWeights } from '../db/repos/adaptation.js';

const PRIORITY_LEVEL = { high: 3, medium: 2, low: 1 };
const ALPHA = 0.2;
const CLAMP = 0.25;
const COLD_START = 5;

function clamp(x, lo = -CLAMP, hi = CLAMP) {
  return Math.max(lo, Math.min(hi, x));
}

function attributeTrait(task) {
  const deadline = task?.deadline_iso ? new Date(task.deadline_iso) : null;
  const now = Date.now();
  if (deadline && !isNaN(deadline.getTime()) && deadline.getTime() - now < 24 * 3_600_000) {
    return 'urgency';
  }
  const assigner = (task?.assigned_by || '').toLowerCase();
  if (/(lecturer|prof|professor|teacher|boss|manager|tutor)/.test(assigner)) {
    return 'importance';
  }
  const words = String(task?.task || '').split(/\s+/).filter(Boolean).length;
  if (words > 12) return 'effort';
  return 'importance';
}

export function recordEdit(userId, { task, aiPriority, userPriority }) {
  const aiLevel = PRIORITY_LEVEL[aiPriority] ?? 2;
  const userLevel = PRIORITY_LEVEL[userPriority] ?? aiLevel;
  const delta = userLevel - aiLevel;
  if (delta === 0) return;

  const trait = attributeTrait(task);
  const current = getWeights(userId);
  const next = { ...current };

  if (trait === 'urgency') {
    next.urgency_bias = clamp(next.urgency_bias * (1 - ALPHA) + delta * ALPHA * 0.15);
  } else if (trait === 'importance') {
    next.importance_bias = clamp(next.importance_bias * (1 - ALPHA) + delta * ALPHA * 0.15);
  } else {
    next.effort_bias = clamp(next.effort_bias * (1 - ALPHA) + delta * ALPHA * 0.15);
  }

  next.sample_count = (current.sample_count || 0) + 1;
  upsertWeights(userId, next);
  return next;
}

export function shapeWeights(userId) {
  const w = getWeights(userId);
  if (!w.sample_count || w.sample_count < COLD_START) {
    return { urgency: 0, importance: 0, effort: 0, active: false, sample_count: w.sample_count };
  }
  return {
    urgency: w.urgency_bias,
    importance: w.importance_bias,
    effort: w.effort_bias,
    active: true,
    sample_count: w.sample_count,
  };
}

export function weightsSummary(userId) {
  const s = shapeWeights(userId);
  if (!s.active) return `User adaptation not active yet (${s.sample_count}/${COLD_START} samples).`;
  const parts = [];
  if (Math.abs(s.urgency) >= 0.02) parts.push(`urgency ${s.urgency >= 0 ? '+' : ''}${s.urgency.toFixed(2)}`);
  if (Math.abs(s.importance) >= 0.02) parts.push(`importance ${s.importance >= 0 ? '+' : ''}${s.importance.toFixed(2)}`);
  if (Math.abs(s.effort) >= 0.02) parts.push(`effort ${s.effort >= 0 ? '+' : ''}${s.effort.toFixed(2)}`);
  if (!parts.length) return 'User priorities align with defaults so far.';
  return `User priority bias: ${parts.join(', ')}.`;
}

export function reset(userId) {
  resetWeights(userId);
}

export { CLAMP, COLD_START };
