import fs from 'fs';
import path from 'path';

const STATE_FILE = path.join('state', 'tasks.json');

function ensureDir() {
  if (!fs.existsSync('state')) fs.mkdirSync('state', { recursive: true });
}

const emptyState = () => ({ tasks: [], plans: [], replan_events: [] });

export function loadState() {
  ensureDir();
  if (!fs.existsSync(STATE_FILE)) return emptyState();
  try {
    const data = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
    return {
      tasks: Array.isArray(data.tasks) ? data.tasks : [],
      plans: Array.isArray(data.plans) ? data.plans : [],
      replan_events: Array.isArray(data.replan_events) ? data.replan_events : [],
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
