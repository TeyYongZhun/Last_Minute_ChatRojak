import fs from 'fs';
import path from 'path';

const STATE_FILE = path.join('state', 'tasks.json');

function ensureDir() {
  if (!fs.existsSync('state')) fs.mkdirSync('state', { recursive: true });
}

const emptyTelegram = () => ({
  active_chat_id: null,
  last_update_id: 0,
  buffers: {},
  sent_notification_keys: [],
});

const emptyState = () => ({
  tasks: [],
  plans: [],
  replan_events: [],
  actions: [],
  notifications: [],
  telegram: emptyTelegram(),
});

export function loadState() {
  ensureDir();
  if (!fs.existsSync(STATE_FILE)) return emptyState();
  try {
    const data = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
    const tg = data.telegram && typeof data.telegram === 'object' ? data.telegram : {};
    return {
      tasks: Array.isArray(data.tasks) ? data.tasks : [],
      plans: Array.isArray(data.plans) ? data.plans : [],
      replan_events: Array.isArray(data.replan_events) ? data.replan_events : [],
      actions: Array.isArray(data.actions) ? data.actions : [],
      notifications: Array.isArray(data.notifications) ? data.notifications : [],
      telegram: {
        active_chat_id: tg.active_chat_id ?? null,
        last_update_id: Number.isFinite(tg.last_update_id) ? tg.last_update_id : 0,
        buffers: tg.buffers && typeof tg.buffers === 'object' ? tg.buffers : {},
        sent_notification_keys: Array.isArray(tg.sent_notification_keys) ? tg.sent_notification_keys : [],
      },
    };
  } catch {
    return emptyState();
  }
}

export function saveState(state) {
  ensureDir();
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf-8');
}

export function clearState() {
  if (fs.existsSync(STATE_FILE)) fs.unlinkSync(STATE_FILE);
}
