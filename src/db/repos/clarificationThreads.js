import crypto from 'crypto';
import { getDb } from '../index.js';

function normalise(row) {
  if (!row) return null;
  return {
    id: row.id,
    user_id: row.user_id,
    task_id: row.task_id,
    field: row.field,
    question: row.question,
    state: row.state,
    asked_at: row.asked_at,
    answered_at: row.answered_at,
    answer: row.answer,
    telegram_msg_id: row.telegram_msg_id,
    telegram_chat_id: row.telegram_chat_id,
  };
}

export function newThreadId() {
  return `clar_${crypto.randomBytes(6).toString('hex')}`;
}

export function createThread(userId, { taskId, field, question }) {
  const db = getDb();
  const id = newThreadId();
  db.prepare(
    `INSERT INTO clarification_threads
       (id, user_id, task_id, field, question, state, asked_at)
     VALUES (?, ?, ?, ?, ?, 'open', ?)`
  ).run(id, userId, taskId, field, question, Date.now());
  return id;
}

export function findOpenThread(userId, taskId, field) {
  const db = getDb();
  return normalise(
    db
      .prepare(
        `SELECT * FROM clarification_threads
         WHERE user_id = ? AND task_id = ? AND field = ? AND state IN ('open','awaiting_answer')
         ORDER BY asked_at DESC LIMIT 1`
      )
      .get(userId, taskId, field)
  );
}

export function getThread(threadId) {
  const db = getDb();
  return normalise(
    db.prepare('SELECT * FROM clarification_threads WHERE id = ?').get(threadId)
  );
}

export function findThreadByTelegramMsg(telegramMsgId) {
  const db = getDb();
  return normalise(
    db
      .prepare(
        "SELECT * FROM clarification_threads WHERE telegram_msg_id = ? AND state = 'awaiting_answer'"
      )
      .get(telegramMsgId)
  );
}

export function listOpenThreads(userId) {
  const db = getDb();
  return db
    .prepare(
      `SELECT * FROM clarification_threads
       WHERE user_id = ? AND state IN ('open','awaiting_answer')
       ORDER BY asked_at DESC`
    )
    .all(userId)
    .map(normalise);
}

export function markSent(threadId, telegramMsgId, telegramChatId) {
  const db = getDb();
  db.prepare(
    `UPDATE clarification_threads
     SET state = 'awaiting_answer', telegram_msg_id = ?, telegram_chat_id = ?
     WHERE id = ?`
  ).run(telegramMsgId ?? null, telegramChatId ?? null, threadId);
}

export function resolveThread(threadId, answer) {
  const db = getDb();
  return db
    .prepare(
      `UPDATE clarification_threads SET state = 'resolved', answer = ?, answered_at = ? WHERE id = ?`
    )
    .run(answer, Date.now(), threadId).changes;
}

export function timeoutStaleThreads(olderThanMs) {
  const db = getDb();
  const cutoff = Date.now() - olderThanMs;
  const rows = db
    .prepare(
      `SELECT id, user_id, task_id, field FROM clarification_threads
       WHERE state IN ('open','awaiting_answer') AND asked_at < ?`
    )
    .all(cutoff);
  if (!rows.length) return [];
  db.prepare(
    `UPDATE clarification_threads SET state = 'timed_out'
     WHERE state IN ('open','awaiting_answer') AND asked_at < ?`
  ).run(cutoff);
  return rows;
}
