import { describe, it, expect } from 'vitest';
import { createUser } from '../../src/db/repos/users.js';
import { insertTask } from '../../src/db/repos/tasks.js';
import { upsertReminder, listDueReminders } from '../../src/db/repos/reminders.js';
import { listRecent as listRecentNotifications } from '../../src/db/repos/notifications.js';
import { tick } from '../../src/scheduler.js';
import { createSession, getUserBySessionId, purgeExpiredSessions } from '../../src/db/repos/sessions.js';
import { getDb } from '../../src/db/index.js';

describe('scheduler tick', () => {
  it('fires a past-due reminder on a single tick and marks it fired', () => {
    const u = createUser('sched@x.y', 'hash');
    insertTask(u.id, {
      id: 't1',
      task: 'Demo',
      priority: 'high',
      confidence: 0.9,
      category: 'Academic',
      missing_fields: [],
      status: 'pending',
    });

    const now = new Date('2026-04-22T12:00:00Z');
    const past = new Date(now.getTime() - 60_000).toISOString();
    upsertReminder(u.id, {
      id: 'r-past',
      task_id: 't1',
      fire_at_iso: past,
      message: 'Due soon!',
    });

    expect(listDueReminders(now)).toHaveLength(1);

    tick(now);

    expect(listDueReminders(now)).toHaveLength(0);
    const notifs = listRecentNotifications(u.id, 10);
    expect(notifs).toHaveLength(1);
    expect(notifs[0].message).toBe('Due soon!');

    const db = getDb();
    const row = db.prepare('SELECT fired FROM reminders WHERE id = ?').get('r-past');
    expect(row.fired).toBe(1);
  });

  it('purges expired sessions during tick', () => {
    const u = createUser('exp@x.y', 'hash');
    const sid = createSession(u.id);

    const db = getDb();
    db.prepare('UPDATE sessions SET expires_at = ? WHERE id = ?').run(Date.now() - 1000, sid);

    expect(getUserBySessionId(sid)).toBeNull();
    const purged = purgeExpiredSessions();
    expect(purged).toBeGreaterThanOrEqual(1);
  });
});
