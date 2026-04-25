import { getClient, MODEL, extractJson, withRetry } from '../client.js';

const SYSTEM_PROMPT = `You are a task extraction AI. Given raw WhatsApp chat messages, identify and extract actionable tasks.

For each actionable task found, produce:
- id: unique string starting from t1, t2, ...
- task: the exact wording of the actionable request from the source message, copied verbatim. Do NOT paraphrase, rewrite, summarize, shorten, expand, or "improve" it. Do NOT invent sub-tasks (e.g. do not turn "Attend Monday presentation at 9am" into "Prepare slides for Monday presentation"). You may ONLY (a) trim surrounding punctuation/whitespace, and (b) remove a leading imperative connector word like "pls", "please", "can you", "make sure to" if present. Otherwise preserve the original characters, including capitalization, spacing, emoji, and embedded times/dates.
- deadline: human-readable deadline (e.g., "Friday 11:59pm") or null
- deadline_iso: ISO 8601 datetime relative to the current time provided, or null if unknown. Assume +08:00 timezone.
- assigned_by: who assigned/requested it (e.g., "Lecturer", "Classmate", "CS Society") or null
- priority: "high", "medium", or "low" based on urgency and source
- estimated_duration_minutes: integer 5..1440, best guess of focused work time needed. Do not pad for breaks. Examples: a 30-second reply ≈ 5, a short reading ≈ 15, a problem set ≈ 90, a full essay draft ≈ 240.
- confidence: 0.0-1.0 how confident you are this is a real actionable task
- missing_fields: array of important missing fields, e.g. ["deadline"] or ["assigned_by"]
- category: short label (1-2 words) for the kind of task — pick a natural label from the chat itself, e.g. "Academic", "CCA", "Admin", "Errand". Reuse the same label across related tasks in the same chat.

Rules:
- VERBATIM TASK TEXT: The 'task' field must be a substring (or near-substring after allowed trimming) of the original chat message. If you find yourself writing words that are not in the source message, stop and copy the source phrase instead.
- Only extract ACTIONABLE tasks that require the reader to DO something
- Ignore casual replies, greetings, acknowledgements ("ok", "noted", "sure np", "lol", "hahaha")
- TIMEFRAME FILTER: If a timeframe filter is specified in the user message, read the timestamps on each chat message carefully. Completely skip and ignore any messages outside the allowed date range — do not extract tasks from them.
- DEDUPLICATE: if the same task is mentioned multiple times, extract it ONCE using the most recent confirmed deadline
- QUESTIONS vs STATEMENTS: Messages ending with "?" are questions/suggestions, NOT confirmed facts. Only treat a time/deadline as confirmed if it is stated as a declaration (e.g. "meeting tmr 3pm"), not as a question (e.g. "meeting tmr 3pm?")
- When deadlines conflict, use the LATEST authoritative statement from the person who assigned the task
- "before Friday" means the deadline is end of Thursday (Thursday 11:59pm), NOT Friday
- "by Friday" means end of Friday (Friday 11:59pm)
- When a date is given but NO specific time is mentioned, always set the deadline_iso time to 23:59:00 (11:59 PM) of that day in +08:00 timezone (e.g. "2026-04-25T23:59:00+08:00"). Never default to midnight or any other time.
- Relative days like "tmr", "tomorrow", "next Monday" must be resolved using the current time provided
- If confidence < 0.6 still include it but list missing_fields
- Generate IDs starting at t1 counting up

Output ONLY a single valid JSON object, no markdown, no commentary:
{"tasks": [ ... ]}`;

const TEAM_SYSTEM_PROMPT = `You are a task extraction AI for TEAM chats. Multiple users converse and assign work to each other.

You are given a participants list (e.g. ["You", "John", "Sarah"]). The current logged-in user is always labelled "You" — that is their literal name in this output.

For each actionable task found, produce:
- id: unique string starting from t1, t2, ...
- task: the exact wording of the actionable request from the source message, copied verbatim. Do NOT paraphrase, rewrite, summarize, shorten, expand, or "improve" it. Allowed: trim surrounding punctuation/whitespace; remove a leading imperative connector word like "pls", "please", "can you", "make sure to".
- assigned_to: array of names. Apply these rules strictly:
   1. Direct assignment: "John, can you do slides?" → ["John"]
   2. Multiple users: "John and Sarah handle design" → ["John","Sarah"]
   3. Group assignment: "Everyone prepare your part" → ALL participants
   4. Self assignment: "I'll write the report" said by the speaker → [speaker]. The speaker of a "I'll …" / "I will …" / "I can …" message is whoever sent that line.
   5. Unclear → []. DO NOT GUESS.
   Only use names from the participants list. NEVER invent users.
- assigned_by: the speaker of the message that contains the assignment (the name appearing as the chat sender, e.g. "Sarah:" → "Sarah"). If the speaker is the logged-in user, use "You".
- deadline: human-readable deadline (e.g., "Friday 11:59pm") or null
- deadline_iso: ISO 8601 datetime relative to the current time provided, or null if unknown. Assume +08:00 timezone.
- priority: "high" | "medium" | "low"
- estimated_duration_minutes: integer 5..1440, best guess of focused work time
- confidence: 0.0-1.0 how confident you are this is a real actionable task
- missing_fields: array of important missing fields. If assigned_to is empty, include "assigned_to". Also include "deadline" or "assigned_by" if those are missing.
- category: short label (1-2 words) — "Academic", "Work", "Errand", etc.

Rules:
- VERBATIM TASK TEXT: 'task' must be a substring (or near-substring after allowed trimming) of the original chat message.
- Only extract ACTIONABLE tasks. Ignore greetings, acknowledgements, casual chat.
- TIMEFRAME FILTER: if a timeframe filter is specified, ignore messages outside that range.
- DEDUPLICATE: same task mentioned multiple times → extract once with the latest confirmed deadline.
- QUESTIONS vs STATEMENTS: messages ending in "?" are not confirmed facts.
- When deadlines conflict, use the LATEST authoritative statement from the assigner.
- "before Friday" → end of Thursday. "by Friday" → end of Friday.
- When a date has no time, set deadline_iso time to 23:59:00 in +08:00.
- Relative days like "tmr", "tomorrow" resolve against the current time provided.
- Generate IDs starting at t1.

Output ONLY a single valid JSON object, no markdown:
{"mode":"team","tasks":[ ... ]}`;

