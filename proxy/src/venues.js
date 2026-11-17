// Venue routes' pure parts (GET/POST /venues, PUT /venues/:rowId in worker.js):
// row → venue, request body → Coda cells. No network, no Worker globals.
// Rows are read by column id (useColumnNames=false, simpleWithArrays) and cells
// written by id (VENUE_COLS). Address rules are the app's own (web/venue-address.js).
import { VENUE_COLS as C } from './coda-columns.js';
import '../../web/venue-address.js';   // attaches globalThis.VenueAddress (shared with the app)
const VA = globalThis.VenueAddress;

const str = v => (v == null ? '' : Array.isArray(v) ? str(v[0]) : String(v));

// An id-keyed Venues row → {id,name,type,street,unit,city,state,zip,address,ebVenueId,ebPrivateVenueId}.
export function venueFromRow(row) {
  const v = (row && row.values) || {};
  return {
    id: row ? row.id : undefined,
    name: str(v[C.name]) || (row && row.name) || '',
    type: str(v[C.type]),
    street: str(v[C.street]), unit: str(v[C.unit]), city: str(v[C.city]),
    state: str(v[C.state]), zip: str(v[C.zip]),
    address: str(v[C.address]),
    ebVenueId: str(v[C.ebVenueId]), ebPrivateVenueId: str(v[C.ebPrivateVenueId]),
  };
}

// What GET /venues/:rowId returns to the edit form: no Eventbrite ids.
export function venueForEditor(venue) {
  const { ebVenueId, ebPrivateVenueId, ...rest } = venue;
  return rest;
}

const addressCells = n => [
  { column: C.street, value: n.street }, { column: C.unit, value: n.unit }, { column: C.city, value: n.city },
  { column: C.state, value: n.state }, { column: C.zip, value: n.zip }, { column: C.address, value: VA.compose(n) },
];
// Length caps (Coda accepts anything; these keep a pasted paragraph out of the table).
const NAME_MAX = 120;
const FIELD_MAX = { street: 120, unit: 120, city: 120, state: 120, zip: 10 };
const FIELD_LABEL = { street: 'Street', unit: 'Unit', city: 'City', state: 'State', zip: 'ZIP' };
function tooLong(n) {
  const errors = {};
  for (const k of Object.keys(FIELD_MAX)) if (n[k].length > FIELD_MAX[k]) errors[k] = `${FIELD_LABEL[k]} is too long`;
  const first = Object.values(errors)[0];
  return first ? { error: first, errors, status: 400 } : null;
}
const invalid = v => {
  const first = ['street', 'city', 'state', 'zip'].map(k => v.errors[k]).find(Boolean);
  return { error: first, errors: v.errors, status: 400 };
};

// POST /venues body {name, typeId, street, unit, city, state, zip} → {cells} | {error, status[, errors]}.
// `venues` = every existing venue ({name}); `types` = the Venue Types rows ({id, name}).
// Only a Home may be saved without an address.
export function createCells(body, { venues, types }) {
  const b = body || {};
  const name = str(b.name).replace(/\s+/g, ' ').trim();
  if (!name) return { error: 'Add the venue name', status: 400 };
  if (name.length > NAME_MAX) return { error: 'Name is too long', status: 400 };
  // Can't see venues created in the last ~28 s (Coda apply lag): acceptable at this scale.
  const dup = (venues || []).find(v => VA.sameName(v.name, name));
  if (dup) return { error: `A venue called ${dup.name} already exists`, status: 409 };
  const type = (types || []).find(t => b.typeId && t.id === b.typeId);
  if (!type) return { error: 'Choose a venue type', status: 400 };
  const n = VA.normalize(b);
  const long = tooLong(n);
  if (long) return long;
  const v = VA.validate(n, { allowBlank: type.name === 'Home' });
  if (!v.ok) return invalid(v);
  return { cells: [{ column: C.name, value: name }, { column: C.type, value: [type.id] }, ...addressCells(n)] };
}

// PUT /venues/:rowId body {street, unit, city, state, zip}; `venue` = venueFromRow of the
// current row. Clears BOTH cached Eventbrite venue ids in the same write, so the next
// push creates an Eventbrite venue with the new address.
export function updateCells(body, venue) {
  if (!venue) return { error: 'venue not found', status: 404 };
  const n = VA.normalize(body || {});
  const long = tooLong(n);
  if (long) return long;
  const v = VA.validate(n, { allowBlank: venue.type === 'Home' });
  if (!v.ok) return invalid(v);
  return { cells: [...addressCells(n), { column: C.ebVenueId, value: '' }, { column: C.ebPrivateVenueId, value: '' }] };
}
