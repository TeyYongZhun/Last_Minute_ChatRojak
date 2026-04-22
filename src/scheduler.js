import { sweepDueReminders } from './modules/actions.js';
import { purgeExpiredSessions } from './db/repos/sessions.js';
import { purgeExpiredLinkCodes } from './db/repos/telegram.js';

const TICK_MS = 30_000;
let timer = null;

export function tick(now = new Date()) {
  try {
    const fired = sweepDueReminders(now);
    purgeExpiredSessions();
    purgeExpiredLinkCodes();
    if (fired > 0) {
      console.log(`[scheduler] fired ${fired} reminder(s)`);
    }
  } catch (e) {
    console.error('[scheduler] tick error:', e);
  }
}

export function startScheduler() {
  if (timer) return;
  timer = setInterval(() => tick(new Date()), TICK_MS);
  if (timer.unref) timer.unref();
  console.log(`[scheduler] started (tick ${TICK_MS}ms)`);
  setTimeout(() => tick(new Date()), 500).unref?.();
}

export function stopScheduler() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
