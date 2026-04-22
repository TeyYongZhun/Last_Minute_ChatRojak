import { parseMessages } from './task1Parser.js';
import {
  mergeNewTasks,
  replanAll,
  startTask,
  completeTask,
  respondToClarification,
  getDashboard,
  resetUser,
} from './task3Executor.js';
import { subscribe } from './notifier.js';
import { withRetry } from '../client.js';
import {
  getUserIdForChat,
  getChatIdForUser,
  linkUserToChat,
  consumeLinkCode,
  getPollCursor,
  setPollCursor,
  appendBufferMessage,
  readAndClearBuffer,
  bufferSize,
  hasSentKey,
  markSentKey,
} from '../db/repos/telegram.js';

const API_BASE = 'https://api.telegram.org';
const POLL_TIMEOUT_SEC = 25;

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
      const tags = it.tags?.length ? ` · #${it.tags.join(' #')}` : '';
      lines.push(`${it.task_id}  ${it.task}${dl}${by}  [${it.priority_score}]${tags}`);
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

const HELP_TEXT_UNLINKED = [
  'This chat is not yet linked to an account.',
  '',
  '1. Sign up on the web app.',
  '2. Go to account settings and request a link code.',
  '3. Send: /link <6-digit-code>',
  '',
  'Once linked, send chat messages and /process to extract tasks.',
].join('\n');

const HELP_TEXT_LINKED = [
  'Commands:',
  '/process — flush buffered messages into the task parser',
  '/dashboard — show current tasks',
  '/start_task <id> — mark task in progress',
  '/done <id> — mark task done',
  '/answer <id> <field>: <value> — answer a clarification question',
  '/reset — clear your tasks',
  '/unlink — detach this chat from your account',
  '/help — show this list',
  '',
  'Any other message is buffered until you run /process.',
].join('\n');

async function handleLinkCommand(chatId, args) {
  const code = args.trim();
  if (!code) {
    await sendMessage(chatId, 'Usage: /link <6-digit-code>');
    return;
  }
  const userId = consumeLinkCode(code);
  if (!userId) {
    await sendMessage(chatId, 'That code is invalid or expired. Generate a new one on the web app.');
    return;
  }
  linkUserToChat(userId, chatId);
  await sendMessage(chatId, 'Linked! Send chat messages and /process to extract tasks. /help for commands.');
}

async function handleCommandLinked(chatId, userId, cmd, args) {
  switch (cmd) {
    case 'start':
    case 'help':
      await sendMessage(chatId, HELP_TEXT_LINKED);
      return;
    case 'link':
      await sendMessage(chatId, 'This chat is already linked.');
      return;
    case 'unlink':
      await sendMessage(
        chatId,
        'To unlink, revoke the link from the web app. (Unlink-from-telegram not yet supported here.)'
      );
      return;
    case 'process': {
      const messages = readAndClearBuffer(chatId);
      if (!messages.length) {
        await sendMessage(chatId, 'Buffer is empty. Send some messages first.');
        return;
      }
      const text = messages.join('\n');
      try {
        const now = new Date();
        const tasks = await parseMessages(text, now);
        if (!tasks.length) {
          await sendMessage(chatId, 'No actionable tasks found in those messages.');
          return;
        }
        mergeNewTasks(userId, tasks);
        const replan = await replanAll(userId, now);
        await sendMessage(
          chatId,
          `Extracted ${tasks.length} task(s). ${replan.plans.length} planned, ${replan.conflicts.length} conflict(s).`
        );
      } catch (e) {
        console.error('[telegram] /process error:', e);
        await sendMessage(chatId, `Error while processing: ${e.message}`);
      }
      return;
    }
    case 'dashboard':
    case 'list': {
      const data = getDashboard(userId);
      await sendMessage(chatId, renderDashboardText(data));
      return;
    }
    case 'done': {
      const id = args.trim();
      if (!id) return void (await sendMessage(chatId, 'Usage: /done <task_id>'));
      if (!completeTask(userId, id)) return void (await sendMessage(chatId, `Task ${id} not found.`));
      try { await replanAll(userId, new Date()); } catch (e) { console.error('[telegram] replan after /done:', e); }
      await sendMessage(chatId, `Marked ${id} done.`);
      return;
    }
    case 'start_task': {
      const id = args.trim();
      if (!id) return void (await sendMessage(chatId, 'Usage: /start_task <task_id>'));
      if (!startTask(userId, id)) return void (await sendMessage(chatId, `Task ${id} not found.`));
      await sendMessage(chatId, `Started ${id}.`);
      return;
    }
    case 'answer': {
      const m = args.match(/^(\S+)\s+(\S+)\s*:\s*(.+)$/);
      if (!m) {
        await sendMessage(chatId, 'Usage: /answer <task_id> <field>: <value>\nExample: /answer t3 deadline: next Friday 5pm');
        return;
      }
      const [, id, field, value] = m;
      if (!respondToClarification(userId, id, field, value.trim())) {
        await sendMessage(chatId, `Task ${id} not found.`);
        return;
      }
      try { await replanAll(userId, new Date()); } catch (e) { console.error('[telegram] replan after /answer:', e); }
      await sendMessage(chatId, `Recorded ${field}='${value.trim()}' for ${id}.`);
      return;
    }
    case 'reset': {
      resetUser(userId);
      await sendMessage(chatId, 'Your tasks have been cleared.');
      return;
    }
    default:
      await sendMessage(chatId, `Unknown command: /${cmd}. Send /help for the list.`);
  }
}

