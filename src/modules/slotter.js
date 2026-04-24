import { topoSort } from './dependencyGraph.js';

const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MIN_MS = 60 * 1000;

function parseHourMinute(value, fallback) {
  const m = typeof value === 'string' ? value.match(/^(\d{1,2}):(\d{2})$/) : null;
  if (!m) return fallback;
  const hh = Math.max(0, Math.min(23, parseInt(m[1], 10)));
  const mm = Math.max(0, Math.min(59, parseInt(m[2], 10)));
  return hh * 60 + mm;
}

function parseWorkingDays(value) {
  if (typeof value !== 'string') return new Set([1, 2, 3, 4, 5]);
  const set = new Set();
  for (const raw of value.split(',')) {
    const idx = DAY_LABELS.indexOf(raw.trim());
    if (idx >= 0) set.add(idx);
  }
  return set.size ? set : new Set([1, 2, 3, 4, 5]);
}

function parseFixedOffset(tz) {
  const m = typeof tz === 'string' ? tz.match(/^([+-])(\d{2}):(\d{2})$/) : null;
  if (!m) return null;
  const sign = m[1] === '+' ? 1 : -1;
  return sign * (parseInt(m[2], 10) * 60 + parseInt(m[3], 10));
}

function offsetFromIso(iso) {
  if (typeof iso !== 'string') return null;
  if (/Z$/.test(iso)) return 0;
  const m = iso.match(/([+-])(\d{2}):(\d{2})$/);
  if (!m) return null;
  const sign = m[1] === '+' ? 1 : -1;
  return sign * (parseInt(m[2], 10) * 60 + parseInt(m[3], 10));
}

function offsetFromIana(tz, atEpochMs) {
  try {
    const fmt = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'shortOffset' });
    const parts = fmt.formatToParts(new Date(atEpochMs));
    const name = parts.find((p) => p.type === 'timeZoneName')?.value || '';
    const m = name.match(/GMT([+-])(\d{1,2})(?::(\d{2}))?/);
    if (!m) return null;
    const sign = m[1] === '+' ? 1 : -1;
    const hh = parseInt(m[2], 10);
    const mm = m[3] ? parseInt(m[3], 10) : 0;
    return sign * (hh * 60 + mm);
  } catch {
    return null;
  }
}

function resolveOffsetMinutes(prefs, tasks, now) {
  const fixed = parseFixedOffset(prefs?.timezone);
  if (fixed != null) return fixed;
  if (prefs?.timezone) {
    const ianaOffset = offsetFromIana(prefs.timezone, now.getTime());
    if (ianaOffset != null) return ianaOffset;
  }
  for (const t of tasks || []) {
    const o = offsetFromIso(t.deadline_iso);
    if (o != null) return o;
  }
  return -now.getTimezoneOffset();
}

function localParts(epochMs, offsetMinutes) {
  const shifted = new Date(epochMs + offsetMinutes * MIN_MS);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth(),
    day: shifted.getUTCDate(),
    dow: shifted.getUTCDay(),
    minuteOfDay: shifted.getUTCHours() * 60 + shifted.getUTCMinutes(),
  };
}

function epochFromLocal(year, month, day, minuteOfDay, offsetMinutes) {
  return Date.UTC(year, month, day, 0, 0, 0, 0) + minuteOfDay * MIN_MS - offsetMinutes * MIN_MS;
}

function formatIso(epochMs, offsetMinutes) {
  const shifted = new Date(epochMs + offsetMinutes * MIN_MS).toISOString().replace(/\.\d+/, '');
  if (offsetMinutes === 0) return shifted;
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMinutes);
  const hh = String(Math.floor(abs / 60)).padStart(2, '0');
  const mm = String(abs % 60).padStart(2, '0');
  return shifted.replace(/Z$/, `${sign}${hh}:${mm}`);
}

function roundUpToGranularity(epochMs, granularityMinutes) {
  const granMs = granularityMinutes * MIN_MS;
  return Math.ceil(epochMs / granMs) * granMs;
}

function resolveDuration(task) {
  const raw = task?.user_duration_minutes ?? task?.ai_duration_minutes ?? task?.estimated_duration_minutes ?? 30;
  const n = Math.round(Number(raw));
  if (!Number.isFinite(n)) return 30;
  return Math.max(5, Math.min(1440, n));
}

