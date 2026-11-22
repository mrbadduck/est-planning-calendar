// Eventbrite -> plan mapping (pure: no fetch, no env, no DOM).
import { normText, structuredContentText } from './eventbrite.js';
import { PLANNING_COLS as C } from './coda-columns.js';

// Read an Eventbrite event (`?expand=venue,ticket_classes`) plus its structured
// content into planning fields. A series parent has no dates of its own: null.
export function ebToFields(body, scBody) {
  const b = body || {};
  if (b.is_series_parent === true) return null;
  const tcs = Array.isArray(b.ticket_classes) ? b.ticket_classes : [];
  const split = (local) => {
    const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(local || '');
    return m ? { d: m[1], t: m[2] } : { d: '', t: '' };
  };
  const s = split(b.start && b.start.local), e = split(b.end && b.end.local);
  const cap = Number(b.capacity);
  const tcTotal = Number(tcs.length === 1 && tcs[0].quantity_total);
  const capacity = Number.isFinite(cap) && b.capacity != null && cap > 0 ? cap
    : (tcs.length === 1 && Number.isFinite(tcTotal) && tcTotal > 0 ? tcTotal : null);
  const online = b.online_event === true;
  const v = !online && b.venue ? b.venue : null;
  const addr = (v && v.address) || {};
  const venueText = v
    ? [v.name, addr.localized_address_display].map(x => String(x || '').trim()).filter(Boolean).join(', ')
    : '';
  return {
    ebId: String(b.id || ''),
    title: normText(b.name && (b.name.text != null ? b.name.text : '')),
    date: s.d, start: s.t, end: e.t,
    capacity,
    publicDescription: normText(structuredContentText(scBody)),
    ebVenueId: String(b.venue_id || (b.venue && b.venue.id) || ''),
    online,
    ebStatus: b.status || '',
    changed: b.changed || '',
    url: b.url || '',
    ticketClassId: tcs.length === 1 && tcs[0].id ? String(tcs[0].id) : '',
    venueText,
    hasStreetAddress: !!(v && String(addr.address_1 || '').trim()),
  };
}

const PUBLISHED = new Set(['live', 'started', 'ended', 'completed']);

// Planning-row cells implied by an Eventbrite status.
export function ebStatusCells(ebStatus) {
  if (ebStatus === 'canceled') return { status: 'Cancelled', publishStatus: 'Cancelled', published: false };
  if (PUBLISHED.has(ebStatus)) return { status: 'Approved', publishStatus: 'Published', published: true };
  return { status: 'Approved', publishStatus: 'Draft', published: false };
}

// Last-pushed-values JSON: same keys as pushedValues in publish.js, plus
// ebChanged, ebVenueId and ebStatus. Fields we do not read from Eventbrite
// (summary, venue name, address visibility, ticket class) come from `keep`.
export function ebSnapshot(fields, keep) {
  const f = fields || {}, k = keep || {};
  return JSON.stringify({
    title: f.title || '',
    date: f.date || '',
    start: f.start || '',
    end: f.end || '',
    capacity: Number(f.capacity),
    publicSummary: k.publicSummary || '',
    publicDescription: f.publicDescription || '',
    venueName: k.venueName || '',
    addressVisibility: k.addressVisibility || '',
    ticketClassId: k.ticketClassId || f.ticketClassId || '',
    ebChanged: f.changed || '',
    ebVenueId: f.ebVenueId || '',
    ebStatus: f.ebStatus || '',
  });
}

// ── Import or flow-in (§5.3–5.5) ──────────────────────────────────────────

// Fields Eventbrite edits flow into plan for, in decision order.
export const SYNCED = ['title', 'date', 'start', 'end', 'capacity', 'publicDescription', 'venue', 'publishState'];

// Match an Eventbrite venue id to an EST Venues SRC row by stored id only
// (never by name). venues: [{id, name, ebVenueId, ebPrivateVenueId}].
export function matchVenue(ebVenueId, venues) {
  const id = String(ebVenueId || '');
  if (id) {
    for (const v of venues || []) {
      if (String(v.ebVenueId || '') === id) return { venueRowId: v.id, venueName: v.name || '', addressVisibility: 'Public' };
      if (String(v.ebPrivateVenueId || '') === id) return { venueRowId: v.id, venueName: v.name || '', addressVisibility: 'Registrants only' };
    }
  }
  return { venueRowId: null, venueName: '', addressVisibility: '' };
}

const capNum = (x) => { const n = Number(x == null || x === '' ? 0 : x); return Number.isFinite(n) ? n : 0; };
const capCell = (x) => (x == null || capNum(x) === 0 ? '' : capNum(x));