async function handleUpdate(update) {
  setPollCursor(update.update_id || 0);

  const msg = update.message || update.edited_message;
  if (!msg || !msg.chat) return;
  const chatId = msg.chat.id;
  const text = msg.text || msg.caption || '';

  const parsed = parseCommand(text);
  const userId = getUserIdForChat(chatId);

  if (parsed) {
    if (!userId) {
      if (parsed.cmd === 'link') {
        await handleLinkCommand(chatId, parsed.args);
      } else {
        await sendMessage(chatId, HELP_TEXT_UNLINKED);
      }
      return;
    }
    await handleCommandLinked(chatId, userId, parsed.cmd, parsed.args);
    return;
  }

  if (!text.trim()) return;

  if (!userId) {
    if (bufferSize(chatId) === 0) {
      await sendMessage(chatId, HELP_TEXT_UNLINKED);
    }
    return;
  }

  appendBufferMessage(chatId, `${senderLabel(msg)}: ${text.trim()}`);
}

function wireNotifier() {
  subscribe(async (kind, payload) => {
    if (!token()) return;
    const userId = payload.user_id;
    if (!userId) return;
    const chatId = getChatIdForUser(userId);
    if (!chatId) return;

    if (kind === 'reminder') {
      const key = `reminder:${payload.key}`;
      if (hasSentKey(userId, key)) return;
      markSentKey(userId, key);
      await sendMessage(chatId, `⏰ ${payload.message}`);
    } else if (kind === 'clarification_needed') {
      const key = `clarify:${payload.task_id}:${payload.questions.join('|')}`;
      if (hasSentKey(userId, key)) return;
      markSentKey(userId, key);
      const lines = [
        `❓ Need info on ${payload.task_id} (${payload.task}):`,
        ...payload.questions.map((q) => `  • ${q}`),
        '',
        `Reply with: /answer ${payload.task_id} <field>: <value>`,
      ];
      await sendMessage(chatId, lines.join('\n'));
    } else if (kind === 'conflict') {
      const key = `conflict:${payload.key}`;
      if (hasSentKey(userId, key)) return;
      markSentKey(userId, key);
      await sendMessage(chatId, `⚠️ Conflict (${payload.ids.join(' ↔ ')}): ${payload.message}`);
    }
  });
}

async function pollLoop() {
  const idleMs = Number(process.env.TELEGRAM_POLL_INTERVAL_MS) || 1500;
  while (running) {
    try {
      const offset = getPollCursor() + 1;
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
