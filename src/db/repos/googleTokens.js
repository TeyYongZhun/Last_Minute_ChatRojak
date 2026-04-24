import { getDb } from '../index.js';

const STATE_TTL_MS = 10 * 60 * 1000;

export function getTokens(userId) {
  const db = getDb();
  return (
    db
      .prepare(
        'SELECT access_token, refresh_token, expires_at, scope, calendar_id FROM google_oauth_tokens WHERE user_id = ?'
      )
      .get(userId) || null
  );
}

export function saveTokens(userId, { accessToken, refreshToken, expiresAt, scope, calendarId }) {
  const db = getDb();
  db.prepare(
    `INSERT INTO google_oauth_tokens
       (user_id, access_token, refresh_token, expires_at, scope, calendar_id, linked_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET
       access_token = excluded.access_token,
       refresh_token = COALESCE(excluded.refresh_token, google_oauth_tokens.refresh_token),
       expires_at = excluded.expires_at,
       scope = excluded.scope,
       calendar_id = excluded.calendar_id,
       linked_at = excluded.linked_at`
  ).run(
    userId,
    accessToken,
    refreshToken || null,
    expiresAt,
    scope || '',
    calendarId || 'primary',
    Date.now()
  );
}

export function updateAccessToken(userId, { accessToken, expiresAt }) {
  const db = getDb();
  db.prepare(
    'UPDATE google_oauth_tokens SET access_token = ?, expires_at = ? WHERE user_id = ?'
  ).run(accessToken, expiresAt, userId);
}

export function deleteTokens(userId) {
  const db = getDb();
  db.prepare('DELETE FROM google_oauth_tokens WHERE user_id = ?').run(userId);
}

export function createState(state, userId) {
  const db = getDb();
  db.prepare(
    'INSERT INTO google_oauth_states (state, user_id, created_at) VALUES (?, ?, ?)'
  ).run(state, userId, Date.now());
}

export function consumeState(state) {
  const db = getDb();
  const row = db
    .prepare('SELECT user_id, created_at FROM google_oauth_states WHERE state = ?')
    .get(state);
  db.prepare('DELETE FROM google_oauth_states WHERE state = ?').run(state);
  if (!row) return null;
  if (Date.now() - row.created_at > STATE_TTL_MS) return null;
  return row.user_id;
}

export function purgeExpiredStates() {
  const db = getDb();
  db.prepare('DELETE FROM google_oauth_states WHERE created_at < ?').run(
    Date.now() - STATE_TTL_MS
  );
}