function statusCells(ebStatus) {
  const s = ebStatusCells(ebStatus), out = [];
  if (s.status) out.push({ column: C.status, value: s.status });
  out.push({ column: C.publishStatus, value: s.publishStatus }, { column: C.published, value: s.published });
  return out;
}

// Cells for a new planning row built from an Eventbrite event: it looks as if a
// lead had built it in plan and pushed it. Program(s), Leads, Created by stay blank.
export function importCells(fields, venueMatch, nowIso) {
  const f = fields || {}, m = venueMatch || {};
  const hasVenue = !f.online && !!(f.ebVenueId || f.venueText);
  const addressVisibility = m.venueRowId ? m.addressVisibility
    : (f.hasStreetAddress ? 'Public' : (hasVenue ? 'Registrants only' : ''));
  return [
    { column: C.title, value: f.title || '' },
    { column: C.scheduling, value: 'Exact' },
    { column: C.date, value: f.date || '' },
    { column: C.start, value: f.start || '' },
    { column: C.end, value: f.end || '' },
    { column: C.capacity, value: capCell(f.capacity) },
    { column: C.publicDescription, value: f.publicDescription || '' },
    { column: C.eventbriteId, value: f.ebId || '' },
    { column: C.eventbriteUrl, value: f.url || '' },
    { column: C.ticketClassId, value: f.ticketClassId || '' },
    ...statusCells(f.ebStatus),
    m.venueRowId ? { column: C.venue, value: m.venueRowId } : { column: C.venueOther, value: f.venueText || '' },
    { column: C.addressVisibility, value: addressVisibility },
    { column: C.lastEbPushedValues, value: ebSnapshot(f, { addressVisibility, venueName: m.venueRowId ? m.venueName : '' }) },
    { column: C.lastEbPushAt, value: nowIso },
    { column: C.source, value: 'Eventbrite' },
  ];
}

// The snapshot a never-pushed row is treated as having: plan's own values.
function planAsSnapshot(r) {
  return {
    title: r.title || '', date: r.date || '', start: r.start || '', end: r.end || '',
    capacity: capNum(r.capacity), publicSummary: r.publicSummary || '',
    publicDescription: r.publicDescription || '', venueName: r.venueName || '',
    addressVisibility: r.addressVisibility || '', ticketClassId: r.ticketClassId || '',
    ebChanged: '', ebVenueId: '', ebStatus: '',
  };
}

const SIMPLE = {
  title:             { col: C.title,             eq: (a, b) => normText(a) === normText(b) },
  date:              { col: C.date,              eq: (a, b) => String(a || '') === String(b || '') },
  start:             { col: C.start,             eq: (a, b) => String(a || '') === String(b || '') },
  end:               { col: C.end,               eq: (a, b) => String(a || '') === String(b || '') },
  capacity:          { col: C.capacity,          eq: (a, b) => capNum(a) === capNum(b), cell: capCell, snap: capNum },
  publicDescription: { col: C.publicDescription, eq: (a, b) => normText(a) === normText(b) },
};

