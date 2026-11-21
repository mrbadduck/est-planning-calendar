// Eventbrite -> plan mapping (pure: no fetch, no env, no DOM).
import { normText, structuredContentText } from './eventbrite.js';

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
    ticketClassId: k.ticketClassId || '',
    ebChanged: f.changed || '',
    ebVenueId: f.ebVenueId || '',
    ebStatus: f.ebStatus || '',
  });
}
