import { parseMessages } from './task1Parser.js';
import { mergeNewTasks, replanAll, getDashboard } from './task3Executor.js';
import { MODEL, getProviderName } from '../client.js';

export async function processWithEvents(userId, text, now, emit) {
  const lineCount = text.split('\n').filter((l) => l.trim().length > 0).length;
  emit('log', { text: `Parsing ${lineCount} message line(s)…` });

  emit('log', { text: `Extracting tasks (calling ${getProviderName()} · ${MODEL})…` });
  const tasks = await parseMessages(text, now);
  emit('log', { text: `Found ${tasks.length} task(s).` });

  if (!tasks.length) {
    emit('done', {
      extracted: 0,
      plans: 0,
      conflicts: 0,
      dashboard: getDashboard(userId),
    });
    return;
  }

  for (const t of tasks) {
    emit('task', {
      task_id: t.id,
      task: t.task,
      category: t.category,
      deadline: t.deadline,
      assigned_by: t.assigned_by,
      tags: t.tags,
    });
  }

  const cats = [...new Set(tasks.map((t) => t.category || 'Other'))];
  emit('log', { text: `Categorized → ${cats.join(', ')}` });
  const allTags = [...new Set(tasks.flatMap((t) => t.tags || []))];
  if (allTags.length) emit('log', { text: `Tagged → ${allTags.join(', ')}` });

  mergeNewTasks(userId, tasks);

  const result = await replanAll(userId, now, (msg) => emit('log', { text: msg }));

  for (const c of result.conflicts) {
    emit('log', { text: `Conflict: ${c.ids.join(' ↔ ')} — ${c.message}` });
  }

  emit('log', {
    text: `Done. ${tasks.length} task(s), ${cats.length} categor${cats.length === 1 ? 'y' : 'ies'}, ${result.conflicts.length} conflict(s).`,
  });

  emit('done', {
    extracted: tasks.length,
    plans: result.plans.length,
    conflicts: result.conflicts.length,
    dashboard: getDashboard(userId),
  });
}
