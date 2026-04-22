import crypto from 'crypto';
import { getDb } from '../index.js';

const LINK_CODE_TTL_MS = 10 * 60 * 1000;
const SENT_KEYS_MAX_AGE_MS = 7 * 24 * 3600 * 1000;

export function getUserIdForChat(chatId) {
  if (!chatId) return null;
  const db = getDb();
  const row = db
    .prepare('SELECT user_id FROM telegram_links WHERE chat_id = ?')
    .get(String(chatId));
  return row?.user_id || null;
}

export function getChatIdForUser(userId) {
  const db = getDb();
  const row = db
    .prepare('SELECT chat_id FROM telegram_links WHERE user_id = ?')
    .get(userId);
  return row?.chat_id || null;
}

export function linkUserToChat(userId, chatId) {
  const db = getDb();
  db.prepare(
    `INSERT INTO telegram_links (user_id, chat_id, linked_at)
     VALUES (?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET chat_id = excluded.chat_id, linked_at = excluded.linked_at`
  ).run(userId, String(chatId), Date.now());
  db.prepare('DELETE FROM telegram_link_codes WHERE user_id = ?').run(userId);
}

export function issueLinkCode(userId) {
  const db = getDb();
  db.prepare('DELETE FROM telegram_link_codes WHERE user_id = ?').run(userId);
  let code;
  for (let tries = 0; tries < 10; tries++) {
    code = String(crypto.randomInt(100000, 1000000));
    const exists = db.prepare('SELECT 1 FROM telegram_link_codes WHERE code = ?').get(code);
    if (!exists) break;
  }
  db.prepare(
    'INSERT INTO telegram_link_codes (code, user_id, expires_at) VALUES (?, ?, ?)'
  ).run(code, userId, Date.now() + LINK_CODE_TTL_MS);
  return code;
}

export function consumeLinkCode(code) {
  const db = getDb();
  const row = db
    .prepare('SELECT user_id, expires_at FROM telegram_link_codes WHERE code = ?')
    .get(code);
  if (!row) return null;
  db.prepare('DELETE FROM telegram_link_codes WHERE code = ?').run(code);
  if (row.expires_at <= Date.now()) return null;
  return row.user_id;
}

export function purgeExpiredLinkCodes() {
  const db = getDb();
  return db
    .prepare('DELETE FROM telegram_link_codes WHERE expires_at <= ?')
    .run(Date.now()).changes;
}

export function getPollCursor() {
  const db = getDb();
  const row = db.prepare('SELECT last_update_id FROM telegram_poll_cursor WHERE id = 1').get();
  return row?.last_update_id || 0;
}

export function setPollCursor(value) {
  const db = getDb();
  db.prepare(
    'UPDATE telegram_poll_cursor SET last_update_id = ? WHERE id = 1 AND ? > last_update_id'
  ).run(value, value);
}

export function appendBufferMessage(chatId, content) {
  const db = getDb();
  const tx = db.transaction(() => {
    const row = db
      .prepare('SELECT COALESCE(MAX(position), -1) AS p FROM telegram_buffers WHERE chat_id = ?')
      .get(String(chatId));
    const nextPos = (row?.p ?? -1) + 1;
    db.prepare(
      'INSERT INTO telegram_buffers (chat_id, position, content, created_at) VALUES (?, ?, ?, ?)'
    ).run(String(chatId), nextPos, content, Date.now());
    const count = db
      .prepare('SELECT COUNT(*) AS c FROM telegram_buffers WHERE chat_id = ?')
      .get(String(chatId)).c;
    if (count > 200) {
      db.prepare(
        `DELETE FROM telegram_buffers WHERE chat_id = ? AND position IN (
           SELECT position FROM telegram_buffers WHERE chat_id = ? ORDER BY position ASC LIMIT ?
         )`
      ).run(String(chatId), String(chatId), count - 200);
    }
  });
  tx();
}

export function readAndClearBuffer(chatId) {
  const db = getDb();
  const tx = db.transaction(() => {
    const rows = db
      .prepare(
        'SELECT content FROM telegram_buffers WHERE chat_id = ? ORDER BY position ASC'
      )
      .all(String(chatId));
    db.prepare('DELETE FROM telegram_buffers WHERE chat_id = ?').run(String(chatId));
    return rows.map((r) => r.content);
  });
  return tx();
}

export function bufferSize(chatId) {
  const db = getDb();
  return db
    .prepare('SELECT COUNT(*) AS c FROM telegram_buffers WHERE chat_id = ?')
    .get(String(chatId)).c;
}

export function hasSentKey(userId, key) {
  const db = getDb();
  return !!db
    .prepare('SELECT 1 FROM telegram_sent_keys WHERE user_id = ? AND sent_key = ?')
    .get(userId, key);
}

export function markSentKey(userId, key) {
  const db = getDb();
  db.prepare(
    `INSERT OR IGNORE INTO telegram_sent_keys (user_id, sent_key, created_at) VALUES (?, ?, ?)`
  ).run(userId, key, Date.now());
  db.prepare(
    'DELETE FROM telegram_sent_keys WHERE user_id = ? AND created_at < ?'
  ).run(userId, Date.now() - SENT_KEYS_MAX_AGE_MS);
}

export function listLinkedChats() {
  const db = getDb();
  return db.prepare('SELECT user_id, chat_id FROM telegram_links').all();
}
