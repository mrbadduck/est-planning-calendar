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
  const summary = stripHtml(ev.description).slice(0, 140);
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

// Structured Content write body: one text module carrying the description HTML.
// `versionToWrite` is the next version number (current + 1).
export function structuredContentBody(html, versionToWrite) {
  return {
    publish: true,
    modules: [{ type: 'text', data: { body: { text: String(html || '') } } }],
    // version is carried in the URL path, not the body; kept here for callers/tests
    _version: versionToWrite,
  };
}

// Venue body. Public → the real name + street address. Registrants-only → a
// generic name + a COARSE area (`privateArea`, e.g. "Nashville, TN") — NEVER the
// real street address and NEVER the (possibly host-identifying) venue name.
// Eventbrite rejects an addressless venue, and has no hide-address feature, so a
// coarse area is the only safe way to list an in-person private-home event.
export function venuePayload(venue, addressVisibility, privateArea) {
  if (addressVisibility === 'Registrants only') {
    return { venue: { name: 'Address shared upon registration', address: { address_1: privateArea || 'Nashville, TN' } } };
  }
  const v = { name: venue.name || 'Venue' };
  if (venue.address) v.address = { address_1: venue.address };
  return { venue: v };
}

export function eventbriteWebUrl(eventId) {
  return `https://www.eventbrite.com/myevent?eid=${eventId}`;
}
