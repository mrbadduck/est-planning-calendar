// Pure helpers for the Eventbrite publish flow. No I/O — unit-tested.
import { normText } from './eventbrite.js';

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
// otherwise any writer (lead) may delete a never-published event.
export function deleteGate({ published, status } = {}, id = {}) {
  if (!id.canWrite) return { status: 403, error: 'not authorized' };
  if (published) return { status: 409, error: 'Cancel this event before deleting it' };
  if (status === 'Cancelled' && !id.canApprove) return { status: 403, error: 'delete requires Tribal Council' };
  return null;
}
