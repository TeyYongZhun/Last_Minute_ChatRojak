# Eisenhower "Power Grid" Redesign — Triple-Threat Task Planner

## Context

The app today ranks tasks with a single `priority_score` (0–100) and a decision bucket (`do_now`/`schedule`/`defer`). That collapses three independent signals into one number and loses the strategic picture — you can't see "I have 6h of High-Importance work due tomorrow but only 4h free."

This change reintroduces the three signals as orthogonal dimensions:

| Signal | Source | Visual role |
|---|---|---|
| **Eisenhower quadrant** (urgent × important) | AI classifies, user can override | Which cell the task sits in |
| **Duration** (minutes) | AI estimates, user resizes block | Block height |
| **Deadline** (already tracked) | Existing `deadline_iso` | Gravity — pushes task upward in its quadrant |

The Dashboard becomes a 2×2 **Power Grid**. Tasks render as draggable, resizable blocks. Dragging across quadrants and resizing blocks both feed `src/modules/adaptiveScoring.js`, so the AI's next extraction uses the user's biases. The existing decision-bucket logic stays untouched — `decision` drives replanning; quadrant drives UI.

**User-confirmed scope:** Power Grid replaces the current Dashboard layout. Checklist stays linear but swaps category/priority chips for quadrant + duration chips. Quadrant labels: **Do Now / Plan / Quick Wins / Later** (internal keys: `do`/`plan`/`quick`/`later`).

**Out of scope:** mobile drag/resize (mouse/trackpad only v1), chunk-level Eisenhower on individual checklist steps (task-level only), calendar integration for the overload heuristic.

---

## Critical files

**New:**
- `src/db/migrations/003_eisenhower.sql`

**Modified:**
- `src/modules/task1Parser.js` — prompt + `normalize()`
- `src/modules/task2Planner.js` — add `scoreEisenhower()`; thread into `scorePlan`
- `src/modules/adaptiveScoring.js` — add `recordDurationAdjust`, `recordQuadrantAdjust`; extend `weightsSummary`
- `src/db/repos/adaptation.js` — read/write new bias columns
- `src/db/repos/tasks.js` — new setters `setUserEisenhower`, `setUserDuration` (mirror `setUserPriority` at tasks.js:113–117)
- `src/modules/task3Executor.js` — widen `getDashboard` item shape (task3Executor.js:428–456)
- `src/server.js` — two new endpoints; follow the `/priority` route at server.js:238 as template
- `static/index.html` — Dashboard markup + JS (Power Grid), Checklist chip swap, Account rename

---

## Step 1 — Migration `003_eisenhower.sql`

```sql
-- Eisenhower quadrant + duration on tasks
ALTER TABLE tasks ADD COLUMN ai_eisenhower TEXT;           -- 'do' | 'plan' | 'quick' | 'later'
ALTER TABLE tasks ADD COLUMN user_eisenhower TEXT;
ALTER TABLE tasks ADD COLUMN ai_duration_minutes INTEGER;
ALTER TABLE tasks ADD COLUMN user_duration_minutes INTEGER;

-- New biases on adaptation_weights (parallels urgency/importance/effort biases)
ALTER TABLE adaptation_weights ADD COLUMN duration_bias REAL NOT NULL DEFAULT 0.0;
  -- log-ratio of user-estimate / AI-estimate, clamped to [-0.5, +0.5].
  -- Applied as a multiplier on AI duration predictions.
ALTER TABLE adaptation_weights ADD COLUMN quadrant_urgent_bias REAL NOT NULL DEFAULT 0.0;
ALTER TABLE adaptation_weights ADD COLUMN quadrant_important_bias REAL NOT NULL DEFAULT 0.0;
  -- [-0.25, +0.25] shifts to scoreEisenhower thresholds.
```

Wire into the existing migration runner in `src/db/migrate.js` — the pattern from `002_advanced.sql` is sufficient (no data backfill needed; new columns are nullable / default 0).

## Step 2 — AI pipeline

**`task1Parser.js` (lines 3–41 prompt, 70–88 normalize):** Add one field to the SYSTEM_PROMPT schema and one line to `normalize()`:

```
- estimated_duration_minutes: integer 5..1440, best guess of focused work time. Do not pad for breaks.
```

```js
estimated_duration_minutes: typeof t.estimated_duration_minutes === 'number'
  ? Math.max(5, Math.min(1440, Math.round(t.estimated_duration_minutes)))
  : null,
```

**`task2Planner.js` (add near line 41, use from scorePlan line 162–222):** No extra LLM call — quadrant is computed deterministically from the existing `scoreUrgency` / `scoreImportance` outputs, biased by user weights.

```js
export function scoreEisenhower(urgency, importance, weights = null) {
  const w = weights?.active ? weights : { quadrant_urgent: 0, quadrant_important: 0 };
  const urgentThreshold    = 65 - (w.quadrant_urgent    * 30);  // more drags to 'do' lowers threshold
  const importantThreshold = 30 - (w.quadrant_important * 20);
  const urgent    = urgency    >= urgentThreshold;
  const important = importance >= importantThreshold;
  if (urgent && important)  return 'do';
  if (!urgent && important) return 'plan';
  if (urgent && !important) return 'quick';
  return 'later';
}
```

