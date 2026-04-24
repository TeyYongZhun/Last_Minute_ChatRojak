import { getDb } from '../db/index.js';
import { planTasks, scorePlan } from './task2Planner.js';
import {
  generateActionsForPlan,
  pruneActionsForTask,
  removeCalendarEvent,
  sweepDueReminders,
} from './actions.js';
import { emit } from './notifier.js';
import {
  listTasks,
  listOpenTasks,
  getTask,
  nextTaskId,
  insertTask,
  updateTaskStatus,
  updateTaskField,
  updateTaskMissingFields,
  setTaskTags,
  getTagsForTasks,
  listTagCounts,
  deleteAllForUser,
  renameTaskCategory,
  setUserPriority as repoSetUserPriority,
  setCategoryBucket,
  setComplexity,
  setPriorityScores,
  setAiEisenhower,
  setUserEisenhower as repoSetUserEisenhower,
  setAiDurationMinutes,
  setUserDurationMinutes as repoSetUserDurationMinutes,
  markCompleted,
  setCalendarSyncEnabled,
} from '../db/repos/tasks.js';
import {
  listPlans,
  upsertPlan,
  updatePlanStatus,
} from '../db/repos/plans.js';
import {
  toggleChecklistItem,
  getChecklist,
} from '../db/repos/checklists.js';
import { listRecent as listRecentNotifications } from '../db/repos/notifications.js';
import { listRecent as listRecentReplanEvents, addReplanEvent, hasEventContaining } from '../db/repos/replanEvents.js';
import { addTaskEvent, listTaskEvents } from '../db/repos/taskEvents.js';
import {
  listDependencies,
  getDependenciesFor,
  safelyAddDependency,
  safelyAddMany,
  removeDependency as repoRemoveDep,
  blockedTaskIds,
} from './dependencyGraph.js';
import {
  recordEdit as recordAdaptiveEdit,
  recordDurationAdjust,
  recordQuadrantAdjust,
  shapeWeights,
  weightsSummary,
} from './adaptiveScoring.js';
import { openThread, listOpenThreads } from './clarificationLoop.js';
import { assignSlots, detectSlotOverlaps } from './slotter.js';
import { getPreferences } from '../db/repos/userPreferences.js';

