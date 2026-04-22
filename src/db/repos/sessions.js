import crypto from 'crypto';
import { getDb } from '../index.js';

const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;

function newSessionId() {
  return crypto.randomBytes(32).toString('hex');
}

export function createSession(userId) {
  const db = getDb();
  const id = newSessionId();
  const now = Date.now();
  db.prepare(
    'INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)'
  ).run(id, userId, now, now + SESSION_TTL_MS);
  return id;
}

export function getUserBySessionId(sessionId) {
  if (!sessionId) return null;
  const db = getDb();
  const row = db
    .prepare(
      `SELECT u.id AS id, u.email AS email
       FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.id = ? AND s.expires_at > ?`
    )
    .get(sessionId, Date.now());
  return row || null;
}

export function revokeSession(sessionId) {
  if (!sessionId) return;
  const db = getDb();
  db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
}

export function purgeExpiredSessions() {
  const db = getDb();
  return db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(Date.now()).changes;
}
