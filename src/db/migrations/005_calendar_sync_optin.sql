ALTER TABLE tasks ADD COLUMN calendar_sync_enabled INTEGER NOT NULL DEFAULT 0;

UPDATE tasks
SET calendar_sync_enabled = 1
WHERE id IN (SELECT task_id FROM calendar_events);

CREATE INDEX idx_tasks_calendar_sync ON tasks(user_id, calendar_sync_enabled);