In `scorePlan` (line ~173), compute and attach `eisenhower_quadrant` per task alongside the existing `priority_score`. Apply `ai_duration_minutes * (1 + duration_bias)` when setting the per-item display duration. Persist `ai_eisenhower` + `ai_duration_minutes` into the `tasks` table via `taskMerge.js` (the same place `ai_priority_score` lands today).

**`adaptiveScoring.js` (add after line 48, using the `clamp` + `ALPHA` + `upsertWeights` helpers already defined at lines 4–10, 27–48):**

```js
export function recordDurationAdjust(userId, { aiMinutes, userMinutes }) {
  if (!aiMinutes || !userMinutes || aiMinutes === userMinutes) return;
  const ratio = Math.log(userMinutes / aiMinutes);   // +ve = user thinks slower
  const delta = Math.max(-0.5, Math.min(0.5, ratio));
  const cur = getWeights(userId);
  const next = {
    ...cur,
    duration_bias: clamp(cur.duration_bias * (1 - ALPHA) + delta * ALPHA, -0.5, 0.5),
    sample_count: (cur.sample_count || 0) + 1,
  };
  upsertWeights(userId, next);
  return next;
}

export function recordQuadrantAdjust(userId, { aiQuadrant, userQuadrant }) {
  if (!aiQuadrant || !userQuadrant || aiQuadrant === userQuadrant) return;
  const bools = { do: [1,1], plan: [0,1], quick: [1,0], later: [0,0] };
  const [au, ai] = bools[aiQuadrant] ?? [0,0];
  const [uu, ui] = bools[userQuadrant] ?? [0,0];
  const cur = getWeights(userId);
  const next = { ...cur };
  if (uu !== au) next.quadrant_urgent_bias    = clamp(cur.quadrant_urgent_bias    * (1 - ALPHA) + (uu - au) * ALPHA * 0.15);
  if (ui !== ai) next.quadrant_important_bias = clamp(cur.quadrant_important_bias * (1 - ALPHA) + (ui - ai) * ALPHA * 0.15);
  next.sample_count = (cur.sample_count || 0) + 1;
  upsertWeights(userId, next);
  return next;
}
```

Extend `weightsSummary` (line 64–73) to mention duration / quadrant biases when `|bias| >= 0.02`. Extend `shapeWeights` (line 50–62) to return the two new quadrant biases and the duration bias so `scoreEisenhower` and the display-duration calc can read them.

## Step 3 — API endpoints (follow `/priority` route at `server.js:238`)

```js
app.post('/api/tasks/:taskId/eisenhower', requireUser, async (req, res) => {
  const { quadrant } = req.body;                          // 'do' | 'plan' | 'quick' | 'later' | null
  const task = getTask(req.user.id, req.params.taskId);
  if (!task) return res.status(404).json({ detail: 'Task not found' });
  setUserEisenhower(req.user.id, req.params.taskId, quadrant);
  if (quadrant) recordQuadrantAdjust(req.user.id, { aiQuadrant: task.ai_eisenhower, userQuadrant: quadrant });
  res.json({ ok: true });
});

app.post('/api/tasks/:taskId/duration', requireUser, async (req, res) => {
  const minutes = Math.max(5, Math.min(1440, Number(req.body.minutes) || 0));
  const task = getTask(req.user.id, req.params.taskId);
  if (!task) return res.status(404).json({ detail: 'Task not found' });
  setUserDuration(req.user.id, req.params.taskId, minutes);
  recordDurationAdjust(req.user.id, { aiMinutes: task.ai_duration_minutes, userMinutes: minutes });
  res.json({ ok: true });
});
```

No `replanAll` needed — quadrant/duration don't feed the decision bucket. Scoring of *future* extractions picks up the updated biases automatically.

## Step 4 — Dashboard response (`task3Executor.js:428–456`)

Add per-item:
- `eisenhower` = `user_eisenhower ?? ai_eisenhower`
- `ai_eisenhower`, `user_eisenhower`
- `duration_minutes` = `user_duration_minutes ?? round(ai_duration_minutes * (1 + duration_bias))`
- `ai_duration_minutes`, `user_duration_minutes`

No server-side `by_eisenhower` grouping — client does it.

## Step 5 — Frontend: the Power Grid (`static/index.html`)

**Dashboard markup** — replace the current stat-cards + two-column layout with:
```
Stat strip (Active · Due Today · Completed · avg Duration) ← existing 3 cards + 1 new
Overload banner (conditional)
Power Grid (2×2)
  ┌──────────────┬──────────────┐
  │  Do Now      │  Plan        │
  │  (↑ imp/urg) │  (↑ imp)     │
  ├──────────────┼──────────────┤
  │  Quick Wins  │  Later       │
  │  (↑ urg)     │              │
  └──────────────┴──────────────┘
Needs Clarification · Clarification Inbox · Dependency Graph  ← existing, kept
```

