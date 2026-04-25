import { getWeights, upsertWeights, resetWeights } from '../db/repos/adaptation.js';

const PRIORITY_LEVEL = { high: 3, medium: 2, low: 1 };
const ALPHA = 0.2;
const CLAMP = 0.25;
const DURATION_CLAMP = 0.5;
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

export function recordDurationAdjust(userId, { aiMinutes, userMinutes }) {
  if (!aiMinutes || !userMinutes || aiMinutes === userMinutes) return;
  const ratio = Math.log(userMinutes / aiMinutes);
  const delta = Math.max(-DURATION_CLAMP, Math.min(DURATION_CLAMP, ratio));
  const current = getWeights(userId);
  const next = { ...current };
  next.duration_bias = Math.max(
    -DURATION_CLAMP,
    Math.min(DURATION_CLAMP, (next.duration_bias || 0) * (1 - ALPHA) + delta * ALPHA)
  );
  next.sample_count = (current.sample_count || 0) + 1;
  upsertWeights(userId, next);
  return next;
}

const QUADRANT_BOOLS = { do: [1, 1], plan: [0, 1], quick: [1, 0], later: [0, 0] };

export function recordQuadrantAdjust(userId, { aiQuadrant, userQuadrant }) {
  if (!aiQuadrant || !userQuadrant || aiQuadrant === userQuadrant) return;
  const [au, ai] = QUADRANT_BOOLS[aiQuadrant] ?? [0, 0];
  const [uu, ui] = QUADRANT_BOOLS[userQuadrant] ?? [0, 0];
  const current = getWeights(userId);
  const next = { ...current };
  if (uu !== au) {
    next.quadrant_urgent_bias = clamp(
      (next.quadrant_urgent_bias || 0) * (1 - ALPHA) + (uu - au) * ALPHA * 0.15
    );
  }
  if (ui !== ai) {
    next.quadrant_important_bias = clamp(
      (next.quadrant_important_bias || 0) * (1 - ALPHA) + (ui - ai) * ALPHA * 0.15
    );
  }
  next.sample_count = (current.sample_count || 0) + 1;
  upsertWeights(userId, next);
  return next;
}

export function shapeWeights(userId) {
  const w = getWeights(userId);
  if (!w.sample_count || w.sample_count < COLD_START) {
    return {
      urgency: 0, importance: 0, effort: 0,
      duration: 0, quadrant_urgent: 0, quadrant_important: 0,
      active: false, sample_count: w.sample_count,
    };
  }
  return {
    urgency: w.urgency_bias,
    importance: w.importance_bias,
    effort: w.effort_bias,
    duration: w.duration_bias || 0,
    quadrant_urgent: w.quadrant_urgent_bias || 0,
    quadrant_important: w.quadrant_important_bias || 0,
    active: true,
    sample_count: w.sample_count,
  };
}

function fmtBias(label, value, fractionDigits = 2) {
  const sign = value >= 0 ? '+' : '';
  return `${label} ${sign}${value.toFixed(fractionDigits)}`;
}

export function weightsSummary(userId) {
  const s = shapeWeights(userId);
  if (!s.active) return `AI memory not active yet (${s.sample_count}/${COLD_START} samples).`;
  const parts = [];
  if (Math.abs(s.urgency) >= 0.02) parts.push(fmtBias('urgency', s.urgency));
  if (Math.abs(s.importance) >= 0.02) parts.push(fmtBias('importance', s.importance));
  if (Math.abs(s.effort) >= 0.02) parts.push(fmtBias('effort', s.effort));
  if (Math.abs(s.duration) >= 0.02) parts.push(fmtBias('duration', s.duration));
  if (Math.abs(s.quadrant_urgent) >= 0.02) parts.push(fmtBias('urgent-threshold', s.quadrant_urgent));
  if (Math.abs(s.quadrant_important) >= 0.02) parts.push(fmtBias('important-threshold', s.quadrant_important));
  if (!parts.length) return 'User memory aligns with defaults so far.';
  return `User bias memory: ${parts.join(', ')}.`;
}

export function reset(userId) {
  resetWeights(userId);
}

export { CLAMP, COLD_START };
