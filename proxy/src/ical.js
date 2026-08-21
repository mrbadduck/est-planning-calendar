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

// Parse a whole .ics document into [{ title, date, allDay:true }], skipping any
// VEVENT missing SUMMARY or a parseable DTSTART.
export function parseVEvents(raw) {
  const lines = unfoldLines(raw).split('\n');
  const out = [];
  let cur = null;
  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') { cur = {}; continue; }
    if (line === 'END:VEVENT') {
      if (cur && cur.summary && cur.dt) {
        const d = icalDateToYMD(cur.dt);
        if (d) out.push({ title: unescapeText(cur.summary).trim(), date: d.date, allDay: true });
      }
      cur = null;
      continue;
    }
    if (!cur) continue;
    if (line.startsWith('SUMMARY')) cur.summary = line.slice(line.indexOf(':') + 1);
    else if (line.startsWith('DTSTART')) cur.dt = line;
  }
  return out;
}
