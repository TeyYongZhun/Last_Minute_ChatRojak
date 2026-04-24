ALTER TABLE plans ADD COLUMN planned_start_iso TEXT;
ALTER TABLE plans ADD COLUMN planned_end_iso   TEXT;
ALTER TABLE plans ADD COLUMN slot_origin       TEXT;
CREATE INDEX idx_plans_planned_start ON plans(user_id, planned_start_iso);

CREATE TABLE user_preferences (
  user_id                  TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  working_day_start        TEXT NOT NULL DEFAULT '09:00',
  working_day_end          TEXT NOT NULL DEFAULT '18:00',
  working_days             TEXT NOT NULL DEFAULT 'Mon,Tue,Wed,Thu,Fri',
  slot_granularity_minutes INTEGER NOT NULL DEFAULT 15,
  timezone                 TEXT,
  updated_at               INTEGER NOT NULL
);
