import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { runMigrations } from '../src/db/migrate.js';
import { hashPassword } from '../src/auth/passwords.js';
import { createUser, getUserByEmail } from '../src/db/repos/users.js';
import { getDb } from '../src/db/index.js';
import { insertTask, setTaskTags } from '../src/db/repos/tasks.js';
import { upsertPlan } from '../src/db/repos/plans.js';
import { replaceChecklist } from '../src/db/repos/checklists.js';
import { upsertReminder } from '../src/db/repos/reminders.js';
import { addNotification } from '../src/db/repos/notifications.js';
import { addReplanEvent } from '../src/db/repos/replanEvents.js';

async function main() {
  const jsonPath = process.argv[2] || path.join('state', 'tasks.json');
  const email = process.env.MIGRATE_EMAIL;
  const password = process.env.MIGRATE_PASSWORD;

  if (!email || !password) {
    console.error(
      'Usage: MIGRATE_EMAIL=you@example.com MIGRATE_PASSWORD=secret npm run migrate:json -- [path/to/tasks.json]'
    );
    process.exit(1);
  }
  if (!fs.existsSync(jsonPath)) {
    console.error(`No file at ${jsonPath}`);
    process.exit(1);
  }

  runMigrations();

  const raw = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
  let user = getUserByEmail(email);
  if (!user) {
    const hash = await hashPassword(password);
    user = createUser(email, hash);
    console.log(`Created user ${user.email}`);
  } else {
    console.log(`Using existing user ${user.email}`);
  }

  const db = getDb();
  const tx = db.transaction(() => {
    for (const task of raw.tasks || []) {
      insertTask(user.id, task);
      setTaskTags(task.id, task.tags || []);
    }
    for (const plan of raw.plans || []) upsertPlan(user.id, plan);
    for (const action of raw.actions || []) {
      if (action.type === 'checklist') {
        replaceChecklist(action.task_id, (action.items || []).map((i) => i.step));
      } else if (action.type === 'reminder') {
        upsertReminder(user.id, {
          id: action.id,
          task_id: action.task_id,
          fire_at_iso: action.fire_at_iso,
          message: action.message,
        });
      }
    }
    for (const n of raw.notifications || []) {
      addNotification(user.id, {
        type: n.type,
        task_id: n.task_id,
        message: n.message,
        fired_at_iso: n.fired_at_iso,
      });
    }
    for (const evt of raw.replan_events || []) addReplanEvent(user.id, evt);
  });
  tx();

  console.log(
    `Imported ${(raw.tasks || []).length} task(s), ${(raw.plans || []).length} plan(s) into ${user.email}`
  );
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
