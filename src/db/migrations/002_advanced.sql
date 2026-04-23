-- Advanced system design migration:
-- dual priority (AI + user), lifecycle timestamps, bucketed category,
-- complexity, per-task event log, task dependencies, adaptive weights,
-- Google Calendar linkage, and Telegram clarification threads.

-- 1. Tasks: dual priority, timeline, bucket category, complexity
ALTER TABLE tasks ADD COLUMN ai_priority TEXT;
ALTER TABLE tasks ADD COLUMN user_priority TEXT;
ALTER TABLE tasks ADD COLUMN ai_priority_score INTEGER;
ALTER TABLE tasks ADD COLUMN user_adjusted_score INTEGER;
ALTER TABLE tasks ADD COLUMN category_bucket TEXT;
ALTER TABLE tasks ADD COLUMN updated_at INTEGER;
ALTER TABLE tasks ADD COLUMN completed_at INTEGER;
ALTER TABLE tasks ADD COLUMN complexity TEXT;

-- Backfill existing rows
UPDATE tasks
SET ai_priority = priority,
    updated_at = created_at,
    category_bucket = CASE
      WHEN lower(category) LIKE '%academic%' OR lower(category) LIKE '%course%'
           OR lower(category) LIKE '%assignment%' OR lower(category) LIKE '%exam%'
        THEN 'Academic'
      WHEN lower(category) LIKE '%cca%' OR lower(category) LIKE '%club%'
           OR lower(category) LIKE '%sport%' OR lower(category) LIKE '%volunteer%'
        THEN 'Co-curricular'
      ELSE 'Others'
    END
WHERE ai_priority IS NULL;

-- 2. Per-task event log (richer timeline than replan_events)
CREATE TABLE task_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  task_id    TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL,
  payload    TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_task_events_task ON task_events(task_id, id DESC);
CREATE INDEX idx_task_events_user ON task_events(user_id, id DESC);

-- 3. Task dependencies (directed edges; task_id depends on depends_on)
CREATE TABLE task_dependencies (
  task_id    TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  depends_on TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reason     TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (task_id, depends_on),
  CHECK (task_id <> depends_on)
);
CREATE INDEX idx_deps_user ON task_dependencies(user_id);
CREATE INDEX idx_deps_depends_on ON task_dependencies(depends_on);

-- 4. Per-user scoring bias (adaptive learning)
CREATE TABLE adaptation_weights (
  user_id         TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  urgency_bias    REAL NOT NULL DEFAULT 0.0,
  importance_bias REAL NOT NULL DEFAULT 0.0,
  effort_bias     REAL NOT NULL DEFAULT 0.0,
  sample_count    INTEGER NOT NULL DEFAULT 0,
  updated_at      INTEGER NOT NULL
);

-- 5. Google Calendar: OAuth tokens + event mapping
CREATE TABLE google_oauth_tokens (
  user_id       TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  access_token  TEXT NOT NULL,
  refresh_token TEXT NOT NULL,
  expires_at    INTEGER NOT NULL,
  scope         TEXT NOT NULL,
  calendar_id   TEXT NOT NULL DEFAULT 'primary',
  linked_at     INTEGER NOT NULL
);

CREATE TABLE google_oauth_states (
  state      TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_google_oauth_states_user ON google_oauth_states(user_id);

CREATE TABLE calendar_events (
  task_id     TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_id    TEXT NOT NULL,
  etag        TEXT,
  last_synced INTEGER NOT NULL,
  sync_state  TEXT NOT NULL DEFAULT 'ok',
  last_error  TEXT,
  attempts    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_calendar_events_user ON calendar_events(user_id);
CREATE INDEX idx_calendar_events_sync ON calendar_events(sync_state);

-- 6. Telegram clarification threads (interactive Q&A state machine)
CREATE TABLE clarification_threads (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  task_id         TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  field           TEXT NOT NULL,
  question        TEXT NOT NULL,
  state           TEXT NOT NULL DEFAULT 'open',
  asked_at        INTEGER NOT NULL,
  answered_at     INTEGER,
  answer          TEXT,
  telegram_msg_id INTEGER,
  telegram_chat_id TEXT
);
CREATE INDEX idx_clar_user_state ON clarification_threads(user_id, state);
CREATE INDEX idx_clar_task ON clarification_threads(task_id);
CREATE INDEX idx_clar_msg ON clarification_threads(telegram_msg_id);
