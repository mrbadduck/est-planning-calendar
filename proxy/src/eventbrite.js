/**
 * Pure Eventbrite v3 payload + date builders — no network, no Worker globals.
 * The rich description goes through Structured Content (event.description was
 * deprecated 2021); publish requires a ticket class + venue/online.
 */

// Offset (ms) of `tz` at a given instant: format that instant AS the tz, read it
// back as if UTC, subtract. Intl with timeZone is available in Workers and Node.
function tzOffsetMs(instant, tz) {
  const s = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).format(instant);
  const [d, t] = s.split(', ');
  const [mo, da, yr] = d.split('/').map(Number);
  const [hh, mi, ss] = t.split(':').map(Number);
  return Date.UTC(yr, mo - 1, da, hh, mi, ss) - instant.getTime();
}

// A local wall-clock date+time in `tz` -> a UTC ISO string 'YYYY-MM-DDTHH:MM:SSZ'.
// Two-pass to be correct across DST boundaries.
export function zonedToUtcISO(dateStr, timeStr, tz) {
  const [Y, M, D] = dateStr.split('-').map(Number);
  const [h, m] = String(timeStr || '00:00').split(':').map(Number);
  const guess = Date.UTC(Y, M - 1, D, h, m, 0);
  let utc = guess - tzOffsetMs(new Date(guess), tz);
  utc = guess - tzOffsetMs(new Date(utc), tz);
  return new Date(utc).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

const stripHtml = (s) => String(s || '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();

// event.* create/update body. Times are exact wall-clock (HH:MM) in `tz`.
export function eventToEventbritePayload(ev, tz) {
  const summary = (ev.publicSummary && String(ev.publicSummary).slice(0, 140)) || stripHtml(ev.description).slice(0, 140);
  return {
    event: {
      'name': { html: ev.title || '' },
      'start': { timezone: tz, utc: zonedToUtcISO(ev.date, ev.start, tz) },
      'end': { timezone: tz, utc: zonedToUtcISO(ev.date, ev.end || ev.start, tz) },
      'currency': 'USD',
      'capacity': Number(ev.capacity) || undefined,
      'listed': true,           // public by decision
      'summary': summary,
    },
  };
}

// Free (v1) or paid (v2). Paid cost is "USD,<cents>".
export function ticketClassPayload(ev) {
  const tc = { name: 'General Admission', quantity_total: Number(ev.capacity) || undefined };
  if (ev.ticketType === 'paid') tc.cost = `USD,${Math.round(Number(ev.price || 0) * 100)}`;
  else tc.free = true;
  return { ticket_class: tc };
}

// Compute the version number to POST next for an event's Structured Content,
// given the body of `GET /events/{id}/structured_content/`.
//
// Eventbrite versions Structured Content: a write goes to `current + 1`. Two
// gotchas this guards against:
//   1. `page_version_number` comes back as a STRING ("12"), so a `typeof === 'number'`
//      check silently fails and would rewrite version 0 forever — a stale write that
//      Eventbrite rejects as a page-version discontinuity ("UNKNOWN — Something went
//      wrong"). Coerce with Number() instead.
//   2. Brand-new events have no Structured Content yet — GET returns an error body
//      with no page_version_number. Non-finite → start at version 0.
export function nextScVersion(getBody) {
  const raw = getBody && getBody.page_version_number;
  const cur = Number(raw);
  return (raw != null && Number.isFinite(cur)) ? cur + 1 : 0;
}

// Structured Content write body: one text module carrying the description HTML.
// `versionToWrite` is the next version number (current + 1).
export function structuredContentBody(html, versionToWrite) {
  return {
    publish: true,
    modules: [{ type: 'text', data: { body: { text: String(html || ''), alignment: 'left' } } }],
    // version is carried in the URL path, not the body; kept here for callers/tests
    _version: versionToWrite,
  };
}

// Venue body. Public → the real name + street address. Registrants-only → a
// generic name + a COARSE area (`privateArea`, e.g. "Nashville, TN") — NEVER the
// real street address and NEVER the (possibly host-identifying) venue name.
// Eventbrite rejects an addressless venue, and has no hide-address feature, so a
// coarse area is the only safe way to list an in-person private-home event.
export function venuePayload(venue, addressVisibility, area) {
  const a = area || {};
  const city = a.city || 'Nashville', region = a.region || 'TN', country = a.country || 'US';
  // Eventbrite requires structured city + country on a venue address.
  if (addressVisibility === 'Registrants only') {
    return { venue: { name: 'Address shared upon registration', address: { city, region, country } } };
  }
  const v = { name: venue.name || 'Venue' };
  if (venue.address) v.address = { address_1: venue.address, city, region, country };
  return { venue: v };
}

export function eventbriteWebUrl(eventId) {
  return `https://www.eventbrite.com/myevent?eid=${eventId}`;
}

// --- read side: live view + conflict guard + registration lookup -------------

// Normalize `GET /events/{id}/?expand=venue,ticket_classes` into the compact
// snapshot the plan app's Publish panel renders. Once an event is published,
// Eventbrite is the truth — the planning row's publish fields are staging.
export function ebEventSnapshot(body) {
  const b = body || {};
  const tcs = Array.isArray(b.ticket_classes) ? b.ticket_classes : [];
  const num = (x) => (Number.isFinite(Number(x)) ? Number(x) : 0);
  return {
    name: (b.name && (b.name.text != null ? b.name.text : stripHtml(b.name.html))) || '',
    summary: b.summary || '',                        // the short listing blurb (our Public summary)
    status: b.status || '',                          // draft | live | started | ended | completed | canceled
    url: b.url || '',
    startLocal: (b.start && b.start.local) || '',    // wall clock 'YYYY-MM-DDTHH:MM:SS'
    endLocal: (b.end && b.end.local) || '',
    timezone: (b.start && b.start.timezone) || '',
    capacity: num(b.capacity) || null,
    listed: b.listed === true,
    changed: b.changed || '',                        // ISO — bumped on any Eventbrite-side edit
    venueName: (b.venue && b.venue.name) || '',
    onlineEvent: b.online_event === true,
    ticketClasses: tcs.length,
    sold: tcs.reduce((n, t) => n + num(t.quantity_sold), 0),
    ticketTotal: tcs.reduce((n, t) => n + num(t.quantity_total), 0),
  };
}

// Plain text of the event's Structured Content (where our description lives).
export function structuredContentText(getBody) {
  const mods = (getBody && getBody.modules) || [];
  return mods
    .filter((m) => m && m.type === 'text')
    .map((m) => stripHtml(m.data && m.data.body && m.data.body.text))
    .filter(Boolean)
    .join('\n')
    .trim();
}

// Was the Eventbrite copy edited after our last push? A 60s skew allowance
// keeps our own push — which bumps `changed` moments before we stamp
// `Last EB push at` — from ever reading as a conflict. Unknown timestamps
// (old events pushed before the stamp existed) never block.
export function editedSincePush(changedIso, lastPushIso) {
  const c = Date.parse(changedIso || ''), p = Date.parse(lastPushIso || '');
  if (!Number.isFinite(c) || !Number.isFinite(p)) return false;
  return c > p + 60_000;
}

// Active attendee emails (lowercased) from a `GET /events/{id}/attendees/`
// page. Cancelled/refunded rows and missing profiles are skipped.
export function activeAttendeeEmails(attendees) {
  return (attendees || [])
    .filter((a) => a && !a.cancelled && !a.refunded)
    .map((a) => String((a.profile && a.profile.email) || '').toLowerCase().trim())
    .filter(Boolean);
}
