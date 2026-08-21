/**
 * Minimal RFC 5545 iCalendar parsing — pure, no network, no Worker globals.
 *
 * Scoped to exactly what the reference-calendar feature needs: SUMMARY + the
 * date of DTSTART, emitted all-day. Verified sufficient because Google's public
 * .ics feeds contain 0 RRULE (recurrences are pre-expanded into dated VEVENTs).
 * If a future feed uses RRULE, its recurring events will be missing — add
 * expansion (or ical.js) then.
 */

// RFC 5545 line folding: a CRLF followed by a single space or tab continues the
// previous line. Unfold first, normalize to \n, so each property is one line.
export function unfoldLines(raw) {
  return String(raw).replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n[ \t]/g, '');
}

// Unescape TEXT values per RFC 5545 (\\ \, \; \n \N). Newlines -> a space
// (ref events render as a single-line chip title).
export function unescapeText(s) {
  return String(s)
    .replace(/\\n/gi, ' ')
    .replace(/\\,/g, ',')
    .replace(/\\;/g, ';')
    .replace(/\\\\/g, '\\');
}

// A DTSTART property line -> { date:'YYYY-MM-DD', allDay:true } or null.
// Handles `DTSTART;VALUE=DATE:20260907`, `DTSTART:20260911T230000Z`, and
// `DTSTART;TZID=...:20260911T180000`. We keep only the date part (v1 renders
// ref events all-day), so time zones don't shift the day for our purposes.
export function icalDateToYMD(line) {
  const v = String(line).slice(String(line).indexOf(':') + 1).trim();
  const m = v.match(/^(\d{4})(\d{2})(\d{2})/);
  if (!m) return null;
  return { date: `${m[1]}-${m[2]}-${m[3]}`, allDay: true };
}

// Parse an RRULE property line into a plain params object. Supported keys:
// FREQ, INTERVAL, COUNT, UNTIL (-> YMD), BYDAY (-> ['MO','WE',...]). Unsupported
// (BYMONTHDAY, BYMONTH, BYSETPOS, BYWEEKNO, WKST) are ignored — see expandRrule.
export function parseRrule(line) {
  const v = String(line).slice(String(line).indexOf(':') + 1).trim();
  const rule = { interval: 1, byday: [] };
  for (const part of v.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const key = part.slice(0, eq).toUpperCase();
    const val = part.slice(eq + 1);
    if (key === 'FREQ') rule.freq = val.toUpperCase();
    else if (key === 'INTERVAL') rule.interval = parseInt(val, 10) || 1;
    else if (key === 'COUNT') rule.count = parseInt(val, 10) || undefined;
    else if (key === 'UNTIL') { const m = val.match(/^(\d{4})(\d{2})(\d{2})/); if (m) rule.until = `${m[1]}-${m[2]}-${m[3]}`; }
    else if (key === 'BYDAY') rule.byday = val.split(',').map(s => s.trim().slice(-2).toUpperCase()).filter(Boolean);
  }
  return rule;
}

const _WD = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };
const _DAY = 86400000;
function _ymd(ms) {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

// Expand a recurrence into [YMD, ...] (including the start), bounded three ways:
// the rule's own COUNT/UNTIL, an optional window-end `cap` (YMD), and a hard
// `max` occurrence backstop so an unbounded rule can never loop forever.
// Supports FREQ = DAILY|WEEKLY|MONTHLY|YEARLY, INTERVAL, and WEEKLY BYDAY.
// MONTHLY/YEARLY keep the start day-of-month and skip months that lack it
// (e.g. the 31st, or Feb 29 in a common year).
export function expandRrule(startYMD, rule, cap, max = 750) {
  const freq = rule && rule.freq;
  if (!freq) return [startYMD];
  const interval = rule.interval || 1;
  const count = rule.count || null;
  const until = rule.until || null;
  const [sy, sm, sd] = startYMD.split('-').map(Number);
  const startMs = Date.UTC(sy, sm - 1, sd);
  const out = [];
  const done = (ymd) => (until && ymd > until) || (cap && ymd > cap) || out.length >= max;

  if (freq === 'WEEKLY' && rule.byday && rule.byday.length) {
    const days = [...new Set(rule.byday.map(c => _WD[c]).filter(x => x != null))].sort((a, b) => a - b);
    let weekStart = startMs - new Date(startMs).getUTCDay() * _DAY;   // Sunday of the start week
    while (out.length < max) {
      for (const dow of days) {
        const ms = weekStart + dow * _DAY;
        if (ms < startMs) continue;                                    // never before DTSTART
        const ymd = _ymd(ms);
        if (done(ymd)) return out;
        out.push(ymd);
        if (count && out.length >= count) return out;
      }
      weekStart += 7 * _DAY * interval;
      if (done(_ymd(weekStart))) break;
    }
    return out;
  }

  for (let i = 0; out.length < max; i++) {
    let ms;
    if (freq === 'DAILY') ms = startMs + i * interval * _DAY;
    else if (freq === 'WEEKLY') ms = startMs + i * interval * 7 * _DAY;
    else if (freq === 'MONTHLY') ms = Date.UTC(sy, sm - 1 + i * interval, sd);
    else if (freq === 'YEARLY') ms = Date.UTC(sy + i * interval, sm - 1, sd);
    else break;
    const ymd = _ymd(ms);
    // MONTHLY/YEARLY overflow: Date.UTC normalizes e.g. Feb 31 -> Mar 3; the day
    // no longer matches the intended one, so that period has no occurrence.
    if ((freq === 'MONTHLY' || freq === 'YEARLY') && new Date(ms).getUTCDate() !== sd) {
      if ((until && ymd > until) || (cap && ymd > cap)) break;
      continue;
    }
    if (done(ymd)) break;
    out.push(ymd);
    if (count && out.length >= count) break;
  }
  return out;
}

// Parse a whole .ics document into [{ title, date, allDay:true }], skipping any
// VEVENT missing SUMMARY or a parseable DTSTART. A VEVENT with an RRULE is
// expanded (bounded by opts.expandUntil, a window-end YMD) with its EXDATEs
// removed; without an RRULE a single occurrence is emitted.
export function parseVEvents(raw, opts = {}) {
  const cap = opts.expandUntil || null;
  const lines = unfoldLines(raw).split('\n');
  const out = [];
  let cur = null;
  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') { cur = { exdates: [] }; continue; }
    if (line === 'END:VEVENT') {
      if (cur && cur.summary && cur.dt) {
        const d = icalDateToYMD(cur.dt);
        if (d) {
          const title = unescapeText(cur.summary).trim();
          if (cur.rrule) {
            const ex = new Set(cur.exdates);
            for (const ymd of expandRrule(d.date, parseRrule(cur.rrule), cap)) {
              if (!ex.has(ymd)) out.push({ title, date: ymd, allDay: true });
            }
          } else {
            out.push({ title, date: d.date, allDay: true });
          }
        }
      }
      cur = null;
      continue;
    }
    if (!cur) continue;
    if (line.startsWith('SUMMARY')) cur.summary = line.slice(line.indexOf(':') + 1);
    else if (line.startsWith('DTSTART')) cur.dt = line;
    else if (line.startsWith('RRULE')) cur.rrule = line;
    else if (line.startsWith('EXDATE')) {
      const v = line.slice(line.indexOf(':') + 1);
      for (const tok of v.split(',')) {
        const m = tok.trim().match(/^(\d{4})(\d{2})(\d{2})/);
        if (m) cur.exdates.push(`${m[1]}-${m[2]}-${m[3]}`);
      }
    }
  }
  return out;
}