function normalize(t, index, participantsSet) {
  const priority = ['high', 'medium', 'low'].includes(t.priority) ? t.priority : 'medium';
  const rawDur = t.estimated_duration_minutes;
  const estimated_duration_minutes = typeof rawDur === 'number' && isFinite(rawDur)
    ? Math.max(5, Math.min(1440, Math.round(rawDur)))
    : null;

  let assigned_to = null;
  if (participantsSet) {
    const raw = Array.isArray(t.assigned_to) ? t.assigned_to : [];
    const filtered = [];
    const seen = new Set();
    for (const name of raw) {
      if (typeof name !== 'string') continue;
      const trimmed = name.trim();
      if (!trimmed || !participantsSet.has(trimmed) || seen.has(trimmed)) continue;
      seen.add(trimmed);
      filtered.push(trimmed);
    }
    assigned_to = filtered;
  }

  const missing = Array.isArray(t.missing_fields) ? [...t.missing_fields] : [];
  if (participantsSet && (!assigned_to || assigned_to.length === 0) && !missing.includes('assigned_to')) {
    missing.push('assigned_to');
  }

  return {
    id: String(t.id || `t${index + 1}`),
    task: String(t.task || '').trim(),
    deadline: t.deadline ?? null,
    deadline_iso: t.deadline_iso ?? null,
    assigned_by: t.assigned_by ?? null,
    assigned_to,
    priority,
    ai_priority: priority,
    user_priority: null,
    confidence: typeof t.confidence === 'number' ? Math.max(0, Math.min(1, t.confidence)) : 0.8,
    missing_fields: missing,
    category: typeof t.category === 'string' && t.category.trim() ? t.category.trim() : 'Other',
    complexity: null,
    estimated_duration_minutes,
    status: 'pending',
  };
}

function buildTimeframeInstruction(timeframe, now) {
  if (timeframe === 'last7') {
    const cutoff = new Date(now);
    cutoff.setDate(cutoff.getDate() - 7);
    return `Timeframe filter: Only extract tasks from messages dated on or after ${cutoff.toDateString()} (last 7 days). Completely ignore messages with timestamps before this date.`;
  }
  if (timeframe === 'thisMonth') {
    const cutoff = new Date(now.getFullYear(), now.getMonth(), 1);
    return `Timeframe filter: Only extract tasks from messages dated on or after ${cutoff.toDateString()} (this calendar month). Completely ignore messages with timestamps before this date.`;
  }
  return '';
}

function normaliseParticipants(participants) {
  if (!Array.isArray(participants)) return null;
  const seen = new Set();
  const list = [];
  for (const raw of participants) {
    if (typeof raw !== 'string') continue;
    const name = raw.trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    list.push(name);
  }
  if (!seen.has('You')) {
    list.unshift('You');
    seen.add('You');
  }
  return list.length >= 2 ? list : null;
}

export async function parseMessages(rawText, now, timeframe = 'all', { onProgress, participants = null } = {}) {
  const client = getClient();
  const timeframeNote = buildTimeframeInstruction(timeframe, now);
  const team = normaliseParticipants(participants);
  const isTeam = !!team;
  const participantsSet = isTeam ? new Set(team) : null;

  const userContent = [
    `Current time: ${now.toISOString()}`,
    isTeam ? `Participants: ${JSON.stringify(team)}` : '',
    isTeam ? 'The current logged-in user is "You". The chat sender names map to participants.' : '',
    timeframeNote,
    '',
    'Chat messages to analyze:',
    '',
    rawText,
  ].filter(Boolean).join('\n');

  let response;
  try {
    response = await withRetry(
      () => client.chat.completions.create({
        model: MODEL,
        temperature: 0.3,
        messages: [
          { role: 'system', content: isTeam ? TEAM_SYSTEM_PROMPT : SYSTEM_PROMPT },
          { role: 'user', content: userContent },
        ],
      }),
      { onRetry: (msg) => onProgress?.({ kind: 'warn', text: msg }) }
    );
  } catch (err) {
    const wrapped = new Error(`Extract step failed: ${err.message}`);
    wrapped.cause = err;
    wrapped.step = 'extract';
    throw wrapped;
  }

  const content = response.choices?.[0]?.message?.content || '';
  const data = extractJson(content);
  const rawTasks = Array.isArray(data.tasks) ? data.tasks : [];
  return rawTasks
    .map((t, i) => normalize(t, i, participantsSet))
    .filter((t) => t.task.length > 0);
}
