# Intelligent Time Scheduling — Implementation Plan

## Context

Today the planner produces a priority score, an Eisenhower quadrant, and a decision (`do_now` / `schedule` / `defer` / `ask_user` / `waiting`), but **no actual time block**. Two concrete consequences:

- [src/integrations/googleCalendar.js:145](src/integrations/googleCalendar.js#L145) writes events with `start: { dateTime: task.deadline_iso }` — the event fires *at the due time*, not during a realistic work window.
- [src/modules/task2Planner.js:77](src/modules/task2Planner.js#L77) detects conflicts only by deadline proximity (<3h) and per-day overload (>4), so tasks that collide on working *capacity* (two 2h tasks landing in the same 1h free window) never get flagged.

Goal: introduce planned execution blocks so calendar events, conflict detection, and the UI all reflect *when work actually happens*, not just when it's due.

## Scope — Thin Vertical Slice

Ship a naive, own-tasks-only scheduler. Google Calendar free/busy and drag-to-reschedule are deferred to v2. Learning from user edits is v3.

### 1. Data model

- **New migration**: `src/db/migrations/006_planned_slots.sql`
  ```sql
  ALTER TABLE plans ADD COLUMN planned_start_iso TEXT;
  ALTER TABLE plans ADD COLUMN planned_end_iso TEXT;
  ALTER TABLE plans ADD COLUMN slot_origin TEXT; -- 'auto' | 'user' | null
  CREATE INDEX idx_plans_planned_start ON plans(user_id, planned_start_iso);
  ```
  Rationale: slot lives on `plans`, not `tasks`, because replanning already rewrites plans — slots inherit that lifecycle. `slot_origin` lets the slotter avoid overwriting a user-pinned time.

- **New `user_preferences` rows** (reuse whichever table exists; if none, add a narrow one in the same migration):
  - `working_day_start` (default `"09:00"`)
  - `working_day_end` (default `"18:00"`)
  - `working_days` (default `"Mon,Tue,Wed,Thu,Fri"`)
  - `slot_granularity_minutes` (default `15`)
  - `timezone` (default from `Intl.DateTimeFormat().resolvedOptions().timeZone` at first write)

- **Repo updates**: extend [src/db/repos/plans.js](src/db/repos/plans.js) — `normalisePlan`, `upsertPlan`, and a new `setPlanSlot(userId, taskId, { startIso, endIso, origin })`. Add a `user_preferences` repo if one doesn't exist (one-liner CRUD).

### 2. Slotter

New module **`src/modules/slotter.js`** exporting `assignSlots(tasks, plans, deps, prefs, now)`:

- Input: tasks with duration (`user_duration_minutes ?? ai_duration_minutes ?? 30`), deadlines, plans with `decision` and `priority_score`, the dependency graph, user prefs, and `now`.
- Output: `{ slots: [{ task_id, planned_start_iso, planned_end_iso, origin: 'auto' }], unplaceable: [{ task_id, reason }] }`.
- Algorithm (deterministic, O(n log n) sort + linear placement):
  1. **Topological sort** via `topoSort()` in [src/modules/dependencyGraph.js](src/modules/dependencyGraph.js) so dependents can't be placed before their prerequisites.
  2. Within each topological rank, sort by `priority_score DESC`, then `deadline_iso ASC`.
  3. Walk a "cursor" timeline: starting at `max(now, earliest dep's end)`, advance to the next working-hours window.
  4. For each task, place its duration into the cursor; if it would cross a non-working boundary, push to the next working window; if it would cross the deadline, mark `unplaceable` with `reason: 'deadline_too_close'`.
  5. Skip tasks with `plan.slot_origin === 'user'` — they stay pinned (read their existing slot, advance the cursor past it for subsequent tasks).
  6. Skip tasks whose `decision === 'ask_user' | 'waiting'` — they have no executable plan yet.

- **No Google free/busy** in this slice. Document the gap explicitly: the slotter will propose blocks that may overlap real Google events.

### 3. Replan integration

[src/modules/task3Executor.js](src/modules/task3Executor.js) `replanAll` — after `scorePlan` and before `upsertPlan`, invoke `assignSlots` and attach `planned_start_iso` / `planned_end_iso` to each plan. Emit a `replan_event` entry like `auto-scheduled ${n} task(s), ${unplaceable.length} unplaceable`. Surface `unplaceable` entries as `conflicts` with `kind: 'unplaceable'` so the existing conflict UI picks them up — reuse the existing `conflicts` channel, no new plumbing.

### 4. Conflict detection upgrade

[src/modules/task2Planner.js:77](src/modules/task2Planner.js#L77) `detectConflicts` — after slotter runs, add an overlap pass against `planned_*` ranges. Any pair whose planned blocks intersect becomes `kind: 'slot_overlap'`. Keep the existing `<3h deadline clash` and `>4/day overload` rules for tasks that never got a slot.

### 5. Calendar sync

[src/integrations/googleCalendar.js:141-170](src/integrations/googleCalendar.js#L141-L170) `buildEventBody`:

```js
const hasSlot = isValidDeadlineIso(plan?.planned_start_iso) && isValidDeadlineIso(plan?.planned_end_iso);
const startIso = hasSlot ? plan.planned_start_iso : task.deadline_iso;
const endIso   = hasSlot ? plan.planned_end_iso   : computeEndDateTime(startIso, resolveDurationMinutes(task));
```
Skip the `isValidDeadlineIso(task.deadline_iso)` hard-fail if a slot is present (a slot is enough). Description gets a new line: `Scheduled: ${startIso} → ${endIso} (auto)`.

### 6. UI

[static/index.html](static/index.html):

- Task card (both Power Grid and Checklist row renderers in `renderTaskRow`, `renderTaskBlock`): after the existing deadline chip, render a new `Planned: Tue 2 Apr · 14:00–15:30` chip when `plan.planned_start_iso` is present. Muted color if `slot_origin === 'auto'`, accent color if `'user'`.
- Dashboard header: add a single **Regenerate schedule** button next to "Clear Filters" that `POST /api/replan` and refreshes. (The endpoint already exists as `replanAll` infrastructure — expose it via a thin new route if not already public.)
- Calendar view ([static/index.html:1998 renderCalendar](static/index.html#L1998)): group tasks by `planned_start_iso` first, fall back to `deadline_iso`. Pill label shows planned start time instead of deadline when available.
- Account page: add a collapsed "Working hours" form that reads/writes the new prefs (start, end, days).

Defer to v2: drag to reschedule, inline time picker, per-task "pin this time" toggle (which sets `slot_origin = 'user'`).

### 7. Wiring output through the dashboard

[src/modules/task3Executor.js `getDashboard`](src/modules/task3Executor.js) line 456+ — include `planned_start_iso`, `planned_end_iso`, `slot_origin` in the per-task `item` payload so the UI can read them without a second round-trip.

## Critical files

- [src/db/migrations/006_planned_slots.sql](src/db/migrations/006_planned_slots.sql) — new
- [src/db/repos/plans.js](src/db/repos/plans.js)
- [src/modules/slotter.js](src/modules/slotter.js) — new
- [src/modules/task2Planner.js](src/modules/task2Planner.js)
- [src/modules/task3Executor.js](src/modules/task3Executor.js)
- [src/integrations/googleCalendar.js](src/integrations/googleCalendar.js)
- [static/index.html](static/index.html)

## Existing utilities to reuse (don't reinvent)

- `topoSort` / `hasCycle` / `buildAdjacency` in [src/modules/dependencyGraph.js](src/modules/dependencyGraph.js).
- `computeEndDateTime`, `isValidDeadlineIso`, `resolveDurationMinutes` in [src/integrations/googleCalendar.js](src/integrations/googleCalendar.js).
- `applyDurationBias` in [src/modules/task2Planner.js](src/modules/task2Planner.js) — slotter should use the bias-adjusted duration the user already sees in the UI.
- Existing `conflicts` emit path in [src/modules/task3Executor.js](src/modules/task3Executor.js) for surfacing `unplaceable` and `slot_overlap`.

## Testing

- **Unit**: new `test/unit/slotter.test.js` covering: respects working hours, skips non-working days, respects dep ordering, refuses to place after deadline, preserves `origin: 'user'` slots, leaves `ask_user` / `waiting` tasks unplanned.
- **Unit**: extend `test/unit/task2Planner.test.js` (if exists; create if not) for the new `slot_overlap` conflict case.
- **Integration**: extend `test/integration/scheduler.test.js` so `replanAll` writes slots and reads them back through `getDashboard`.
- **Calendar**: extend existing `googleCalendar` tests — event body uses slot when present, falls back to deadline when absent.

## Verification (end-to-end)

1. Fresh DB, `npm run migrate`. Confirm `006_planned_slots.sql` applies and `plans.planned_start_iso` exists via `sqlite3 state/app.db ".schema plans"`.
2. Process `sample_chat.txt` with two tasks. `GET /api/dashboard` returns both with non-null `planned_start_iso` / `planned_end_iso` inside working hours, and the slots don't overlap.
3. Link Google Calendar, flip `calendar_sync_enabled=1` on a task. The created event's start time equals `planned_start_iso`, not the deadline.
4. Manually edit `user_preferences.working_day_start` to `"08:00"`, hit "Regenerate schedule", confirm the earliest slot shifts to 08:00.
5. Create a dep (task B depends on A), regenerate, confirm B's `planned_start_iso >= A's planned_end_iso`.
6. Create a task with a deadline 15 minutes from now and a 60-minute duration; confirm it appears in the dashboard `conflicts` list as `unplaceable`.
7. `npx vitest run` — full suite green.

## Out of scope (explicit)

- Google Calendar free/busy awareness → v2. Documented limitation: auto-slots may overlap external events.
- Drag-to-reschedule UI → v2.
- Learning from user edits (adaptive time-of-day preference) → v3, piggybacks on the existing `adaptiveScoring` pattern.
- Multi-calendar selection, all-day events, recurring tasks — none of these exist today; leave that way.
