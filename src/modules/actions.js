import { emit } from './notifier.js';
import { replaceChecklist, getChecklist } from '../db/repos/checklists.js';
import {
  upsertReminder,
  deleteRemindersForTask,
  listDueReminders,
  markReminderFired,
} from '../db/repos/reminders.js';
import { addNotification } from '../db/repos/notifications.js';
import { addReplanEvent } from '../db/repos/replanEvents.js';
import { getUserById } from '../db/repos/users.js';

function ts(d = new Date()) {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function reminderId(taskId, fireAtIso) {
  return `r_${taskId}_${new Date(fireAtIso).getTime()}`;
}

export function generateActionsForPlan(userId, plan, task, now) {
  replaceChecklist(task.id, plan.steps || []);

  if (plan.decision !== 'do_now' || !task.deadline_iso) return;
  const deadline = new Date(task.deadline_iso);
  if (isNaN(deadline.getTime())) return;

  const offsetsMs = [24 * 3_600_000, 1 * 3_600_000];
  for (const offset of offsetsMs) {
    const fireAt = new Date(deadline.getTime() - offset);
    if (fireAt.getTime() <= now.getTime()) continue;
    const id = reminderId(task.id, fireAt.toISOString());
    const hoursBefore = Math.round(offset / 3_600_000);
    upsertReminder(userId, {
      id,
      task_id: task.id,
      fire_at_iso: fireAt.toISOString(),
      message: `Reminder: '${task.task}' due in ${hoursBefore}h`,
    });
  }
}

export function pruneActionsForTask(taskId) {
  deleteRemindersForTask(taskId);
}

export function sweepDueReminders(now = new Date()) {
  const due = listDueReminders(now);
  let fired = 0;
  for (const r of due) {
    addNotification(r.user_id, {
      type: 'reminder',
      task_id: r.task_id,
      message: r.message,
      fired_at_iso: now.toISOString(),
    });
    addReplanEvent(r.user_id, `[${ts(now)}] Reminder fired for ${r.task_id}: ${r.message}`);
    markReminderFired(r.id, now.toISOString());
    emit('reminder', {
      user_id: r.user_id,
      key: r.id,
      task_id: r.task_id,
      message: r.message,
    });
    fired += 1;
  }
  return fired;
}

export function getChecklistForTask(taskId) {
  return getChecklist(taskId);
}

export { getUserById };
