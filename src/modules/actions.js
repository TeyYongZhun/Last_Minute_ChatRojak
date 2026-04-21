import { emit } from './notifier.js';

const MAX_REMINDER_RETRIES = 5;

function ts(d = new Date()) {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function reminderId(taskId, fireAtIso) {
  return `r_${taskId}_${new Date(fireAtIso).getTime()}`;
}

function stepText(step) {
  if (typeof step === 'string') return step;
  if (step && typeof step === 'object' && typeof step.text === 'string') return step.text;
  return '';
}

export function generateActionsForPlan(state, plan, task, now) {
  state.actions ||= [];

  state.actions = state.actions.filter((a) => !(a.type === 'checklist' && a.task_id === task.id));
  const items = (plan.steps || [])
    .map((s) => ({ step: stepText(s), done: false }))
    .filter((i) => i.step.length);
  state.actions.push({
    type: 'checklist',
    task_id: task.id,
    items,
  });

  if (!task.deadline_iso) return;
  const deadline = new Date(task.deadline_iso);
  if (isNaN(deadline.getTime())) return;

  if (plan.decision !== 'defer' && plan.decision !== 'ask_user') {
    const calId = `c_${task.id}_${deadline.getTime()}`;
    if (!state.actions.some((a) => a.type === 'calendar_event' && a.id === calId)) {
      state.actions.push({
        type: 'calendar_event',
        id: calId,
        task_id: task.id,
        start_iso: deadline.toISOString(),
        title: task.task,
      });
    }
  }

  if (plan.decision !== 'do_now' && plan.decision !== 'schedule') return;
  const offsetsMs = [24 * 3_600_000, 1 * 3_600_000];
  for (const offset of offsetsMs) {
    const fireAt = new Date(deadline.getTime() - offset);
    if (fireAt.getTime() <= now.getTime()) continue;
    const id = reminderId(task.id, fireAt.toISOString());
    if (state.actions.some((a) => a.type === 'reminder' && a.id === id)) continue;
    const hoursBefore = Math.round(offset / 3_600_000);
    state.actions.push({
      type: 'reminder',
      id,
      task_id: task.id,
      fire_at_iso: fireAt.toISOString(),
      message: `Reminder: '${task.task}' due in ${hoursBefore}h`,
      fired: false,
      retry_count: 0,
    });
  }
}

export function pruneActionsForTask(state, taskId) {
  state.actions = (state.actions || []).filter((a) => a.task_id !== taskId);
}

export function sweepDueReminders(state, now) {
  const notifications = (state.notifications ||= []);
  const events = (state.replan_events ||= []);
  const taskStatus = Object.fromEntries((state.tasks || []).map((t) => [t.id, t.status]));
  let fired = 0;
  for (const a of state.actions || []) {
    if (a.type !== 'reminder' || a.fired) continue;
    if (new Date(a.fire_at_iso).getTime() > now.getTime()) continue;
    if (taskStatus[a.task_id] === 'done') continue;

    try {
      emit('reminder', { key: a.id, task_id: a.task_id, message: a.message });
      a.fired = true;
      notifications.push({
        type: 'reminder',
        task_id: a.task_id,
        message: a.message,
        fired_at_iso: now.toISOString(),
      });
      events.push(`[${ts(now)}] Reminder fired for ${a.task_id}: ${a.message}`);
      fired += 1;
    } catch (e) {
      a.retry_count = (a.retry_count || 0) + 1;
      if (a.retry_count >= MAX_REMINDER_RETRIES) {
        a.fired = true;
        notifications.push({
          type: 'delivery_failed',
          task_id: a.task_id,
          message: `Failed to deliver reminder after ${MAX_REMINDER_RETRIES} retries: ${a.message}`,
          fired_at_iso: now.toISOString(),
        });
        events.push(`[${ts(now)}] Reminder delivery failed for ${a.task_id} after ${MAX_REMINDER_RETRIES} retries`);
      }
    }
  }
  if (notifications.length > 50) {
    state.notifications = notifications.slice(-50);
  }
  return fired;
}

export function getChecklist(state, taskId) {
  const cl = (state.actions || []).find((a) => a.type === 'checklist' && a.task_id === taskId);
  return cl ? cl.items : [];
}

export function toggleChecklistItem(state, taskId, stepIndex) {
  const cl = (state.actions || []).find((a) => a.type === 'checklist' && a.task_id === taskId);
  if (!cl || !cl.items[stepIndex]) return false;
  cl.items[stepIndex].done = !cl.items[stepIndex].done;
  return true;
}
