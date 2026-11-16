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
// summary is Eventbrite's short listing blurb. Critically it is OMITTED when we
// have no staged summary — Eventbrite's read returns summary as null (it's
// effectively write-only), so sending an empty string would silently WIPE a
// blurb the organizer set. No fallback to the internal description, on create
// either (decision 7): a create with no staged summary simply sends none.
export function eventToEventbritePayload(ev, tz, opts = {}) {
  const summary = (ev.publicSummary && String(ev.publicSummary).slice(0, 140)) || '';
  const event = {
    'name': { html: ev.title || '' },
    'start': { timezone: tz, utc: zonedToUtcISO(ev.date, ev.start, tz) },
    'end': { timezone: tz, utc: zonedToUtcISO(ev.date, ev.end || ev.start, tz) },
    'currency': 'USD',
    'capacity': Number(ev.capacity) || undefined,
    'listed': true,           // public by decision
  };
  if (summary) event.summary = summary;
  return { event };
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
  if (venue.address) {
    // Coda's Address strings already carry city/state (sometimes twice). Send
    // the street alone as address_1, or Eventbrite shows the city repeated (R22).
    const p = parseUsAddress(venue.address, { city, region });
    // Never an empty street line for a non-empty address ("Nashville, TN", "TN 37216"):
    // fall back to its first non-empty segment.
    const raw = String(venue.address);
    const street = p.address_1 || raw.split(',').map(x => x.trim()).find(Boolean) || raw.trim();
    v.address = { address_1: street, city: p.city, region: p.region, country };
    if (p.postal_code) v.address.postal_code = p.postal_code;
  }
  return { venue: v };
}

const US_STATES = new Set(('AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT ' +
  'NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY PR').split(' '));
const ZIP = '(\\d{5}(?:-\\d{4})?)';
const STATE_SEG = new RegExp('^([A-Z]{2})(?:\\s+' + ZIP + ')?$');            // "TN" | "TN 37216"
const CITY_STATE_SEG = new RegExp('^(.*?\\S)\\s+([A-Z]{2})(?:\\s+' + ZIP + ')?$'); // "Nashville TN 37216"
const ZIP_SEG = new RegExp('^' + ZIP + '$');
// A trailing segment that names a unit, not a city ("Building B", "Suite 2").
const UNIT_SEG = /^(suite|ste|unit|apt|apartment|building|bldg|floor|fl|room|rm|dept|po box|p\.?o\.? box|box|#)(\b|\s|\d|$)/i;
const CITY_WORDS = /^[A-Za-z][A-Za-z .'-]*$/;

// Split a free-text US address ("3914 Gallatin Pike, Nashville, TN, Nashville, TN
// 37216") into Eventbrite's structured parts. Pure. address_1 is the street only:
// the comma segments before the first "City, ST" pair (with no state: all but a
// trailing city). The state must be an uppercase USPS code, so street words
// like "Ct"/"St" aren't mistaken for one. A repeated "City, ST" tail is ignored.
// `defaults` ({city, region}, default Nashville, TN) fill in only what the string
// doesn't say, and never replace a city the string does name: with no state, a
// trailing letters-only segment that isn't a unit ("Building B") is the city.
// A place name with the default city glued on ("Shelby Bottoms Greenway
// Nashville, TN") is split. address_1 can be '' ("Nashville, TN"); venuePayload
// then falls back to the raw text. postal_code is '' when no ZIP follows a state.
export function parseUsAddress(str, defaults) {
  const d = defaults || {};
  const dCity = d.city || 'Nashville', dRegion = d.region || 'TN';
  // "Shelby Bottoms Greenway Nashville" → ["Shelby Bottoms Greenway", "Nashville"]; null if it doesn't end in the city
  const peel = seg => {
    const tail = ' ' + dCity.toLowerCase();
    return seg.toLowerCase().endsWith(tail) && seg.length > tail.length ? [seg.slice(0, -tail.length).trim(), dCity] : null;
  };
  const segs = String(str == null ? '' : str).split(',').map(x => x.replace(/\s+/g, ' ').trim()).filter(Boolean);
  let street = segs.slice(0, 1), city = '', region = '', zip = '';
  for (let i = 0; i < segs.length; i++) {
    let m = STATE_SEG.exec(segs[i]);
    if (m && US_STATES.has(m[1])) {
      region = m[1]; zip = m[2] || '';
      if (i >= 2) { city = segs[i - 1]; street = segs.slice(0, i - 1); }
      else if (i === 1) {
        // "Nashville, TN" (no street) vs "1115 Delmas Ave Nashville, TN" (no comma
        // before the city): a leading digit means it's a street. A place name may
        // carry the city on its end ("Shelby Bottoms Greenway Nashville").
        const pl = peel(segs[0]);
        if (pl) { street = [pl[0]]; city = pl[1]; }
        else if (/^\d/.test(segs[0])) street = segs.slice(0, 1);
        else { city = segs[0]; street = []; }
      } else street = [];
    } else if (i >= 1 && (m = CITY_STATE_SEG.exec(segs[i])) && US_STATES.has(m[2])) {
      city = m[1]; region = m[2]; zip = m[3] || ''; street = segs.slice(0, i);
    } else continue;
    // A ZIP may still follow in a later segment (a repeated tail or a bare ZIP).
    for (let j = i + 1; j < segs.length && !zip; j++) {
      const z = /(?:^|\s)(\d{5}(?:-\d{4})?)$/.exec(segs[j]);
      if (z && (ZIP_SEG.test(segs[j]) || STATE_SEG.test(segs[j]) || CITY_STATE_SEG.test(segs[j]))) zip = z[1];
    }
    break;
  }
  if (!region && segs.length >= 2) {
    // No state: a trailing city-looking segment is the city, the rest the street.
    const last = segs[segs.length - 1];
    if (CITY_WORDS.test(last) && !UNIT_SEG.test(last)) { city = last; street = segs.slice(0, -1); }
    else street = segs;
  }
  let address_1 = street.join(', ');
  if (!city) {
    city = dCity;
    // "1115 Delmas Ave Nashville" — drop the default city glued onto the street.
    const tail = ' ' + dCity.toLowerCase();
    if (address_1.toLowerCase().endsWith(tail) && address_1.length > tail.length) address_1 = address_1.slice(0, -tail.length).trim();
  }
  return { address_1, city, region: region || dRegion, postal_code: zip };
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

// Whitespace-normalized text compare (the plan app edits the description as
// PLAIN text seeded from the stripped live copy, so text-equality is the "did
// the user actually change it?" signal).
export function normText(s) {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

// HTML -> readable plain text: block boundaries (<p>, <br>, <li>, headings)
// become newlines so paragraphs survive; inline tags drop; entities unescape.
function htmlToText(h) {
  return String(h || '')
    .replace(/<\s*(?:br|\/p|\/div|\/li|\/h[1-6])\s*\/?\s*>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&#39;/gi, "'").replace(/&quot;/gi, '"')
    .split('\n').map((s) => s.replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n');
}

// Plain text of the event's Structured Content (where our description lives).
export function structuredContentText(getBody) {
  const mods = (getBody && getBody.modules) || [];
  return mods
    .filter((m) => m && m.type === 'text')
    .map((m) => htmlToText(m.data && m.data.body && m.data.body.text))
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
