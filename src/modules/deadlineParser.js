import { getClient, MODEL, extractJson, withRetry } from '../client.js';

const MONTHS = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
];
const MONTH_SHORT = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, sept: 8, oct: 9, nov: 10, dec: 11,
};
const WEEKDAYS = {
  sunday: 0, sun: 0,
  monday: 1, mon: 1,
  tuesday: 2, tue: 2, tues: 2,
  wednesday: 3, wed: 3,
  thursday: 4, thu: 4, thurs: 4,
  friday: 5, fri: 5,
  saturday: 6, sat: 6,
};

const TIME_RE = /\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b|\b(\d{1,2}):(\d{2})\b/i;
const PURE_TIME_RE = /^\s*(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*$/i;

const DEFAULT_ERROR = "Couldn't understand that date — try 'Friday', '28 April 5pm', or '28/4'.";

function pad(n) { return String(n).padStart(2, '0'); }

function toIsoSgt(year, month, day, hours, minutes) {
  return `${year}-${pad(month + 1)}-${pad(day)}T${pad(hours)}:${pad(minutes)}:00+08:00`;
}

function extractTime(text) {
  const m = text.match(TIME_RE);
  if (!m) return null;
  if (m[4] != null) {
    return { hours: +m[4], minutes: +m[5] };
  }
  let h = +m[1];
  const mins = m[2] != null ? +m[2] : 0;
  const ampm = m[3] ? m[3].toLowerCase() : null;
  if (ampm === 'pm' && h < 12) h += 12;
  if (ampm === 'am' && h === 12) h = 0;
  return { hours: h, minutes: mins };
}

function monthIndexFromWord(word) {
  const w = word.toLowerCase();
  const full = MONTHS.indexOf(w);
  if (full !== -1) return full;
  if (w in MONTH_SHORT) return MONTH_SHORT[w];
  return null;
}

function parseDeterministic(rawText, now) {
  const text = rawText.trim().toLowerCase().replace(/\s+/g, ' ');
  if (!text) return { iso: null, source: null, error: 'Type a deadline.' };

  const time = extractTime(text);
  const hours = time?.hours ?? 23;
  const minutes = time?.minutes ?? 59;

  const looksLikeOnlyTime = PURE_TIME_RE.test(text);
  if (looksLikeOnlyTime) {
    return { iso: null, source: null, error: "Include a day or date too — e.g. 'Friday 4pm' or '28 April'." };
  }

  // today / tomorrow
  if (/\btoday\b/.test(text)) {
    const d = new Date(now);
    return { iso: toIsoSgt(d.getFullYear(), d.getMonth(), d.getDate(), hours, minutes), source: 'relative', error: null };
  }
  if (/\btomorrow\b|\btmr\b|\btmrw\b/.test(text)) {
    const d = new Date(now);
    d.setDate(d.getDate() + 1);
    return { iso: toIsoSgt(d.getFullYear(), d.getMonth(), d.getDate(), hours, minutes), source: 'relative', error: null };
  }

  // Weekday (possibly prefixed with "next")
  const wdMatch = text.match(/\b(next\s+)?(sun(?:day)?|mon(?:day)?|tue(?:s(?:day)?)?|wed(?:nesday)?|thu(?:rs(?:day)?)?|fri(?:day)?|sat(?:urday)?)\b/);
  if (wdMatch) {
    const key = wdMatch[2];
    const targetDow = WEEKDAYS[key] ?? WEEKDAYS[key.slice(0, 3)];
    if (targetDow != null) {
      const todayDow = now.getDay();
      let delta = (targetDow - todayDow + 7) % 7;
      // "|| 7" rolls same-weekday input forward, "next <day>" always rolls forward at least 7 if already same week
      if (delta === 0) delta = 7;
      if (wdMatch[1] && delta < 7) delta += 7;
      const d = new Date(now);
      d.setDate(d.getDate() + delta);
      return { iso: toIsoSgt(d.getFullYear(), d.getMonth(), d.getDate(), hours, minutes), source: 'weekday', error: null };
    }
  }

  // Slash date: D/M[/YY]
  const slash = text.match(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/);
  if (slash) {
    const day = +slash[1];
    const month = +slash[2] - 1;
    let year = slash[3] ? +slash[3] : now.getFullYear();
    if (year < 100) year += 2000;
    const d = new Date(year, month, day);
    if (!isNaN(d.getTime()) && d.getMonth() === month && d.getDate() === day) {
      return { iso: toIsoSgt(d.getFullYear(), d.getMonth(), d.getDate(), hours, minutes), source: 'regex', error: null };
    }
  }

  // Month-word date: "28 April", "April 28", "Apr 28 2026"
  const monthWord = text.match(
    /\b(\d{1,2})\s+([a-z]+)(?:\s+(\d{4}))?\b|\b([a-z]+)\s+(\d{1,2})(?:\s+(\d{4}))?\b/
  );
  if (monthWord) {
    let day, monthStr, yearStr;
    if (monthWord[1]) { day = +monthWord[1]; monthStr = monthWord[2]; yearStr = monthWord[3]; }
    else { day = +monthWord[5]; monthStr = monthWord[4]; yearStr = monthWord[6]; }
    const monthIdx = monthIndexFromWord(monthStr);
    if (monthIdx != null && day >= 1 && day <= 31) {
      let year = yearStr ? +yearStr : now.getFullYear();
      let d = new Date(year, monthIdx, day, hours, minutes, 0, 0);
      if (!isNaN(d.getTime()) && d.getMonth() === monthIdx && d.getDate() === day) {
        // If no year given and the date already passed, bump to next year
        if (!yearStr && d.getTime() < now.getTime() - 12 * 3600 * 1000) {
          year += 1;
          d = new Date(year, monthIdx, day, hours, minutes, 0, 0);
        }
        return { iso: toIsoSgt(d.getFullYear(), d.getMonth(), d.getDate(), hours, minutes), source: 'regex', error: null };
      }
    }
  }

  return { iso: null, source: null, error: null };
}

async function parseViaAI(rawText, now) {
  const todayIso = toIsoSgt(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours(), now.getMinutes());
  const systemPrompt = `Convert a user-provided deadline phrase into an ISO 8601 timestamp with +08:00 offset.
Rules:
- If only a date is inferable, use 23:59 local.
- If only a time is given with no date hint, return null.
- If nothing sensible can be inferred, return null.
Output ONLY JSON (no markdown): {"iso": "YYYY-MM-DDTHH:mm:00+08:00" | null, "reason": "short explanation when iso is null"}`;

  const userBody = `Today (local +08:00): ${todayIso}\nUser input: "${rawText}"`;

  const client = getClient();
  const response = await withRetry(() =>
    client.chat.completions.create({
      model: MODEL,
      temperature: 0,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userBody },
      ],
    })
  );
  const content = response.choices?.[0]?.message?.content || '';
  const data = extractJson(content);
  const iso = typeof data?.iso === 'string' ? data.iso : null;
  if (iso) {
    const test = new Date(iso);
    if (!isNaN(test.getTime())) {
      return { iso, source: 'ai', error: null };
    }
  }
  const reason = typeof data?.reason === 'string' && data.reason.trim() ? data.reason.trim() : null;
  return { iso: null, source: null, error: reason || DEFAULT_ERROR };
}

export async function parseClarificationDeadline(text, now = new Date()) {
  if (typeof text !== 'string' || !text.trim()) {
    return { iso: null, source: null, error: 'Type a deadline.' };
  }
  const deterministic = parseDeterministic(text, now);
  if (deterministic.iso) return deterministic;
  if (deterministic.error) return deterministic;

  try {
    return await parseViaAI(text, now);
  } catch (err) {
    console.error('[deadlineParser] AI fallback failed:', err.message);
    return { iso: null, source: null, error: DEFAULT_ERROR };
  }
}
