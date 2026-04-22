CREATE TABLE users (
  id            TEXT PRIMARY KEY,
  email         TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at    INTEGER NOT NULL
);

CREATE TABLE sessions (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX idx_sessions_user ON sessions(user_id);
CREATE INDEX idx_sessions_expires ON sessions(expires_at);

CREATE TABLE telegram_links (
  user_id   TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  chat_id   TEXT UNIQUE NOT NULL,
  linked_at INTEGER NOT NULL
);

CREATE TABLE telegram_link_codes (
  code       TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
CREATE INDEX idx_link_codes_expires ON telegram_link_codes(expires_at);

CREATE TABLE tasks (
  id             TEXT PRIMARY KEY,
  user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  task           TEXT NOT NULL,
  deadline       TEXT,
  deadline_iso   TEXT,
  assigned_by    TEXT,
  priority       TEXT NOT NULL,
  confidence     REAL NOT NULL,
  category       TEXT NOT NULL,
  missing_fields TEXT NOT NULL DEFAULT '[]',
  status         TEXT NOT NULL DEFAULT 'pending',
  created_at     INTEGER NOT NULL
);
CREATE INDEX idx_tasks_user_status ON tasks(user_id, status);
CREATE INDEX idx_tasks_user_created ON tasks(user_id, created_at);

CREATE TABLE task_tags (
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  tag     TEXT NOT NULL,
  PRIMARY KEY (task_id, tag)
);
CREATE INDEX idx_task_tags_tag ON task_tags(tag);

CREATE TABLE plans (
  task_id                 TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
  user_id                 TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  priority_score          INTEGER NOT NULL,
  decision                TEXT NOT NULL,
  steps                   TEXT NOT NULL DEFAULT '[]',
  conflicts               TEXT NOT NULL DEFAULT '[]',
  missing_info_questions  TEXT NOT NULL DEFAULT '[]',
  status                  TEXT NOT NULL DEFAULT 'pending',
  updated_at              INTEGER NOT NULL
);
CREATE INDEX idx_plans_user ON plans(user_id);

CREATE TABLE checklist_items (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id  TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  step     TEXT NOT NULL,
  done     INTEGER NOT NULL DEFAULT 0,
  UNIQUE (task_id, position)
);
CREATE INDEX idx_checklist_task ON checklist_items(task_id);

CREATE TABLE reminders (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  task_id      TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  fire_at_iso  TEXT NOT NULL,
  message      TEXT NOT NULL,
  fired        INTEGER NOT NULL DEFAULT 0,
  fired_at_iso TEXT
);
CREATE INDEX idx_reminders_due ON reminders(fired, fire_at_iso);
CREATE INDEX idx_reminders_task ON reminders(task_id);

CREATE TABLE notifications (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type         TEXT NOT NULL,
  task_id      TEXT,
  message      TEXT NOT NULL,
  fired_at_iso TEXT NOT NULL
);
CREATE INDEX idx_notifications_user ON notifications(user_id, id DESC);

CREATE TABLE replan_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event      TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_replan_events_user ON replan_events(user_id, id DESC);

CREATE TABLE telegram_sent_keys (
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sent_key   TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, sent_key)
);

CREATE TABLE telegram_poll_cursor (
  id              INTEGER PRIMARY KEY CHECK (id = 1),
  last_update_id  INTEGER NOT NULL DEFAULT 0
);
INSERT INTO telegram_poll_cursor (id, last_update_id) VALUES (1, 0);

CREATE TABLE telegram_buffers (
  chat_id    TEXT NOT NULL,
  position   INTEGER NOT NULL,
  content    TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (chat_id, position)
);
