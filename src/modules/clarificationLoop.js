import {
  createThread,
  findOpenThread,
  findThreadByTelegramMsg,
  getThread,
  listOpenThreads,
  markSent,
  resolveThread,
  timeoutStaleThreads,
} from '../db/repos/clarificationThreads.js';
import { addTaskEvent } from '../db/repos/taskEvents.js';
import { emit } from './notifier.js';

const TIMEOUT_MS = 24 * 3_600_000;

export function openThread(userId, { taskId, field, question }) {
  const existing = findOpenThread(userId, taskId, field);
  if (existing) return existing.id;
  const id = createThread(userId, { taskId, field, question });
  addTaskEvent(userId, taskId, 'clarification_opened', { thread_id: id, field, question });
  emit('clarification_opened', { user_id: userId, thread_id: id, task_id: taskId, field, question });
  return id;
}

export function recordSent(threadId, telegramMsgId, telegramChatId) {
  markSent(threadId, telegramMsgId, telegramChatId);
}

export function receive(threadId, answer, { onResolve } = {}) {
  const thread = getThread(threadId);
  if (!thread) return null;
  if (thread.state === 'resolved' || thread.state === 'timed_out') return thread;
  resolveThread(threadId, answer);
  addTaskEvent(thread.user_id, thread.task_id, 'clarification_resolved', {
    thread_id: threadId,
    field: thread.field,
    answer,
  });
  emit('clarification_resolved', {
    user_id: thread.user_id,
    thread_id: threadId,
    task_id: thread.task_id,
    field: thread.field,
    answer,
  });
  if (onResolve) {
    try { onResolve(thread, answer); } catch (e) { console.error('[clarification] onResolve error', e); }
  }
  return { ...thread, state: 'resolved', answer };
}

export function receiveByTelegramMsg(telegramMsgId, answer, { onResolve } = {}) {
  const thread = findThreadByTelegramMsg(telegramMsgId);
  if (!thread) return null;
  return receive(thread.id, answer, { onResolve });
}

export function sweepTimeouts() {
  const timed = timeoutStaleThreads(TIMEOUT_MS);
  for (const t of timed) {
    addTaskEvent(t.user_id, t.task_id, 'clarification_timed_out', { thread_id: t.id, field: t.field });
    emit('clarification_timed_out', {
      user_id: t.user_id,
      thread_id: t.id,
      task_id: t.task_id,
      field: t.field,
    });
  }
  return timed.length;
}

export { listOpenThreads, getThread };