// Decide which Eventbrite edits flow onto an existing planning row (§5.3).
// rowEv: rowToListingEvent(row); fields: ebToFields(...); venueMatch: matchVenue(fields.ebVenueId, ...).
// Per field: live == snap -> skip; plan == snap -> write live; plan == live -> echo
// (our own push): no row cell, but the snapshot takes the value, so a webhook that
// read the pre-push snapshot can't write it back over the push's (I1); otherwise a
// conflict (plan's unpushed edit is kept). Never pushed -> snap is plan, so
// Eventbrite wins wherever it differs.
export function planFlowIn(rowEv, fields, venueMatch, nowIso) {
  const r = rowEv || {}, f = fields || {}, m = venueMatch || {};
  const neverPushed = r.pushed == null;
  const snap = neverPushed ? planAsSnapshot(r) : r.pushed;
  const next = { ...planAsSnapshot(r), ...snap };
  const cells = [], changed = [], conflicts = [];
  // A snapshot written before Eventbrite sync has no ebVenueId / ebStatus key:
  // no baseline yet. Adopt the live value into the snapshot; don't flow it in.
  const has = (k) => Object.prototype.hasOwnProperty.call(snap, k);
  let adopted = false, refreshed = false;
  // Snapshot-only updates (echo, automatic status step): flagged only when they differ.
  const refresh = (k, v) => { if (next[k] !== v) { next[k] = v; refreshed = true; } };

  for (const name of SYNCED) {
    if (SIMPLE[name]) {
      const d = SIMPLE[name], live = f[name], plan = r[name], was = snap[name];
      if (d.eq(live, was)) continue;
      if (d.eq(plan, was)) {
        cells.push({ column: d.col, value: d.cell ? d.cell(live) : (live == null ? '' : live) });
        next[name] = d.snap ? d.snap(live) : (live == null ? '' : live);
        changed.push(name);
      } else if (d.eq(plan, live)) {
        // As pushSnapshot stores it: Eventbrite's value, but plan's text when only whitespace differs.
        refresh(name, d.snap ? d.snap(live) : (plan == null ? '' : plan));
      } else conflicts.push(name);
    } else if (name === 'venue') {
      if (!has('ebVenueId')) { next.ebVenueId = String(f.ebVenueId || ''); adopted = true; continue; }
      const liveName = m.venueRowId ? (m.venueName || '') : '';
      const liveId = String(f.ebVenueId || '');
      let movedOnEb, planUntouched, planIsLive;
      if (neverPushed) {
        movedOnEb = m.venueRowId ? (r.venueName || '') !== liveName
          : (r.venueName || '') !== '' || normText(r.venueOther) !== normText(f.venueText);
        planUntouched = true;
      } else {
        movedOnEb = liveId !== String(snap.ebVenueId || '');
        // Plan owns address visibility: an unpushed edit to it counts as plan-touched.
        planUntouched = (r.venueName || '') === (snap.venueName || '')
          && (r.addressVisibility || '') === (snap.addressVisibility || '');
        planIsLive = m.venueRowId ? (r.venueName || '') === liveName
          : !(r.venueName || '') && normText(r.venueOther) === normText(f.venueText);
      }
      if (!movedOnEb) continue;
      if (planUntouched) {
        if (m.venueRowId) {
          cells.push({ column: C.venue, value: m.venueRowId }, { column: C.venueOther, value: '' },
            { column: C.addressVisibility, value: m.addressVisibility || '' });
          next.addressVisibility = m.addressVisibility || '';
        } else {
          cells.push({ column: C.venue, value: '' }, { column: C.venueOther, value: f.venueText || '' });
        }
        next.ebVenueId = liveId;
        next.venueName = liveName;
        changed.push('venue');
      } else if (planIsLive) {   // echo of our own venue push
        refresh('ebVenueId', liveId); refresh('venueName', liveName);
        if (r.addressVisibility) refresh('addressVisibility', r.addressVisibility);
      } else conflicts.push('venue');
    } else if (name === 'publishState') {
      if (!has('ebStatus')) { next.ebStatus = f.ebStatus || ''; adopted = true; continue; }
      // Plan never edits Eventbrite status except by pushing: always write.
      if (String(f.ebStatus || '') === String(snap.ebStatus || '')) continue;
      // C1: a Cancelled row is plan-owned unless Eventbrite says canceled (a plan
      // Cancel unpublishes the listing; its echo must not bring Status back).
      if (r.status === 'cancelled' && f.ebStatus !== 'canceled') continue;
      cells.push(...statusCells(f.ebStatus));
      next.ebStatus = f.ebStatus || '';
      changed.push('publishState');
    }
  }

  if (!changed.length) {
    if (!adopted && !refreshed) return { cells: [], changed, conflicts };
    if (refreshed) next.ebChanged = f.changed || next.ebChanged || '';
    return { cells: [{ column: C.lastEbPushedValues, value: JSON.stringify(next) }], changed, conflicts };
  }
  next.ebChanged = f.changed || '';
  cells.push(
    { column: C.lastEbPushedValues, value: JSON.stringify(next) },
    { column: C.lastFromEb, value: JSON.stringify({ at: nowIso, fields: changed }) },
  );
  return { cells, changed, conflicts };
}

// ── Webhook, sweep and the one handler (§5.1–5.2) ─────────────────────────

// The event was deleted on Eventbrite: the row stays, its Eventbrite id kept.
// (The select option is added in Coda before release.)
export const REMOVED_STATUS = 'Removed from Eventbrite';
export function removedCells() {
  return [{ column: C.publishStatus, value: REMOVED_STATUS }, { column: C.published, value: false }];
}

// Eventbrite webhooks are unsigned: trust only an Eventbrite event api_url, and
// only for its numeric id (the Worker fetches the event itself).
const EB_EVENT_URL = /^https:\/\/www\.eventbriteapi\.com\/v3\/events\/(\d+)\/?$/;
export function parseEbWebhook(body) {
  const m = EB_EVENT_URL.exec(String((body && body.api_url) || ''));
  return m ? m[1] : null;
}

