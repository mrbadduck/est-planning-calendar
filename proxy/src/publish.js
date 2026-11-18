// Pure helpers for the Eventbrite publish flow. No I/O — unit-tested.
import { normText } from './eventbrite.js';
import '../../web/listing-readiness.js';   // globalThis.ListingRules (the app's shared rules)
import '../../web/venue-address.js';       // globalThis.VenueAddress (the app's shared address rules)
import { VENUE_COLS } from './coda-columns.js';
import { venueFromRow } from './venues.js';

// Map Coda's GET /mutationStatus/:id response to our route's response.
export function mutationResult(status, body) {
  if (status === 200) return { httpStatus: 200, json: { completed: !!(body && body.completed) } };
  if (status === 400) return { httpStatus: 400, json: { error: 'unknown request id' } };
  return { httpStatus: 502, json: { error: `coda ${status}` } };
}

// Coda time/datetime cell -> 'HH:MM' ('' when absent).
export const hhmm = v => (String(v == null ? '' : v).match(/(?:T|^)(\d{2}:\d{2})/) || [])[1] || '';

const lower = v => String(v == null ? '' : v).toLowerCase();

// Name-keyed simpleWithArrays planning row -> event in ListingRules.readiness input shape.
export function rowToListingEvent(V) {
  let pushed = null;
  try {
    const p = JSON.parse(V['Last EB pushed values']);
    if (p && typeof p === 'object') pushed = p;
  } catch (_) {}
  const venue = Array.isArray(V['Venue']) ? V['Venue'][0] : V['Venue'];
  return {
    title: V['Title'] || '',
    status: lower(V['Status']),
    scheduling: lower(V['Scheduling'] || 'Exact'),
    allDay: !!V['All day'],
    date: String(V['Date'] || '').slice(0, 10),
    start: hhmm(V['Start']),
    end: hhmm(V['End']),
    capacity: V['Capacity'],
    venueName: venue || '',
    venueOther: V['Venue (other)'] || '',
    addressVisibility: V['Address visibility'] || '',
    publicSummary: V['Public summary'] || '',
    publicDescription: V['Public description'] || '',
    description: V['Event Description'] || '',
    eventbriteId: V['Eventbrite Event ID'] || '',
    ticketClassId: V['Eventbrite Ticket Class ID'] || '',
    pushed,
  };
}

// JSON snapshot of what the Worker just sent to Eventbrite (stored in Last EB pushed values).
export function pushedValues(ev, { ticketClassId } = {}) {
  return JSON.stringify({
    title: ev.title || '',
    date: ev.date || '',
    start: ev.start || '',
    end: ev.end || '',
    capacity: Number(ev.capacity),
    publicSummary: ev.publicSummary || '',
    publicDescription: ev.publicDescription || '',
    venueName: ev.venueName || '',
    addressVisibility: ev.addressVisibility || '',
    ticketClassId: ticketClassId || '',
  });
}

// The publish route's 200 body. `pushed` is the snapshot just written to Last EB
// pushed values (R15): the app adopts it as-is rather than recomputing it.
// `lastPushAt` is the Last EB push at it wrote, so the app can tell a status read
// that predates this push (Coda's apply lag) from a real Eventbrite-side edit.
// `requestId` is Coda's id for the last row write (applied 13–30 s later, F1): the
// app waits on it before showing Saved.
export function publishSuccessBody({ ebId, url, draftOnly, ticketNote, pushedJson, lastPushAt, requestId }) {
  let pushed = null;
  try { pushed = JSON.parse(pushedJson); } catch (_) {}
  return {
    ok: true, eventbriteId: ebId, url, draft: !!draftOnly,
    publishStatus: draftOnly ? 'Draft' : 'Published',
    pushed,
    lastPushAt: lastPushAt || null,
    requestId: requestId || null,
    ...(ticketNote ? { ticketNote } : {}),
  };
}

