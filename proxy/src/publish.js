// Pure helpers for the Eventbrite publish flow. No I/O — unit-tested.

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
