import { loadState, saveState, clearState } from '../state.js';
import { parseMessages } from './task1Parser.js';
import {
  mergeNewTasks,
  replanAll,
  startTask,
  completeTask,
  respondToClarification,
  getDashboard,
} from './task3Executor.js';
import { subscribe } from './notifier.js';
import { withRetry } from '../client.js';

const API_BASE = 'https://api.telegram.org';
const POLL_TIMEOUT_SEC = 25;
const MAX_BUFFER_SIZE = 200;
const MAX_SENT_KEYS = 200;

let running = false;

function token() {
  return process.env.TELEGRAM_BOT_TOKEN || '';
}

async function telegramApi(method, body) {
  const t = token();
  if (!t) throw new Error('TELEGRAM_BOT_TOKEN not set');
  return withRetry(async () => {
    const res = await fetch(`${API_BASE}/bot${t}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) {
      const err = new Error(`Telegram ${method} failed: ${data.description || res.statusText}`);
      err.status = res.status;
      throw err;
    }
    return data.result;
  });
}

async function sendMessage(chatId, text) {
  if (!chatId) return;
  try {
    await telegramApi('sendMessage', {
      chat_id: chatId,
      text,
      disable_web_page_preview: true,
    });
  } catch (e) {
    console.error('[telegram] sendMessage failed:', e.message);
  }
}

function senderLabel(msg) {
  const from = msg.from || {};
  const parts = [from.first_name, from.last_name].filter(Boolean);
  if (parts.length) return parts.join(' ');
  if (from.username) return `@${from.username}`;
  if (msg.chat?.type === 'private') return 'User';
  return 'Unknown';
}

function bufferFor(state, chatId) {
  const key = String(chatId);
  state.telegram.buffers[key] ||= [];
  return state.telegram.buffers[key];
}

function clearBuffer(state, chatId) {
  const key = String(chatId);
  state.telegram.buffers[key] = [];
}

function parseCommand(text) {
  if (!text || !text.startsWith('/')) return null;
  const firstSpace = text.indexOf(' ');
  const head = firstSpace === -1 ? text : text.slice(0, firstSpace);
  const rest = firstSpace === -1 ? '' : text.slice(firstSpace + 1).trim();
  const cmd = head.split('@')[0].slice(1).toLowerCase();
  return { cmd, args: rest };
}

function renderDashboardText(data) {
  const lines = [];
  const push = (label, items) => {
    if (!items.length) return;
    lines.push(`\n— ${label} —`);
    for (const it of items) {
      const dl = it.deadline ? ` · ${it.deadline}` : '';
      const by = it.assigned_by ? ` · ${it.assigned_by}` : '';
      lines.push(`${it.task_id}  ${it.task}${dl}${by}  [${it.priority_score}]`);
    }
  };
  push('In progress', data.in_progress);
  push('Do now', data.do_now);
  push('Schedule', data.schedule);
  push('Need info', data.need_info);
  push('Deferred', data.defer);
  if (data.done.length) lines.push(`\n(${data.done.length} completed)`);
  if (!lines.length) return 'No tasks yet. Send some messages then /process.';
  return `Dashboard (${data.total_tasks} total):` + lines.join('\n');
}

const HELP_TEXT = [
  'Commands:',
  '/start — register this chat for push notifications',
  '/process — flush buffered messages into the task parser',
  '/dashboard — show current tasks',
  '/start_task <id> — mark task in progress',
  '/done <id> — mark task done',
  '/answer <id> <field>: <value> — answer a clarification question',
  '/reset — clear all state',
  '/help — show this list',
  '',
  'Any other message is buffered until you run /process.',
].join('\n');

async function handleCommand(chatId, cmd, args, state) {
  switch (cmd) {
    case 'start': {
      state.telegram.active_chat_id = chatId;
      await sendMessage(chatId, 'Registered. Send messages, then /process to extract tasks. /help for commands.');
      return true;
    }
    case 'help': {
      await sendMessage(chatId, HELP_TEXT);
      return false;
    }
    case 'process': {
      const buf = bufferFor(state, chatId);
      if (!buf.length) {
        await sendMessage(chatId, 'Buffer is empty. Send some messages first.');
        return false;
      }
      const text = buf.join('\n');
      clearBuffer(state, chatId);
      saveState(state);
      try {
        const now = new Date();
        const tasks = await parseMessages(text, now);
        if (!tasks.length) {
          await sendMessage(chatId, 'No actionable tasks found in those messages.');
          return false;
        }
        mergeNewTasks(tasks);
        const replan = await replanAll(now);
        await sendMessage(
          chatId,
          `Extracted ${tasks.length} task(s). ${replan.plans.length} planned, ${replan.conflicts.length} conflict(s).`
        );
      } catch (e) {
        console.error('[telegram] /process error:', e);
        await sendMessage(chatId, `Error while processing: ${e.message}`);
      }
      return false;
    }
    case 'dashboard':
    case 'list': {
      const data = getDashboard();
      await sendMessage(chatId, renderDashboardText(data));
      return false;
    }
    case 'done': {
      const id = args.trim();
      if (!id) return void (await sendMessage(chatId, 'Usage: /done <task_id>'));
      if (!completeTask(id)) return void (await sendMessage(chatId, `Task ${id} not found.`));
      try { await replanAll(new Date()); } catch (e) { console.error('[telegram] replan after /done:', e); }
      await sendMessage(chatId, `Marked ${id} done.`);
      return false;
    }
    case 'start_task': {
      const id = args.trim();
      if (!id) return void (await sendMessage(chatId, 'Usage: /start_task <task_id>'));
      if (!startTask(id)) return void (await sendMessage(chatId, `Task ${id} not found.`));
      await sendMessage(chatId, `Started ${id}.`);
      return false;
    }
    case 'answer': {
      const m = args.match(/^(\S+)\s+(\S+)\s*:\s*(.+)$/);
      if (!m) {
        await sendMessage(chatId, 'Usage: /answer <task_id> <field>: <value>\nExample: /answer t3 deadline: next Friday 5pm');
        return false;
      }
      const [, id, field, value] = m;
      if (!respondToClarification(id, field, value.trim())) {
        await sendMessage(chatId, `Task ${id} not found.`);
        return false;
      }
      try { await replanAll(new Date()); } catch (e) { console.error('[telegram] replan after /answer:', e); }
      await sendMessage(chatId, `Recorded ${field}='${value.trim()}' for ${id}.`);
      return false;
    }
    case 'reset': {
      clearState();
      await sendMessage(chatId, 'State cleared.');
      return false;
    }
    default: {
      await sendMessage(chatId, `Unknown command: /${cmd}. Send /help for the list.`);
      return false;
    }
  }
}

async function handleUpdate(update) {
  const state = loadState();
  if ((update.update_id || 0) > state.telegram.last_update_id) {
    state.telegram.last_update_id = update.update_id;
  }

  const msg = update.message || update.edited_message;
  if (!msg || !msg.chat) {
    saveState(state);
    return;
  }
  const chatId = msg.chat.id;
  const text = msg.text || msg.caption || '';

  const parsed = parseCommand(text);
  if (parsed) {
    const stateChanged = await handleCommand(chatId, parsed.cmd, parsed.args, state);
    if (stateChanged) saveState(state);
    else {
      const fresh = loadState();
      fresh.telegram.last_update_id = Math.max(fresh.telegram.last_update_id, update.update_id || 0);
      saveState(fresh);
    }
    return;
  }

  if (!text.trim()) {
    saveState(state);
    return;
  }

  const buf = bufferFor(state, chatId);
  buf.push(`${senderLabel(msg)}: ${text.trim()}`);
  if (buf.length > MAX_BUFFER_SIZE) buf.splice(0, buf.length - MAX_BUFFER_SIZE);
  saveState(state);
}

function hasSentKey(key) {
  const state = loadState();
  return state.telegram.sent_notification_keys.includes(key);
}

function markSent(key) {
  const state = loadState();
  const keys = state.telegram.sent_notification_keys;
  if (!keys.includes(key)) {
    keys.push(key);
    if (keys.length > MAX_SENT_KEYS) keys.splice(0, keys.length - MAX_SENT_KEYS);
    saveState(state);
  }
}

function activeChatId() {
  return loadState().telegram.active_chat_id;
}

function wireNotifier() {
  subscribe(async (kind, payload) => {
    if (!token()) return;
    const chatId = activeChatId();
    if (!chatId) return;

    if (kind === 'reminder') {
      const key = `reminder:${payload.key}`;
      if (hasSentKey(key)) return;
      markSent(key);
      await sendMessage(chatId, `⏰ ${payload.message}`);
    } else if (kind === 'clarification_needed') {
      const key = `clarify:${payload.task_id}:${payload.questions.join('|')}`;
      if (hasSentKey(key)) return;
      markSent(key);
      const lines = [
        `❓ Need info on ${payload.task_id} (${payload.task}):`,
        ...payload.questions.map((q) => `  • ${q}`),
        '',
        `Reply with: /answer ${payload.task_id} <field>: <value>`,
      ];
      await sendMessage(chatId, lines.join('\n'));
    } else if (kind === 'conflict') {
      const key = `conflict:${payload.key}`;
      if (hasSentKey(key)) return;
      markSent(key);
      await sendMessage(chatId, `⚠️ Conflict (${payload.ids.join(' ↔ ')}): ${payload.message}`);
    }
  });
}

async function pollLoop() {
  const idleMs = Number(process.env.TELEGRAM_POLL_INTERVAL_MS) || 1500;
  while (running) {
    try {
      const state = loadState();
      const offset = (state.telegram.last_update_id || 0) + 1;
      const updates = await telegramApi('getUpdates', {
        offset,
        timeout: POLL_TIMEOUT_SEC,
        allowed_updates: ['message', 'edited_message'],
      });
      if (Array.isArray(updates)) {
        for (const u of updates) {
          try { await handleUpdate(u); }
          catch (e) { console.error('[telegram] handleUpdate error:', e); }
        }
      }
    } catch (e) {
      console.error('[telegram] poll error:', e.message);
      await new Promise((r) => setTimeout(r, 5000));
      continue;
    }
    if (idleMs > 0) await new Promise((r) => setTimeout(r, idleMs));
  }
}

export function startTelegramBot() {
  if (running) return;
  if (!token()) {
    console.log('[telegram] token missing, skipping bot');
    return;
  }
  running = true;
  wireNotifier();
  console.log('[telegram] long-poll started');
  pollLoop().catch((e) => {
    running = false;
    console.error('[telegram] poll loop crashed:', e);
  });
}

export function isBotEnabled() {
  return !!token();
}

export function getActiveChatId() {
  try {
    return loadState().telegram.active_chat_id;
  } catch {
    return null;
  }
}