// Public description to write to Eventbrite's structured content, or null to skip
// the write: blank, or unchanged since the last push (whitespace-insensitive).
// Never falls back to the internal description (decision 7).
export function descriptionToWrite(ev, pushed) {
  const text = (ev && ev.publicDescription) || '';
  if (!normText(text)) return null;
  if (pushed && normText(pushed.publicDescription) === normText(text)) return null;
  return text;
}

// What to do with Eventbrite ticket classes on a push (F12). `classes` is
// [{id}] from GET /events/{id}/ticket_classes/, or null when not fetched (it is
// fetched only on an update with no stored ticket class id).
export function ticketPlan({ isCreate, storedTcId, classes, capacity } = {}) {
  if (isCreate) return { action: 'create' };
  if (storedTcId) return Number(capacity) > 0 ? { action: 'update', id: storedTcId } : { action: 'none' };
  if (!Array.isArray(classes)) return { action: 'none' };
  if (classes.length === 0) return { action: 'create' };
  if (classes.length === 1) return { action: 'adopt', id: classes[0].id };
  return { action: 'leave' };
}

// Draft preview (F8): Eventbrite 404s draft pages to non-organizers, so the app
// renders the listing's own data. descriptionHtml is raw; the app sanitizes it.
export function previewModel(ev, desc, addressVisibility) {
  ev = ev || {};
  const online = !!ev.online_event;
  const addr = (ev.venue && ev.venue.address) || {};
  const regOnly = addressVisibility === 'Registrants only';
  const cityRegion = [addr.city, addr.region].filter(Boolean).join(', ');
  const location = {
    online,
    name: online ? '' : ((ev.venue && ev.venue.name) || ''),
    displayAddress: online ? '' : (regOnly ? cityRegion : (addr.localized_address_display || '')),
  };
  if (!online) location.note = regOnly ? 'Full address shown to registrants only' : '';
  return {
    name: (ev.name && ev.name.text) || '',
    summary: ev.summary || '',
    descriptionHtml: (desc && desc.description) || '',
    startLocal: (ev.start && ev.start.local) || '',
    endLocal: (ev.end && ev.end.local) || '',
    timezone: (ev.start && ev.start.timezone) || '',
    status: ev.status || '',
    location,
    tickets: (ev.ticket_classes || []).map(t => ({ name: t.name, free: !!t.free, quantityTotal: t.quantity_total })),
    logoUrl: (ev.logo && ev.logo.url) || null,
  };
}

// --- Unpublish / cancel / delete vs Eventbrite's order rules (F7) ----------
// Eventbrite refuses unpublish, cancel and delete for any event with orders, so
// the routes check registrants (ebEventSnapshot(body).sold) before acting.

// An Eventbrite event that is already gone (404, deleted) or canceled — e.g.
// council cancelled it on Eventbrite — counts as torn down. `r` is ebFetch's
// {ok,status,body} for GET /events/{id}/.
export function ebGone(r) {
  if (!r) return false;
  if (r.status === 404) return true;
  const st = r.ok && r.body ? r.body.status : '';
  return st === 'deleted' || st === 'canceled';
}

// What Cancel does on Eventbrite for a still-existing event (call ebGone first).
//   blocked  -> people registered: change nothing, ask council to cancel on Eventbrite
//   unpublish-> live listing with no orders
//   delete   -> private draft with no orders
//   none     -> ended/completed etc.: leave Eventbrite alone
export function cancelPlan({ status, sold } = {}) {
  const n = Number(sold) || 0;
  if (n > 0) return { action: 'blocked', registrants: n };
  if (status === 'live' || status === 'started') return { action: 'unpublish' };
  if (status === 'draft') return { action: 'delete' };
  return { action: 'none' };
}

// Coda checkbox cell (simpleWithArrays) -> boolean.
export const isPublishedCell = v => v === true || v === 'true';

