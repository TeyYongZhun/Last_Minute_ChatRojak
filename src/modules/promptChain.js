import { parseMessages } from './task1Parser.js';
import { categorizeTasks } from './categorizer.js';
import { planTasks } from './task2Planner.js';
import { validateRun, MAX_RETRIES_PER_VERDICT } from './validator.js';
import { shapeWeights, weightsSummary } from './adaptiveScoring.js';

function stamp() {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
}

function log(onProgress, text, kind = 'log') {
  try { onProgress?.({ kind, text, at: stamp() }); } catch {}
}

export async function runChain(userId, rawText, now, { timeframe = 'all', onProgress } = {}) {
  const trace = [];
  const record = (step, detail) => trace.push({ step, at: stamp(), ...detail });

  log(onProgress, `Step 1/4 — Extracting tasks…`, 'chain_step');
  let tasks;
  try {
    tasks = await parseMessages(rawText, now, timeframe);
    record('extract', { count: tasks.length });
    log(onProgress, `Found ${tasks.length} candidate task(s).`, 'chain_step');
  } catch (err) {
    record('extract', { error: err.message });
    log(onProgress, `Extract failed: ${err.message}. Aborting chain.`, 'error');
    return { tasks: [], plans: [], dependencies: [], conflicts: [], validation: null, degraded: true, trace };
  }
  if (!tasks.length) {
    return { tasks: [], plans: [], dependencies: [], conflicts: [], validation: null, degraded: false, trace };
  }

  log(onProgress, `Step 2/4 — Categorizing into Academic / Co-curricular / Others…`, 'chain_step');
  const cat = await categorizeTasks(tasks);
  for (const t of tasks) {
    t.category_bucket = cat.categories[t.id] || 'Others';
  }
  record('categorize', { degraded: !!cat.degraded });
  if (cat.degraded) log(onProgress, `Categorize step degraded, using heuristic fallback.`, 'warn');
  const bucketCounts = tasks.reduce((m, t) => ((m[t.category_bucket] = (m[t.category_bucket] || 0) + 1), m), {});
  log(onProgress, `Buckets → ${Object.entries(bucketCounts).map(([k, v]) => `${k}:${v}`).join(', ')}`, 'chain_step');

  const weights = shapeWeights(userId);
  const summary = weightsSummary(userId);

  log(onProgress, `Step 3/4 — Planning (steps, complexity, dependencies)…`, 'chain_step');
  let planResult = await planTasks(tasks, now, (msg) => log(onProgress, msg), {
    weights,
    weightsSummary: summary,
    blockedIds: null,
  });
  planResult = {
    plans: planResult?.plans || [],
    conflicts: planResult?.conflicts || [],
    dependencies: planResult?.dependencies || [],
    ai_degraded: !!planResult?.ai_degraded,
  };
  record('plan', { plans: planResult.plans.length, deps: planResult.dependencies.length, degraded: planResult.ai_degraded });

  log(onProgress, `Step 4/4 — Validating…`, 'chain_step');
  let validation = await validateRun({ tasks, plans: planResult.plans, dependencies: planResult.dependencies });
  record('validate', { verdict: validation.verdict, issues: validation.issues.length });

  const retriesUsed = { retry_extract: 0, retry_plan: 0 };

  while (validation.verdict !== 'ok' && validation.verdict !== 'ask_user') {
    const v = validation.verdict;
    if (retriesUsed[v] >= MAX_RETRIES_PER_VERDICT) {
      log(onProgress, `Validation verdict ${v} hit retry cap; proceeding with current output.`, 'warn');
      break;
    }
    retriesUsed[v] += 1;

    if (v === 'retry_extract') {
      log(onProgress, `Validator requested re-extract (attempt ${retriesUsed[v]}/${MAX_RETRIES_PER_VERDICT})…`, 'warn');
      try {
        tasks = await parseMessages(rawText, now, timeframe);
      } catch (err) {
        log(onProgress, `Re-extract failed: ${err.message}`, 'error');
        break;
      }
      if (!tasks.length) break;
      const cat2 = await categorizeTasks(tasks);
      for (const t of tasks) t.category_bucket = cat2.categories[t.id] || 'Others';
    }

    const next = await planTasks(tasks, now, (msg) => log(onProgress, msg), {
      weights,
      weightsSummary: summary,
    });
    planResult = {
      plans: next?.plans || [],
      conflicts: next?.conflicts || [],
      dependencies: next?.dependencies || [],
      ai_degraded: !!next?.ai_degraded,
    };
    validation = await validateRun({ tasks, plans: planResult.plans, dependencies: planResult.dependencies });
    record(v, { attempt: retriesUsed[v], verdict: validation.verdict, issues: validation.issues.length });
  }

  if (validation.verdict === 'ask_user' && validation.issues.length) {
    for (const issue of validation.issues) {
      if (!issue.task_id) continue;
      const t = tasks.find((x) => x.id === issue.task_id);
      if (!t) continue;
      const mf = new Set(t.missing_fields || []);
      if (issue.code === 'missing_deadline') mf.add('deadline');
      if (issue.code === 'low_confidence') mf.add('confidence');
      t.missing_fields = [...mf];
    }
    const reflow = await planTasks(tasks, now, (msg) => log(onProgress, msg), {
      weights,
      weightsSummary: summary,
    });
    planResult = {
      plans: reflow?.plans || [],
      conflicts: reflow?.conflicts || [],
      dependencies: reflow?.dependencies || [],
      ai_degraded: !!reflow?.ai_degraded,
    };
    record('ask_user_reflow', { issues: validation.issues.length });
  }

  return {
    tasks,
    plans: planResult.plans,
    dependencies: planResult.dependencies,
    conflicts: planResult.conflicts,
    validation,
    degraded: !!planResult.ai_degraded || !!cat.degraded,
    trace,
  };
}