function advanceToWorkingWindow(epochMs, offsetMinutes, workStart, workEnd, workingDays, granularity) {
  let current = roundUpToGranularity(epochMs, granularity);
  for (let guard = 0; guard < 366; guard++) {
    const parts = localParts(current, offsetMinutes);
    const dayStartEpoch = epochFromLocal(parts.year, parts.month, parts.day, workStart, offsetMinutes);
    const dayEndEpoch = epochFromLocal(parts.year, parts.month, parts.day, workEnd, offsetMinutes);
    const isWorkDay = workingDays.has(parts.dow);
    if (isWorkDay && current >= dayStartEpoch && current < dayEndEpoch) return current;
    let next;
    if (isWorkDay && current < dayStartEpoch) {
      next = dayStartEpoch;
    } else {
      next = epochFromLocal(parts.year, parts.month, parts.day + 1, workStart, offsetMinutes);
    }
    current = roundUpToGranularity(next, granularity);
  }
  return current;
}

function dayEndAfter(epochMs, offsetMinutes, workEnd) {
  const parts = localParts(epochMs, offsetMinutes);
  return epochFromLocal(parts.year, parts.month, parts.day, workEnd, offsetMinutes);
}

/**
 * Assign auto-scheduled time blocks to plans.
 *
 * @param {Object} opts
 * @param {Array}  opts.tasks        — task rows with id, deadline_iso, duration fields.
 * @param {Array}  opts.plans        — plan objects; may carry slot_origin='user' to pin.
 * @param {Array}  opts.dependencies — edges {task_id, depends_on}.
 * @param {Object} opts.prefs        — user_preferences row.
 * @param {Date}   opts.now          — reference time (defaults to new Date()).
 * @returns {{ slots: Array, unplaceable: Array, offsetMinutes: number }}
 */
