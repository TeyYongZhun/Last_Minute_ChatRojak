import { runChain } from './promptChain.js';
import { mergeNewTasks, replanAll, applyDependencies, getDashboard } from './task3Executor.js';
import { MODEL, getProviderName } from '../client.js';

export async function processWithEvents(userId, text, now, emit, timeframe = 'all') {
  const lineCount = text.split('\n').filter((l) => l.trim().length > 0).length;
  emit('log', { text: `Parsing ${lineCount} message line(s) via 4-step AI chain…` });
  emit('log', { text: `Using ${getProviderName()} · ${MODEL}` });

  const chain = await runChain(userId, text, now, {
    timeframe,
    onProgress: (entry) => {
      if (!entry) return;
      emit('log', { text: entry.text });
    },
  });

  if (!chain.tasks.length) {
    if (chain.degraded) {
      emit('log', { text: 'AI API unavailable — analysis could not complete. Check your API key and provider status.' });
    }
    emit('done', {
      extracted: 0,
      plans: 0,
      conflicts: 0,
      dashboard: getDashboard(userId),
      validation: chain.validation,
    });
    return;
  }

  for (const t of chain.tasks) {
    emit('task', {
      task_id: t.id,
      task: t.task,
      category_bucket: t.category_bucket,
      category: t.category,
      deadline: t.deadline,
      assigned_by: t.assigned_by,
      tags: t.tags,
      complexity: t.complexity,
      confidence: t.confidence,
    });
  }

  emit('log', { text: `Validator verdict: ${chain.validation?.verdict || 'n/a'} (${chain.validation?.issues?.length || 0} issue(s))` });

  const { idMap, insertedIds, matchedIds } = mergeNewTasks(userId, chain.tasks);
  const linkedIds = Array.from(new Set([...insertedIds, ...matchedIds]));
  emit('stored', { inserted: insertedIds, matched: matchedIds, linked: linkedIds });
  if (matchedIds.length) {
    emit('log', { text: `Stored ${insertedIds.length} new task(s); ${matchedIds.length} matched existing.` });
  } else {
    emit('log', { text: `Stored ${insertedIds.length} task(s).` });
  }

  if (chain.dependencies?.length) {
    const { added, rejected } = applyDependencies(userId, chain.dependencies, idMap);
    if (added.length) emit('log', { text: `Added ${added.length} dependency edge(s).` });
    if (rejected.length) emit('log', { text: `Dropped ${rejected.length} dependency edge(s) (cycle/unknown).` });
  }

  const result = await replanAll(userId, now, (msg) => emit('log', { text: msg }));

  for (const c of result.conflicts) {
    emit('log', { text: `Conflict: ${c.ids.join(' ↔ ')} — ${c.message}` });
  }

  emit('log', {
    text: `Done. ${chain.tasks.length} task(s), ${result.plans.length} planned, ${result.conflicts.length} conflict(s).`,
  });

  emit('done', {
    extracted: chain.tasks.length,
    plans: result.plans.length,
    conflicts: result.conflicts.length,
    validation: chain.validation,
    dashboard: getDashboard(userId),
    stored: { inserted: insertedIds, matched: matchedIds, linked: linkedIds },
  });
}
