import { sweepDueReminders } from './modules/actions.js';
import { purgeExpiredSessions } from './db/repos/sessions.js';
import { purgeExpiredLinkCodes } from './db/repos/telegram.js';
import { sweepTimeouts as sweepClarificationTimeouts } from './modules/clarificationLoop.js';
import { retryFailed as retryFailedCalendar } from './integrations/googleCalendar.js';
import { purgeExpiredStates as purgeGoogleStates } from './db/repos/googleTokens.js';

const TICK_MS = 30_000;
let timer = null;

export async function tick(now = new Date()) {
  try {
    const fired = sweepDueReminders(now);
    purgeExpiredSessions();
    purgeExpiredLinkCodes();
    purgeGoogleStates();
    const timedOut = sweepClarificationTimeouts();
    if (timedOut > 0) console.log(`[scheduler] timed out ${timedOut} clarification thread(s)`);
    if (fired > 0) console.log(`[scheduler] fired ${fired} reminder(s)`);

    try {
      const failed = await retryFailedCalendar();
      if (failed?.length) console.log(`[scheduler] ${failed.length} calendar event(s) pending retry`);
    } catch (e) {
      // ignored
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