// Who may DELETE /rows/:id (Q1 (a)). Returns null when allowed, else {status, error}.
// A published row must be cancelled first (everyone); a Cancelled row needs council;
// otherwise any writer (lead) may delete a never-published event. `ebStatus` is
// the live Eventbrite status when read: a live/started listing also counts as
// published, since the Published? cell can be stale-false.
export function deleteGate({ published, status, ebStatus } = {}, id = {}) {
  if (!id.canWrite) return { status: 403, error: 'not authorized' };
  if (published || ebStatus === 'live' || ebStatus === 'started') return { status: 409, error: 'Cancel this event before deleting it' };
  if (status === 'Cancelled' && !id.canApprove) return { status: 403, error: 'delete requires Tribal Council' };
  return null;
}

// GET /ref/venues item (R12): what the editor's venue picker and readiness need,
// never the address itself — it holds private home addresses and /ref is
// unauthenticated. `row` is an id-keyed (VENUE_COLS) simpleWithArrays Venues row;
// the output keeps the name-keyed `values` shape the app reads. hasAddress follows
// VenueAddress.hasAddress: structured Street+City, else the legacy Address cell.
export function venueRefItem(row) {
  const v = (row && row.values) || {};
  const type = Array.isArray(v[VENUE_COLS.type]) ? v[VENUE_COLS.type][0] : v[VENUE_COLS.type];
  return {
    id: row && row.id,
    name: (row && row.name) || '',
    values: { 'Venue Type': type == null ? '' : type, 'Closed/Unavailable?': v[VENUE_COLS.closed] === true },
    hasAddress: globalThis.VenueAddress.hasAddress(venueFromRow(row)),
  };
}

// Address visibility the Worker acts on (R14). A blank value at a private home
// is treated as Registrants only — the same default the app applies — so a home's
// street address never goes public because nobody picked a value. An explicit
// choice (including Public) is kept.
export function effectiveAddressVisibility(addressVisibility, venue) {
  const v = String(addressVisibility == null ? '' : addressVisibility).trim();
  return globalThis.ListingRules.addressVisibilityDefault(v, venue) || '';
}

// --- Eventbrite ids the row hasn't applied yet (R19) -------------------------
// The Worker's own Coda writes apply 13–30 s later (F1), so a second push (or
// preview/cancel/unpublish/delete/status) inside that window reads a row with no
// Eventbrite id and would create a DUPLICATE event. After creating an event (and
// after learning a ticket class, and on each successful push) the Worker keeps a
// KV marker `ebpending:<rowId>` -> {ebId, tcId, lastPushAt, at} for 10 minutes;
// readers use it wherever the row's value is still blank.
export const EB_PENDING_TTL = 600;   // seconds (KV expirationTtl)
export const ebPendingKey = rowId => `ebpending:${rowId}`;

// The marker after `patch` (null/undefined fields in patch are ignored).
export function mergeEbPending(cur, patch, now = Date.now()) {
  const out = { ...((cur && typeof cur === 'object') ? cur : {}) };
  for (const [k, v] of Object.entries(patch || {})) if (v != null && v !== '') out[k] = v;
  out.at = now;
  return out;
}

// Row value or marker. `V` is the name-keyed planning row. The marker's ticket
// class only counts for the same event; Last EB push at is the later of the two.
export function resolveEbIds(V, marker) {
  V = V || {};
  const m = (marker && typeof marker === 'object') ? marker : {};
  const rowEb = String(V['Eventbrite Event ID'] || '');
  const ebId = rowEb || String(m.ebId || '');
  const sameEvent = !!ebId && String(m.ebId || '') === ebId;
  const tcId = String(V['Eventbrite Ticket Class ID'] || '') || (sameEvent ? String(m.tcId || '') : '');
  const rowAt = V['Last EB push at'] || '', mAt = sameEvent ? (m.lastPushAt || '') : '';
  const lastPushAt = (Date.parse(mAt) > (Date.parse(rowAt) || -Infinity)) ? mAt : (rowAt || null);
  return { ebId, tcId, lastPushAt: lastPushAt || null, fromMarker: !rowEb && !!ebId };
}
