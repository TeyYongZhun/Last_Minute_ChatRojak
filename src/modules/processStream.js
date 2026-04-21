import { parseMessages } from './task1Parser.js';
import { mergeNewTasks, replanAll, getDashboard } from './task3Executor.js';
import { MODEL, getProviderName } from '../client.js';

export async function processWithEvents(text, now, emit) {
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
      dashboard: getDashboard(),
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
    });
  }

  const cats = [...new Set(tasks.map((t) => t.category || 'Other'))];
  emit('log', { text: `Categorized → ${cats.join(', ')}` });

  mergeNewTasks(tasks);

  const result = await replanAll(now, (msg) => emit('log', { text: msg }));

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
    dashboard: getDashboard(),
  });
}