// KV eb-row:<ebId> while an import is requested but not applied yet (Coda's upsert
// returns no row id). A marker holding a real row id is still honoured.
export const IMPORTING = 'importing';

// What to do with an Eventbrite event: rowsWithId are the planning rows holding
// its id; markerRowId is KV eb-row:<ebId> (IMPORTING or a row id); pending is a
// plan push in flight for that row (KV ebpending:<rowId>).
export function syncDecision({ rowsWithId, markerRowId, pending }) {
  const n = (rowsWithId || []).length;
  if (pending) return 'skip';
  if (n > 1) return 'error';
  if (n === 1) return 'flowin';
  if (markerRowId === IMPORTING) return 'skip';
  if (markerRowId) return 'flowin';
  return 'import';
}

// The slice of candidates one sweep run handles. A cursor past the end (the list
// shrank since the last run) starts over.
export function sweepBatch(candidates, cursor, max) {
  const list = candidates || [];
  let at = Number(cursor) || 0;
  if (at < 0 || at >= list.length) at = 0;
  const end = at + max;
  return { batch: list.slice(at, end), nextCursor: end < list.length ? end : null };
}

// Constant-time string compare for the webhook path secret. An unset secret never matches.
export function secretMatches(given, secret) {
  const a = String(given == null ? '' : given), b = String(secret == null ? '' : secret);
  if (!b) return false;
  let diff = a.length ^ b.length;
  for (let i = 0; i < b.length; i++) diff |= (a.charCodeAt(i) || 0) ^ b.charCodeAt(i);
  return diff === 0;
}

// Nothing flowed in but Eventbrite's changed stamp moved (e.g. a push echo, or an
// edit plan already has): record the stamp so the sweep stops picking the row up.
// A never-pushed row gets plan as its snapshot (as planFlowIn treats it), with the
// live venue id and status: nothing differed, so they are its baseline.
export function seenCells(rowEv, fields) {
  const r = rowEv || {}, f = fields || {}, changed = f.changed || '';
  if (!changed) return [];
  if (!r.pushed) {
    const snap = { ...planAsSnapshot(r), ebChanged: changed, ebVenueId: String(f.ebVenueId || ''), ebStatus: f.ebStatus || '' };
    return [{ column: C.lastEbPushedValues, value: JSON.stringify(snap) }];
  }
  if (r.pushed.ebChanged === changed) return [];
  return [{ column: C.lastEbPushedValues, value: JSON.stringify({ ...r.pushed, ebChanged: changed }) }];
}

// Every import, flow-in and seen write sets Last EB push at to Eventbrite's own
// changed stamp, so the publish conflict guard doesn't read an edit plan already
// took in as "edited on Eventbrite".
export function stampPushAt(cells, changed) {
  if (!changed) return cells;
  return [...(cells || []).filter((c) => c.column !== C.lastEbPushAt), { column: C.lastEbPushAt, value: changed }];
}

const cellStr = (v) => (v == null ? '' : Array.isArray(v) ? cellStr(v[0]) : String(v));
const snapChanged = (v) => { try { const p = JSON.parse(cellStr(v)); return (p && p.ebChanged) || ''; } catch (_) { return ''; } };

// The events a sweep run should hand to the handler, in a stable order.
// listed: Eventbrite listing events; rows: id-keyed planning rows; today: YYYY-MM-DD.
// A listed event needs work when no row holds it or its snapshot's ebChanged differs.
// An upcoming row with an Eventbrite id the listing didn't return is checked too
// (deleted on Eventbrite?), unless it is already marked removed or is Cancelled.
export function sweepCandidates({ listed, rows, today }) {
  const byEb = new Map();
  for (const r of rows || []) {
    const id = cellStr(r.values && r.values[C.eventbriteId]);
    if (id && !byEb.has(id)) byEb.set(id, r);
  }
  const out = [], seen = new Set();
  for (const ev of listed || []) {
    const id = String((ev && ev.id) || '');
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const r = byEb.get(id);
    if (!r || snapChanged(r.values[C.lastEbPushedValues]) !== String(ev.changed || '')) out.push({ ebId: id, body: ev });
  }
  for (const [id, r] of byEb) {
    if (seen.has(id)) continue;
    if (cellStr(r.values[C.date]).slice(0, 10) < today) continue;
    if (cellStr(r.values[C.publishStatus]) === REMOVED_STATUS) continue;
    if (cellStr(r.values[C.status]) === 'Cancelled') continue;   // plan-owned: a deleted listing changes nothing
    out.push({ ebId: id, body: null });
  }
  return out;
}