function ts(d = new Date()) {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function normalizeTaskText(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function semanticKey(task) {
  return `${normalizeTaskText(task.task)}|${task.deadline_iso || ''}`;
}

export function mergeNewTasks(userId, newTasks) {
  const db = getDb();
  const idMap = {};
  const insertedIds = [];
  const matchedIds = [];

  const tx = db.transaction(() => {
    const allTasks = listTasks(userId);
    // existing must cover all users' IDs since tasks.id is a global primary key
    const existing = new Set(db.prepare('SELECT id FROM tasks').all().map((r) => r.id));
    const openSemanticKeys = new Map();
    for (const t of allTasks) {
      if (t.status !== 'done') openSemanticKeys.set(semanticKey(t), t.id);
    }

    const allocateId = () => {
      let candidate = nextTaskId();
      while (existing.has(candidate)) candidate = nextTaskId();
      return candidate;
    };

    for (const task of newTasks) {
      const t = { ...task };
      if (t.estimated_duration_minutes != null && t.ai_duration_minutes == null) {
        t.ai_duration_minutes = t.estimated_duration_minutes;
      }
      const originalId = t.id;
      const key = semanticKey(t);
      if (key.startsWith('|')) {
        // empty text — let it through
      } else if (openSemanticKeys.has(key)) {
        const matchedId = openSemanticKeys.get(key);
        idMap[originalId] = matchedId;
        matchedIds.push(matchedId);
        continue;
      }
      if (!t.id || existing.has(t.id)) t.id = allocateId();
      insertTask(userId, t);
      setTaskTags(t.id, t.tags || []);
      addTaskEvent(userId, t.id, 'created', {
        source: 'prompt_chain',
        category_bucket: t.category_bucket || 'Others',
        ai_priority: t.ai_priority || t.priority,
        confidence: t.confidence,
      });
      existing.add(t.id);
      openSemanticKeys.set(key, t.id);
      idMap[originalId] = t.id;
      insertedIds.push(t.id);
    }
  });
  tx();

  return { idMap, insertedIds, matchedIds };
}

function remapDependencies(deps, idMap) {
  return (deps || [])
    .map((d) => ({
      task_id: idMap[d.task_id] || d.task_id,
      depends_on: idMap[d.depends_on] || d.depends_on,
      reason: d.reason || null,
    }))
    .filter((d) => d.task_id && d.depends_on);
}

export function applyDependencies(userId, proposedDeps, idMap = {}) {
  const tasks = listTasks(userId);
  const knownIds = new Set(tasks.map((t) => t.id));
  const remapped = remapDependencies(proposedDeps, idMap);
  const { added, rejected } = safelyAddMany(userId, remapped, knownIds);
  for (const a of added) {
    addTaskEvent(userId, a.task_id, 'dependency_added', {
      depends_on: a.depends_on,
      reason: a.reason || null,
      source: 'ai',
    });
  }
  return { added, rejected };
}

export async function replanAll(userId, now = new Date(), onProgress) {
  const openTasks = listOpenTasks(userId);
  if (!openTasks.length) {
    return { plans: [], conflicts: [], dependencies: [] };
  }

  const allTasks = listTasks(userId);
  const doneIds = new Set(allTasks.filter((t) => t.status === 'done').map((t) => t.id));
  const blocked = blockedTaskIds(userId, doneIds);

  const weights = shapeWeights(userId);
  const weightsSummaryText = weightsSummary(userId);

  const prevPlans = listPlans(userId);
  const prevById = Object.fromEntries(prevPlans.map((p) => [p.task_id, p]));

  const { plans, conflicts } = await planTasks(openTasks, now, onProgress, {
    weights,
    weightsSummary: weightsSummaryText,
    blockedIds: blocked,
  });

  // Seed each plan with the existing slot (esp. user-pinned) so assignSlots can honour pins.
  for (const p of plans) {
    const prior = prevById[p.task_id];
    if (prior?.slot_origin === 'user' && prior.planned_start_iso && prior.planned_end_iso) {
      p.planned_start_iso = prior.planned_start_iso;
      p.planned_end_iso = prior.planned_end_iso;
      p.slot_origin = 'user';
    }
  }

  const prefs = getPreferences(userId);
  const deps = listDependencies(userId);
  const { slots, unplaceable } = assignSlots({ tasks: openTasks, plans, dependencies: deps, prefs, now });
  const slotByTaskId = Object.fromEntries(slots.map((s) => [s.task_id, s]));
  for (const p of plans) {
    const s = slotByTaskId[p.task_id];
    if (s) {
      p.planned_start_iso = s.planned_start_iso;
      p.planned_end_iso = s.planned_end_iso;
      p.slot_origin = s.origin;
    } else if (p.slot_origin !== 'user') {
      p.planned_start_iso = null;
      p.planned_end_iso = null;
      p.slot_origin = null;
    }
  }

  const taskById = Object.fromEntries(openTasks.map((t) => [t.id, t]));
  for (const u of unplaceable) {
    const task = taskById[u.task_id];
    const label = task?.task || u.task_id;
    const reason = u.reason === 'deadline_too_close'
      ? `won't fit inside working hours before its deadline`
      : `couldn't be scheduled in the planning horizon`;
    conflicts.push({
      kind: 'unplaceable',
      ids: [u.task_id],
      message: `'${label}' ${reason}.`,
    });
  }
  for (const c of detectSlotOverlaps(plans)) conflicts.push(c);

  const db = getDb();
  const tx = db.transaction(() => {
    for (const plan of plans) {
      const task = openTasks.find((t) => t.id === plan.task_id);
      if (!task) continue;
      const prev = prevById[plan.task_id];
      if (prev) {
        const delta = plan.priority_score - prev.priority_score;
        if (Math.abs(delta) >= 10 || prev.decision !== plan.decision) {
          addReplanEvent(
            userId,
            `[${ts(now)}] ${plan.task_id} priority ${prev.priority_score} → ${plan.priority_score}, decision ${prev.decision} → ${plan.decision}`
          );
          addTaskEvent(userId, plan.task_id, 'priority_changed', {
            from_score: prev.priority_score,
            to_score: plan.priority_score,
            from_decision: prev.decision,
            to_decision: plan.decision,
          });
        }
      } else {
        addReplanEvent(
          userId,
          `[${ts(now)}] ${plan.task_id} planned (priority ${plan.priority_score}, decision ${plan.decision})`
        );
        addTaskEvent(userId, plan.task_id, 'planned', {
          priority_score: plan.priority_score,
          decision: plan.decision,
          steps: plan.steps?.length || 0,
        });
      }

      if (task?.status === 'in_progress') plan.status = 'in_progress';

      upsertPlan(userId, plan);
      setPriorityScores(userId, plan.task_id, {
        aiScore: plan.ai_priority_score,
        userScore: plan.user_adjusted_score,
      });
      if (plan.complexity) setComplexity(userId, plan.task_id, plan.complexity);
      if (plan.eisenhower) setAiEisenhower(userId, plan.task_id, plan.eisenhower);
      if (plan.ai_duration_minutes != null) setAiDurationMinutes(userId, plan.task_id, plan.ai_duration_minutes);

      if (task) generateActionsForPlan(userId, plan, task, now);

      if (
        plan.decision === 'ask_user' &&
        Array.isArray(plan.missing_info_questions) &&
        plan.missing_info_questions.length
      ) {
        const prevQs = new Set(prev?.missing_info_questions || []);
        const newQs = plan.missing_info_questions.filter((q) => !prevQs.has(q));
        if (newQs.length) {
          for (const field of task?.missing_fields || []) {
            const match = newQs.find((q) => q.toLowerCase().includes(field));
            if (match) {
              openThread(userId, { taskId: plan.task_id, field, question: match });
            }
          }
          emit('clarification_needed', {
            user_id: userId,
            task_id: plan.task_id,
            task: task?.task || plan.task_id,
            questions: newQs,
            missing_fields: task?.missing_fields || [],
          });
        }
      }
    }

    for (const c of conflicts) {
      const key = `conflict:${c.kind || 'deadline_clash'}:${c.ids.slice().sort().join('|')}`;
      if (!hasEventContaining(userId, key)) {
        addReplanEvent(userId, `[${ts(now)}] ${key} — ${c.message}`);
        emit('conflict', { user_id: userId, key, ids: c.ids, kind: c.kind || 'deadline_clash', message: c.message });
      }
    }
  });
  tx();

  return { plans, conflicts, dependencies: listDependencies(userId) };
}

export function startTask(userId, taskId) {
  const task = getTask(userId, taskId);
  if (!task) return { result: 'not_found' };
  if (task.status === 'done') return { result: 'done' };
  if (task.status === 'in_progress') return { result: 'already_started' };
  if (task.status === 'blocked_waiting_info' || (task.missing_fields || []).length) {
    return { result: 'blocked', missing_fields: task.missing_fields || [] };
  }

  const allTasks = listTasks(userId);
  const doneIds = new Set(allTasks.filter((t) => t.status === 'done').map((t) => t.id));
  const myDeps = getDependenciesFor(userId, taskId).filter((d) => !doneIds.has(d.depends_on));
  if (myDeps.length) {
    return { result: 'blocked_by_deps', depends_on: myDeps.map((d) => d.depends_on) };
  }

  const db = getDb();
  const tx = db.transaction(() => {
    updateTaskStatus(userId, taskId, 'in_progress');
    updatePlanStatus(userId, taskId, 'in_progress');
    addReplanEvent(userId, `[${ts()}] Task ${taskId} started.`);
    addTaskEvent(userId, taskId, 'status_changed', { to: 'in_progress' });
  });
  tx();
  return { result: 'ok' };
}

export function completeTask(userId, taskId) {
  const task = getTask(userId, taskId);
  if (!task) return false;
  const db = getDb();
  const tx = db.transaction(() => {
    markCompleted(userId, taskId);
    setCalendarSyncEnabled(userId, taskId, 0);
    updatePlanStatus(userId, taskId, 'done');
    pruneActionsForTask(taskId);
    addReplanEvent(userId, `[${ts()}] Task ${taskId} marked done.`);
    addTaskEvent(userId, taskId, 'completed', { at: Date.now() });
  });
  tx();
  removeCalendarEvent(userId, taskId).catch(() => {});
  return true;
}

export function pauseTask(userId, taskId) {
  const task = getTask(userId, taskId);
  if (!task) return { result: 'not_found' };
  if (task.status === 'done') return { result: 'already_done' };
  if (task.status !== 'in_progress') return { result: 'not_in_progress' };
  const db = getDb();
  const tx = db.transaction(() => {
    updateTaskStatus(userId, taskId, 'pending');
    updatePlanStatus(userId, taskId, 'pending');
    addReplanEvent(userId, `[${ts()}] Task ${taskId} paused.`);
    addTaskEvent(userId, taskId, 'status_changed', { to: 'pending', from: 'in_progress' });
  });
  tx();
  return { result: 'ok' };
}

export function respondToClarification(userId, taskId, field, value) {
  const task = getTask(userId, taskId);
  if (!task) return false;
  const db = getDb();
  const tx = db.transaction(() => {
    if (field === 'deadline') {
      updateTaskField(userId, taskId, 'deadline', value);
    } else if (field === 'assigned_by') {
      updateTaskField(userId, taskId, 'assigned_by', value);
    } else if (field === 'deadline_iso') {
      updateTaskField(userId, taskId, 'deadline_iso', value);
    }
    const remaining = (task.missing_fields || []).filter((f) => f !== field);
    updateTaskMissingFields(userId, taskId, remaining);
    if (!remaining.length && task.status === 'blocked_waiting_info') {
      updateTaskStatus(userId, taskId, 'pending');
    }
    addReplanEvent(userId, `[${ts()}] Clarification for ${taskId} (${field}): '${value}'.`);
    addTaskEvent(userId, taskId, 'clarified', { field, value });
  });
  tx();
  return true;
}

export function setUserPriority(userId, taskId, priority) {
  const task = getTask(userId, taskId);
  if (!task) return false;
  repoSetUserPriority(userId, taskId, priority);
  addTaskEvent(userId, taskId, 'priority_overridden', {
    ai_priority: task.ai_priority,
    user_priority: priority,
  });
  if (priority) {
    recordAdaptiveEdit(userId, {
      task,
      aiPriority: task.ai_priority || task.priority,
      userPriority: priority,
    });
  }
  return true;
}

export function setBucket(userId, taskId, bucket) {
  const task = getTask(userId, taskId);
  if (!task) return false;
  setCategoryBucket(userId, taskId, bucket);
  addTaskEvent(userId, taskId, 'bucket_changed', { bucket });
  return true;
}

export function setUserEisenhower(userId, taskId, quadrant) {
  const task = getTask(userId, taskId);
  if (!task) return false;
  const normalized = quadrant === null || quadrant === '' ? null : quadrant;
  repoSetUserEisenhower(userId, taskId, normalized);
  addTaskEvent(userId, taskId, 'eisenhower_overridden', {
    ai_eisenhower: task.ai_eisenhower,
    user_eisenhower: normalized,
  });
  if (normalized && task.ai_eisenhower && normalized !== task.ai_eisenhower) {
    recordQuadrantAdjust(userId, {
      aiQuadrant: task.ai_eisenhower,
      userQuadrant: normalized,
    });
  }
  return true;
}

export function setUserDurationMinutes(userId, taskId, minutes) {
  const task = getTask(userId, taskId);
  if (!task) return false;
  const m = minutes == null ? null : Math.max(5, Math.min(1440, Math.round(Number(minutes))));
  repoSetUserDurationMinutes(userId, taskId, m);
  addTaskEvent(userId, taskId, 'duration_overridden', {
    ai_duration_minutes: task.ai_duration_minutes,
    user_duration_minutes: m,
  });
  if (m != null && task.ai_duration_minutes) {
    recordDurationAdjust(userId, {
      aiMinutes: task.ai_duration_minutes,
      userMinutes: m,
    });
  }
  return true;
}

export function addTaskDependency(userId, taskId, dependsOn, reason = null) {
  const t1 = getTask(userId, taskId);
  const t2 = getTask(userId, dependsOn);
  if (!t1 || !t2) return { ok: false, error: 'Task not found' };
  try {
    safelyAddDependency(userId, taskId, dependsOn, reason);
    addTaskEvent(userId, taskId, 'dependency_added', { depends_on: dependsOn, reason });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message, code: e.code };
  }
}

export function removeTaskDependency(userId, taskId, dependsOn) {
  const changed = repoRemoveDep(userId, taskId, dependsOn);
  if (changed) addTaskEvent(userId, taskId, 'dependency_removed', { depends_on: dependsOn });
  return changed > 0;
}

export function toggleStep(userId, taskId, stepIndex) {
  const task = getTask(userId, taskId);
  if (!task) return false;
  const ok = toggleChecklistItem(taskId, stepIndex);
  if (ok) addTaskEvent(userId, taskId, 'step_toggled', { index: stepIndex });
  return ok;
}

function matchesFilters(task, plan, tags, filters) {
  if (filters.bucket && task.category_bucket !== filters.bucket) return false;
  if (filters.category && (task.category || 'Other').toLowerCase() !== filters.category.toLowerCase()) return false;
  if (filters.priority && task.priority !== filters.priority) return false;
  if (filters.status) {
    if (filters.status === 'active' && task.status === 'done') return false;
    if (filters.status === 'done' && task.status !== 'done') return false;
    if (!['active', 'done'].includes(filters.status) && task.status !== filters.status) return false;
  }
  if (filters.q) {
    const needle = filters.q.toLowerCase();
    if (!task.task.toLowerCase().includes(needle)) return false;
  }
  if (filters.tags && filters.tags.length) {
    const taskTags = new Set(tags);
    for (const want of filters.tags) {
      if (!taskTags.has(want)) return false;
    }
  }
  return true;
}

export function getDashboard(userId, filters = {}) {
  const tasks = listTasks(userId);
  const plans = listPlans(userId);
  const planByTaskId = Object.fromEntries(plans.map((p) => [p.task_id, p]));
  const tagsByTask = getTagsForTasks(tasks.map((t) => t.id));
  const deps = listDependencies(userId);
  const depsByTask = {};
  for (const d of deps) (depsByTask[d.task_id] ||= []).push({ depends_on: d.depends_on, reason: d.reason });
  const doneIds = new Set(tasks.filter((t) => t.status === 'done').map((t) => t.id));
  const weights = shapeWeights(userId);
  const durationBias = weights.active ? (weights.duration || 0) : 0;

  const do_now = [];
  const in_progress = [];
  const schedule = [];
  const defer = [];
  const need_info = [];
  const waiting = [];
  const done = [];

  const ordered = tasks
    .map((task) => ({ task, plan: planByTaskId[task.id] || null }))
    .sort((a, b) => {
      const sa = a.plan?.priority_score ?? -1;
      const sb = b.plan?.priority_score ?? -1;
      return sb - sa;
    });

  for (const { task, plan } of ordered) {
    const tags = tagsByTask[task.id] || [];
    const effectivePlan = plan || {
      task_id: task.id,
      priority_score: 0,
      decision: task.missing_fields?.length ? 'ask_user' : 'defer',
      steps: [],
      conflicts: [],
      missing_info_questions: [],
      status: task.status,
      planned_start_iso: null,
      planned_end_iso: null,
      slot_origin: null,
    };
    if (!matchesFilters(task, effectivePlan, tags, filters)) continue;
    const taskDeps = depsByTask[task.id] || [];
    const depsRemaining = taskDeps.filter((d) => !doneIds.has(d.depends_on));
    const isWaiting = depsRemaining.length > 0 && task.status !== 'done';

    const aiDur = task.ai_duration_minutes ?? null;
    const userDur = task.user_duration_minutes ?? null;
    const biasedAiDur = aiDur != null
      ? Math.max(5, Math.min(1440, Math.round(aiDur * (1 + durationBias))))
      : null;
    const effectiveQuadrant = task.user_eisenhower || task.ai_eisenhower || null;

    const item = {
      task_id: task.id,
      task: task.task,
      deadline: task.deadline,
      deadline_iso: task.deadline_iso,
      assigned_by: task.assigned_by,
      priority: task.priority,
      ai_priority: task.ai_priority,
      user_priority: task.user_priority,
      ai_priority_score: task.ai_priority_score ?? effectivePlan.priority_score,
      user_adjusted_score: task.user_adjusted_score ?? effectivePlan.priority_score,
      priority_score: effectivePlan.priority_score,
      eisenhower: effectiveQuadrant,
      ai_eisenhower: task.ai_eisenhower,
      user_eisenhower: task.user_eisenhower,
      duration_minutes: userDur != null ? userDur : biasedAiDur,
      ai_duration_minutes: aiDur,
      user_duration_minutes: userDur,
      decision: isWaiting ? 'waiting' : effectivePlan.decision,
      steps: effectivePlan.steps,
      checklist: getChecklist(task.id),
      conflicts: effectivePlan.conflicts,
      missing_info_questions: effectivePlan.missing_info_questions,
      planned_start_iso: effectivePlan.planned_start_iso || null,
      planned_end_iso: effectivePlan.planned_end_iso || null,
      slot_origin: effectivePlan.slot_origin || null,
      status: task.status,
      confidence: task.confidence,
      category: task.category || 'Other',
      category_bucket: task.category_bucket || 'Others',
      complexity: task.complexity,
      tags,
      dependencies: taskDeps,
      depends_remaining: depsRemaining.map((d) => d.depends_on),
      plan_missing: !plan,
      updated_at: task.updated_at,
      completed_at: task.completed_at,
    };
    if (task.status === 'done') done.push(item);
    else if (task.status === 'in_progress') in_progress.push(item);
    else if (effectivePlan.decision === 'ask_user') need_info.push(item);
    else if (isWaiting) waiting.push(item);
    else if (effectivePlan.decision === 'do_now') do_now.push(item);
    else if (effectivePlan.decision === 'schedule') schedule.push(item);
    else defer.push(item);
  }

  return {
    do_now,
    in_progress,
    schedule,
    defer,
    need_info,
    waiting,
    done,
    notifications: listRecentNotifications(userId, 10),
    replan_events: listRecentReplanEvents(userId, 15),
    clarifications: listOpenThreads(userId),
    dependencies: deps,
    adaptation: weightsSummary(userId),
    total_tasks: tasks.length,
    available_tags: listTagCounts(userId),
    filters_applied: filters,
  };
}

export function resetUser(userId) {
  deleteAllForUser(userId);
}

export function renameCategory(userId, oldName, newName) {
  const trimmed = String(newName || '').trim();
  if (!trimmed || trimmed === oldName) return 0;
  const db = getDb();
  let changed = 0;
  const tx = db.transaction(() => {
    changed = renameTaskCategory(userId, oldName, trimmed);
    if (changed > 0) {
      addReplanEvent(userId, `[${ts()}] Category renamed: '${oldName}' → '${trimmed}'.`);
    }
  });
  tx();
  return changed;
}

export function getTimeline(userId, taskId, limit = 50) {
  if (!getTask(userId, taskId)) return null;
  return listTaskEvents(userId, taskId, limit);
}

export { sweepDueReminders };
