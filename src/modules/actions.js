import { emit } from '../modules/notifier.js';// import { something } from './notifier.js';
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
import { addTaskEvent } from '../db/repos/taskEvents.js';
import { computeSchedule } from './smartReminders.js';
import { upsertEvent as upsertCalendarEvent, deleteEvent as deleteCalendarEvent } from '../integrations/googleCalendar.js';
import { getTokens as getGoogleTokens } from '../db/repos/googleTokens.js';
<<<<<<< HEAD
import { createEvent } from '../services/googleCalendar.js';
=======
>>>>>>> 7f72f9074e2ba08e9e079365fde80d24705a9b3c

function ts(d = new Date()) {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function reminderId(taskId, fireAtIso) {
  return `r_${taskId}_${new Date(fireAtIso).getTime()}`;
}

export function generateActionsForPlan(userId, plan, task, now) {
  replaceChecklist(task.id, plan.steps || []);

  const shouldSyncCalendar = task.calendar_sync_enabled && getGoogleTokens(userId);

<<<<<<< HEAD
  const schedule = computeSchedule(task, plan, now);
  if (!schedule.length) return;

  for (const item of schedule) {
    const id = reminderId(task.id, item.fire_at_iso);
    upsertReminder(userId, {
      id,
      task_id: task.id,
      fire_at_iso: item.fire_at_iso,
      message: item.message,
    });
  }

  if (getGoogleTokens(userId)) {
=======
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
>>>>>>> 7f72f9074e2ba08e9e079365fde80d24705a9b3c
    upsertCalendarEvent(userId, task, plan, now)
      .catch((err) => console.error('[actions] calendar sync error:', err.message));
  }

  void (async () => {
    if (!task.deadline_iso) return;
    if (task.is_for_user !== true) return;
    if (task.calendar_link) return;
    try {
      const link = await createEvent(task.task, task.deadline_iso);
      if (!link) return;
      task.calendar_link = link;
      console.log('📅 Calendar event created:', link);
      addTaskEvent(userId, task.id, 'calendar_linked_minimal', { link });
    } catch (err) {
      console.error('[actions] minimal calendar event error:', err.message);
    }
  })();
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