**Task block** — CSS class `.task-block`, `draggable="true"`:
- Height: `clamp(52px, 28 + minutes * 1.1, 320px)` — ~1px/min with floor and ceiling
- Normal bg white, `shadow-xs`, `border-[var(--border)]`
- **Missing info** (`missing_fields.length > 0`): `opacity:0.55`, `border-style:dashed`, top-right badge "needs info"
- Bottom-right grip icon → resize handle

**JS** — add to `static/index.html`, near the existing `renderTasks` helper:
- `renderPowerGrid(data)` — bucket dashboard items by `item.eisenhower`, render into four `.quadrant-body` drop zones
- **Drag**: on `dragstart`, set `dataTransfer` with task id + source quadrant. On `.quadrant-body` `dragover` → `preventDefault()`; on `drop` → DOM move + `POST /api/tasks/:id/eisenhower` + optimistic UI (revert on fail)
- **Resize**: `mousedown` on `.task-block-resize` → capture Y, `mousemove` → translate Δpx into Δminutes (snap to 15), update block height live, on `mouseup` → `POST /api/tasks/:id/duration`
- **Overload banner**: sum `duration_minutes` for `eisenhower === 'do'` items with `deadline_iso` within 24h; if > 360 (6h heuristic), show `"⚠ X h of Do Now work due in the next day — typical capacity is ~6 h"`

**Helper: `fmtDuration(min)` → `"1h 30m"` / `"45m"` / `"2h"`**

## Step 6 — Checklist chip swap

In the task-row template inside `renderTaskRow` (currently renders `cat-pill` + `priority-pill`), replace with:
- **Quadrant pill** — coloured background: Do Now `var(--primary)` white, Plan `var(--success)` white, Quick Wins `var(--warn)` white, Later `var(--accent)` text-muted
- **Duration pill** — neutral: `bg-white border` `· 60m`

Keep all other row state (dot, tag chips, deadline line, group-by-chat layout from prior work).

## Step 7 — Task modal: add duration + quadrant controls

In the modal's grid of meta rows (around `modal-priority-override`), add two rows:
- **Quadrant** select with 4 options — `onchange` → same endpoint as drop
- **Duration** input `type="number"` + minutes label — `onchange` → same endpoint as resize

Provides a keyboard path for users who don't want to drag.

## Step 8 — Account: rename to "AI Memory"

In `static/index.html` Account view, change the card heading "Adaptive Priority Learning" → "AI Memory". Keep the same `resetAdaptation()` button. Update the section copy from *"The system learns from your priority overrides to better rank future tasks."* to *"The AI learns from every priority change, duration tweak, and quadrant drag. These memories shape future extractions."* The server-side `weightsSummary` now renders all five biases, so no extra display wiring is needed beyond calling the existing `/api/adaptation`.

---

## Verification

1. `npm run dev` — migration 003 runs on server start (migrate.js autoruns pending migrations). Watch logs for `applied migration 003_eisenhower.sql`.
2. Hard-refresh `http://localhost:8000`. Log in.
3. **Upload + extract** a sample chat — confirm console logs include `estimated_duration_minutes` on extracted tasks.
4. **Dashboard**: Power Grid renders four labelled quadrants. Tasks appear in the correct quadrant (verify by checking a known-urgent task lands in Do Now / Quick Wins per its importance).
5. **Missing info**: a task with empty `deadline_iso` or `assigned_by` renders greyed with dashed border and a "needs info" badge.
6. **Drag**: drag a block from Quick Wins to Do Now. Block settles. Refresh the page — the block is still in Do Now (persisted). Check the Account view's AI Memory summary — sample count bumped.
7. **Resize**: drag the bottom-right grip on a 60-min block upward; block grows in 15-min snaps. Release. Reload — the new duration persists. Run enough resizes (≥ 5 in the same direction) to flip the `duration_bias` display.
8. **Modal path**: open a task modal, change the Quadrant select + Duration input, close. Dashboard reflects the change.
9. **Checklist**: each task row shows one coloured quadrant pill + one neutral duration pill; groupings by chat are preserved.
10. **Account**: section heading reads "AI Memory"; summary line mentions urgency / importance / effort / duration / quadrant biases when any are active. Reset button still works.
11. **Overload banner**: craft a chat with 3 tasks each `estimated_duration_minutes: 180` due tomorrow. Banner appears over the grid.
12. **Regression check**: existing flows (Checklist filters, Calendar dots, Clarification Inbox, Reset-All, Google Calendar link card) still work.

## Risks

- **Duration bias applied twice**: make sure display-duration (post-bias) is computed server-side in `getDashboard` only; frontend should not re-bias. One source of truth.
- **Resize glitches while dragging**: `.task-block-resize` needs `stopPropagation` on `mousedown` so it doesn't also start a drag.
- **Migration on existing users**: all four new task columns are nullable — existing tasks simply lack quadrant/duration until re-extracted. Dashboard renderer must treat `null` quadrant as "Later" (safest default) and missing duration as the 52px floor.
- **SQLite `ALTER TABLE ADD COLUMN` can't set `NOT NULL` without default** — handled: bias columns use `DEFAULT 0.0`; task columns are nullable.
- **Optimistic drag UX**: keep the DOM in a pending state while the POST is in flight; revert and toast on 4xx/5xx.
