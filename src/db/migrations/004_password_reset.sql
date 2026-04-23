CREATE TABLE password_reset_tokens (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  used_at     INTEGER,
  ip          TEXT,
  user_agent  TEXT
);
CREATE INDEX idx_prt_user_active ON password_reset_tokens(user_id, used_at, expires_at);
CREATE INDEX idx_prt_hash ON password_reset_tokens(token_hash);
CREATE INDEX idx_prt_expires ON password_reset_tokens(expires_at);
