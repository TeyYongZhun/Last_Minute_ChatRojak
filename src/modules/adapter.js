const VALID_PRIORITIES = new Set(['high', 'medium', 'low']);
const VALID_STATUSES = new Set(['pending', 'in_progress', 'blocked_waiting_info', 'done']);

function isIsoDate(s) {
  if (typeof s !== 'string') return false;
  const d = new Date(s);
  return !isNaN(d.getTime());
}

export function validateTask(raw) {
  const errors = [];
  if (!raw || typeof raw !== 'object') {
    errors.push('task must be an object');
    return { ok: false, errors };
  }
  if (!raw.id || typeof raw.id !== 'string') errors.push('id missing/invalid');
  if (!raw.task || typeof raw.task !== 'string') errors.push('task missing/invalid');
  if (raw.deadline_iso != null && !isIsoDate(raw.deadline_iso)) {
    errors.push('deadline_iso not a valid ISO date');
  }
  if (!VALID_PRIORITIES.has(raw.priority)) errors.push(`priority must be one of ${[...VALID_PRIORITIES].join('/')}`);
  if (typeof raw.confidence !== 'number') errors.push('confidence must be number');
  if (!Array.isArray(raw.missing_fields)) errors.push('missing_fields must be array');
  if (raw.status && !VALID_STATUSES.has(raw.status)) errors.push(`status invalid: ${raw.status}`);
  return { ok: errors.length === 0, errors };
}

export function buildPlanRequest(tasks, prevPlans, now) {
  const previousDecisions = {};
  for (const p of prevPlans || []) {
    if (p.task_id && p.decision) previousDecisions[p.task_id] = p.decision;
  }
  return {
    now_iso: now.toISOString(),
    tasks,
    context: {
      user_tz: '+08:00',
      open_task_count: tasks.length,
      previous_decisions: previousDecisions,
    },
  };
}

export function reconcileIds(newTasks, existingIds) {
  const taken = new Set(existingIds);
  let maxId = 0;
  for (const id of existingIds) {
    const m = /^t(\d+)$/.exec(id || '');
    if (m) maxId = Math.max(maxId, Number(m[1]));
  }
  for (const task of newTasks) {
    if (!task.id || taken.has(task.id)) {
      maxId += 1;
      task.id = `t${maxId}`;
    }
    taken.add(task.id);
  }
  return newTasks;
}
