import { describe, it, expect } from 'vitest';
import { createUser } from '../../src/db/repos/users.js';
import { insertTask } from '../../src/db/repos/tasks.js';
import { upsertReminder, listDueReminders } from '../../src/db/repos/reminders.js';
import { listRecent as listRecentNotifications } from '../../src/db/repos/notifications.js';
import { sweepDueReminders } from '../../src/modules/actions.js';

function seedTaskAndReminder({ userEmail, reminderFireAtIso, reminderId = 'r1', taskId = 't1' }) {
  const user = createUser(userEmail, 'hash');
  insertTask(user.id, {
    id: taskId,
    task: 'Demo task',
    priority: 'high',
    confidence: 0.9,
    category: 'Academic',
    missing_fields: [],
    status: 'pending',
  });
  upsertReminder(user.id, {
    id: reminderId,
    task_id: taskId,
    fire_at_iso: reminderFireAtIso,
    message: 'Heads up!',
  });
  return user;
}

describe('sweepDueReminders', () => {
  it('fires only past-due reminders and marks them fired', () => {
    const now = new Date('2026-04-22T12:00:00Z');
    const past = new Date(now.getTime() - 5 * 60_000).toISOString();
    const future = new Date(now.getTime() + 5 * 60_000).toISOString();

    const user = seedTaskAndReminder({
      userEmail: 'a@b.c',
      reminderFireAtIso: past,
      reminderId: 'r-past',
    });
    upsertReminder(user.id, {
      id: 'r-future',
      task_id: 't1',
      fire_at_iso: future,
      message: 'Later',
    });

    const fired = sweepDueReminders(now);
    expect(fired).toBe(1);

    const notifs = listRecentNotifications(user.id, 10);
    expect(notifs).toHaveLength(1);
    expect(notifs[0].message).toBe('Heads up!');

    const stillDue = listDueReminders(now);
    expect(stillDue).toHaveLength(0);
  });

  it('is idempotent when called again with no new due reminders', () => {
    const now = new Date('2026-04-22T12:00:00Z');
    const past = new Date(now.getTime() - 60_000).toISOString();
    const user = seedTaskAndReminder({ userEmail: 'a@b.c', reminderFireAtIso: past });

    expect(sweepDueReminders(now)).toBe(1);
    expect(sweepDueReminders(now)).toBe(0);
    expect(listRecentNotifications(user.id, 10)).toHaveLength(1);
  });

  it('does not fire when nothing is due', () => {
    const now = new Date('2026-04-22T12:00:00Z');
    const future = new Date(now.getTime() + 3_600_000).toISOString();
    const user = seedTaskAndReminder({ userEmail: 'a@b.c', reminderFireAtIso: future });

    expect(sweepDueReminders(now)).toBe(0);
    expect(listRecentNotifications(user.id, 10)).toHaveLength(0);
  });
});
