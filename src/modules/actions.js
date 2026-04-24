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
import { computeSchedule } from './smartReminders.js';
import { upsertEvent as upsertCalendarEvent, deleteEvent as deleteCalendarEvent } from '../integrations/googleCalendar.js';
import { getTokens as getGoogleTokens } from '../db/repos/googleTokens.js';

function ts(d = new Date()) {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function reminderId(taskId, fireAtIso) {
  return `r_${taskId}_${new Date(fireAtIso).getTime()}`;
}

export function generateActionsForPlan(userId, plan, task, now) {
  const seed = Array.isArray(plan.steps) ? plan.steps : [];
  if (seed.length && !getChecklist(task.id).length) {
    replaceChecklist(task.id, seed);
  }

  const shouldSyncCalendar = task.calendar_sync_enabled && getGoogleTokens(userId);

  if (plan.decision === 'waiting') {
    if (shouldSyncCalendar) {
      upsertCalendarEvent(userId, task, plan, now)
        .catch((err) => console.error('[actions] calendar sync error:', err.message));
    }
    return;
  }

  if (task.deadline_iso) {
    const schedule = computeSchedule(task, plan, now);
    for (const item of schedule) {
      const id = reminderId(task.id, item.fire_at_iso);
      upsertReminder(userId, {
        id,
        task_id: task.id,
        fire_at_iso: item.fire_at_iso,
        message: item.message,
      });
    }
  } else {
    deleteRemindersForTask(task.id);
  }

  if (shouldSyncCalendar) {
    upsertCalendarEvent(userId, task, plan, now)
      .catch((err) => console.error('[actions] calendar sync error:', err.message));
  }
}

export function pruneActionsForTask(taskId) {
  deleteRemindersForTask(taskId);
}

export async function removeCalendarEvent(userId, taskId) {
  if (!getGoogleTokens(userId)) return;
  try {
    await deleteCalendarEvent(userId, taskId);
  } catch (e) {
    console.error('[actions] removeCalendarEvent error:', e.message);
  }
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
