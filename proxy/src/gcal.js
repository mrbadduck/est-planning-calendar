// What goes on EST's Google Calendar, and how each event reads. Pure rules: no I/O, no env.
// The Worker is the only writer of the calendar (spec §6.2).

/**
 * Planning-row event: `rowToListingEvent(V)` from publish.js plus the fields below.
 * @typedef {object} GcalEvent
 * @property {string} rowId
 * @property {string} title
 * @property {string} status            lower-case: 'approved', 'cancelled', ...
 * @property {string} scheduling        lower-case: 'exact', 'month', ...
 * @property {boolean} allDay
 * @property {string} date              YYYY-MM-DD or ''
 * @property {string} start             HH:MM or ''
 * @property {string} end               HH:MM or ''
 * @property {string} venueName
 * @property {string} venueOther
 * @property {string} venueAddress      composed one-line address, or ''
 * @property {string} addressVisibility 'Registrants only' hides the address
 * @property {string} publicSummary
 * @property {string} publishStatus     'Published' etc.
 * @property {string} eventbriteUrl
 * @property {string} [externalRegistrationUrl]  absent until that column exists
 */

const DAY_MS = 86400000;

function shiftDate(iso, days) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d) + days * DAY_MS).toISOString().slice(0, 10);
}

/** Approved, exact, dated. No date window: a past event stays on the calendar. */
export function onCalendar(ev) {
  return !!ev && ev.status === 'approved' && ev.scheduling === 'exact' && !!ev.date;
}

/** Which rows the sweep looks at: date is yesterday or later. */
export function inSyncWindow(ev, todayIso) {
  return !!ev && !!ev.date && ev.date >= shiftDate(todayIso, -1);
}

function addHours(date, hhmm, hours) {
  const [h, m] = hhmm.split(':').map(Number);
  const total = h * 60 + m + hours * 60;
  const dayShift = Math.floor(total / 1440);
  const mins = ((total % 1440) + 1440) % 1440;
  const pad = (n) => String(n).padStart(2, '0');
  return { date: shiftDate(date, dayShift), time: `${pad(Math.floor(mins / 60))}:${pad(mins % 60)}` };
}

// Zero-pad H:MM so string comparison orders times correctly.
function pad2(t) { return String(t).replace(/^(\d):/, '0$1:'); }

function registrationLine(ev) {
  if (ev.publishStatus === 'Published' && ev.eventbriteUrl) return `Register: ${ev.eventbriteUrl}`;
  if (ev.externalRegistrationUrl) return `Register: ${ev.externalRegistrationUrl}`;
  return 'Registration on Eventbrite coming soon';
}

function locationOf(ev, area) {
  const venue = ev.venueAddress || ev.venueName || ev.venueOther || '';
  if (!venue) return '';
  return ev.addressVisibility === 'Registrants only' ? area || '' : venue;
}

/** Calendar API event resource. A timed event with no start time falls back to all-day. */
export function gcalEventBody(ev, { tz, gatherBase, area }) {
  const body = { summary: ev.title || '' };
  if (ev.allDay || !ev.start) {
    body.start = { date: ev.date };
    body.end = { date: shiftDate(ev.date, 1) };
  } else {
    const end = !ev.end ? addHours(ev.date, ev.start, 2)
      : { date: pad2(ev.end) < pad2(ev.start) ? shiftDate(ev.date, 1) : ev.date, time: ev.end };
    body.start = { dateTime: `${ev.date}T${ev.start}:00`, timeZone: tz };
    body.end = { dateTime: `${end.date}T${end.time}:00`, timeZone: tz };
  }
  const parts = [];
  if (ev.publicSummary) parts.push(ev.publicSummary);
  parts.push(registrationLine(ev));
  parts.push(`Sign up to help: ${gatherBase}/#/event/${ev.rowId}`);
  body.description = parts.join('\n\n');
  const location = locationOf(ev, area);
  if (location) body.location = location;
  return body;
}

function stable(v) {
  if (Array.isArray(v)) return v.map(stable);
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.keys(v).sort().map((k) => [k, stable(v[k])]));
  }
  return v;
}

export function gcalHash(body) {
  return JSON.stringify(stable(body));
}

/** What to do on the calendar: insert, patch, delete or none. `opts` as for gcalEventBody. */
export function gcalPlan(ev, storedId, lastHash, opts = {
  tz: 'America/Chicago', gatherBase: 'https://gather.eastsidetribe.org', area: 'Nashville, TN',
}) {
  if (!onCalendar(ev)) return storedId ? { op: 'delete' } : { op: 'none' };
  const body = gcalEventBody(ev, opts);
  const hash = gcalHash(body);
  if (!storedId) return { op: 'insert', body, hash };
  if (hash !== lastHash) return { op: 'patch', body, hash };
  return { op: 'none' };
}