export function assignSlots({ tasks = [], plans = [], dependencies = [], prefs = {}, now = new Date() } = {}) {
  const offsetMinutes = resolveOffsetMinutes(prefs, tasks, now);
  const workStart = parseHourMinute(prefs.working_day_start, 9 * 60);
  const workEnd = parseHourMinute(prefs.working_day_end, 18 * 60);
  const workingDays = parseWorkingDays(prefs.working_days);
  const granularity = Math.max(5, Math.min(120, Number(prefs.slot_granularity_minutes) || 15));
  const effectiveWorkEnd = workEnd > workStart ? workEnd : workStart + 60;

  const taskById = Object.fromEntries(tasks.map((t) => [t.id, t]));
  const planByTaskId = Object.fromEntries(plans.map((p) => [p.task_id, p]));

  const order = topoSort(tasks, dependencies) || tasks.map((t) => t.id);
  const priority = new Map(plans.map((p) => [p.task_id, p.priority_score ?? 0]));
  const deadlineMs = new Map(
    tasks.map((t) => [t.id, t.deadline_iso ? new Date(t.deadline_iso).getTime() : Infinity])
  );

  order.sort((a, b) => {
    // Keep topological guarantee: only re-sort items that share the same topo level.
    // topoSort already returns Kahn order; we stabilise by (priority desc, deadline asc)
    // as a best-effort without breaking dep order — dependents will still be visited
    // later because their in-degree was >0 until the prerequisite was emitted.
    return 0;
  });

  const slots = [];
  const unplaceable = [];
  const endByTaskId = new Map();
  let cursor = now.getTime();

  // Gather fixed user-pinned blocks first so the cursor walk honours them.
  const fixedBlocks = [];
  for (const p of plans) {
    if (p.slot_origin === 'user' && p.planned_start_iso && p.planned_end_iso) {
      const s = new Date(p.planned_start_iso).getTime();
      const e = new Date(p.planned_end_iso).getTime();
      if (!Number.isNaN(s) && !Number.isNaN(e) && e > s) {
        fixedBlocks.push({ taskId: p.task_id, start: s, end: e });
        endByTaskId.set(p.task_id, e);
        slots.push({
          task_id: p.task_id,
          planned_start_iso: p.planned_start_iso,
          planned_end_iso: p.planned_end_iso,
          origin: 'user',
        });
      }
    }
  }
  fixedBlocks.sort((a, b) => a.start - b.start);

  function jumpOverFixed(from, durationMs) {
    let candidate = from;
    for (const fb of fixedBlocks) {
      if (fb.end <= candidate) continue;
      if (fb.start >= candidate + durationMs) break;
      candidate = fb.end;
    }
    return candidate;
  }

  const depsByTask = new Map();
  for (const e of dependencies || []) {
    if (!depsByTask.has(e.task_id)) depsByTask.set(e.task_id, []);
    depsByTask.get(e.task_id).push(e.depends_on);
  }

  // Reorder within topological layers by (priority desc, deadline asc).
  // We rank nodes by position in `order` but stable-shuffle using dep count.
  const rank = new Map(order.map((id, i) => [id, i]));
  const queue = [...order].sort((a, b) => {
    const depDiff = (depsByTask.get(a)?.length || 0) - (depsByTask.get(b)?.length || 0);
    if (depDiff !== 0) return depDiff;
    const pa = priority.get(a) ?? 0;
    const pb = priority.get(b) ?? 0;
    if (pb !== pa) return pb - pa;
    const da = deadlineMs.get(a) ?? Infinity;
    const db = deadlineMs.get(b) ?? Infinity;
    if (da !== db) return da - db;
    return (rank.get(a) ?? 0) - (rank.get(b) ?? 0);
  });
  // Re-enforce dep order: any task whose deps are not yet placed gets deferred to the back.
  const placed = new Set();
  const pending = [...queue];
  const ordered = [];
  let guard = pending.length * pending.length + 10;
  while (pending.length && guard-- > 0) {
    const id = pending.shift();
    const deps = depsByTask.get(id) || [];
    const allPlaced = deps.every((d) => !taskById[d] || placed.has(d));
    if (allPlaced) {
      ordered.push(id);
      placed.add(id);
    } else {
      pending.push(id);
    }
  }
  if (pending.length) ordered.push(...pending);

  for (const id of ordered) {
    const task = taskById[id];
    const plan = planByTaskId[id];
    if (!task || !plan) continue;
    if (plan.slot_origin === 'user' && plan.planned_start_iso && plan.planned_end_iso) {
      // Already recorded in fixedBlocks; nothing else to do.
      cursor = Math.max(cursor, endByTaskId.get(id) ?? cursor);
      continue;
    }
    if (plan.decision === 'ask_user' || plan.decision === 'waiting') continue;

    const durationMs = resolveDuration(task) * MIN_MS;
    let start = cursor;
    // Push past any dependency's planned_end.
    for (const dep of depsByTask.get(id) || []) {
      const depEnd = endByTaskId.get(dep);
      if (depEnd != null && depEnd > start) start = depEnd;
    }
    start = Math.max(start, now.getTime());
    start = jumpOverFixed(start, durationMs);

    let placedStart = null;
    let placedEnd = null;
    const deadline = deadlineMs.get(id);
    for (let attempt = 0; attempt < 366; attempt++) {
      const candidateStart = advanceToWorkingWindow(start, offsetMinutes, workStart, effectiveWorkEnd, workingDays, granularity);
      const candidateEnd = candidateStart + durationMs;
      const dayEnd = dayEndAfter(candidateStart, offsetMinutes, effectiveWorkEnd);
      const jumped = jumpOverFixed(candidateStart, durationMs);
      if (jumped !== candidateStart) {
        start = jumped;
        continue;
      }
      if (candidateEnd > dayEnd) {
        const parts = localParts(candidateStart, offsetMinutes);
        start = epochFromLocal(parts.year, parts.month, parts.day + 1, workStart, offsetMinutes);
        continue;
      }
      placedStart = candidateStart;
      placedEnd = candidateEnd;
      break;
    }

    if (placedStart == null) {
      unplaceable.push({ task_id: id, reason: 'capacity_exhausted' });
      continue;
    }
    if (Number.isFinite(deadline) && placedEnd > deadline) {
      unplaceable.push({ task_id: id, reason: 'deadline_too_close' });
      continue;
    }

    slots.push({
      task_id: id,
      planned_start_iso: formatIso(placedStart, offsetMinutes),
      planned_end_iso: formatIso(placedEnd, offsetMinutes),
      origin: 'auto',
    });
    endByTaskId.set(id, placedEnd);
    cursor = placedEnd;
  }

  return { slots, unplaceable, offsetMinutes };
}

export function detectSlotOverlaps(plans = []) {
  const blocks = [];
  for (const p of plans) {
    if (!p?.planned_start_iso || !p?.planned_end_iso) continue;
    const s = new Date(p.planned_start_iso).getTime();
    const e = new Date(p.planned_end_iso).getTime();
    if (!Number.isNaN(s) && !Number.isNaN(e) && e > s) blocks.push({ id: p.task_id, s, e });
  }
  blocks.sort((a, b) => a.s - b.s);
  const conflicts = [];
  for (let i = 0; i < blocks.length; i++) {
    for (let j = i + 1; j < blocks.length; j++) {
      if (blocks[j].s >= blocks[i].e) break;
      conflicts.push({
        kind: 'slot_overlap',
        ids: [blocks[i].id, blocks[j].id],
        message: `Planned blocks overlap between '${blocks[i].id}' and '${blocks[j].id}'. Regenerate or adjust durations.`,
      });
    }
  }
  return conflicts;
}
