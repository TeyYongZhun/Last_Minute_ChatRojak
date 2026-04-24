import '../src/load-env.js';
import { getDb } from '../src/db/index.js';
import { runMigrations } from '../src/db/migrate.js';
import { deleteEvent } from '../src/integrations/googleCalendar.js';

const DRY_RUN = !process.argv.includes('--delete');

async function main() {
  runMigrations({ silent: true });
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT ce.task_id AS task_id, ce.user_id AS user_id, ce.event_id AS event_id,
              t.deadline_iso AS deadline_iso, t.task AS task_title
       FROM calendar_events ce
       LEFT JOIN tasks t ON t.id = ce.task_id
       WHERE t.id IS NULL OR t.deadline_iso IS NULL`
    )
    .all();

  if (!rows.length) {
    console.log('No orphan calendar events found.');
    return;
  }

  console.log(`Found ${rows.length} orphan calendar event(s):`);
  for (const r of rows) {
    const missing = r.deadline_iso == null ? 'null_deadline' : 'task_missing';
    console.log(
      `  task=${r.task_id} user=${r.user_id} event=${r.event_id} reason=${missing}`
    );
  }

  if (DRY_RUN) {
    console.log('\nDry run — pass --delete to purge these events.');
    return;
  }

  let deleted = 0;
  let failed = 0;
  for (const r of rows) {
    try {
      const res = await deleteEvent(r.user_id, r.task_id);
      if (res?.deleted) deleted += 1;
      else if (res?.skipped) deleted += 1;
      else failed += 1;
    } catch (err) {
      console.error(`  failed task=${r.task_id}: ${err.message}`);
      failed += 1;
    }
  }
  console.log(`\nDeleted: ${deleted}, Failed: ${failed}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
