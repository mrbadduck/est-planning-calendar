import { test } from 'node:test';
import assert from 'node:assert/strict';
import { venueFromRow, venueForEditor, createCells, updateCells } from '../src/venues.js';
import { VENUE_COLS as C } from '../src/coda-columns.js';

const cell = (cells, col) => { const c = cells.find(x => x.column === col); return c ? c.value : undefined; };
const TYPES = [{ id: 'i-home', name: 'Home' }, { id: 'i-partner', name: 'Partner' }];
const VENUES = [{ id: 'i-1', name: 'The Basement' }, { id: 'i-2', name: 'JCC' }];
const ADDR = { street: ' 12  Main St ', unit: 'Apt 2', city: 'Nashville', state: 'tn', zip: '37206' };

test('venueFromRow: reads the by-id values (structured + legacy + EB ids)', () => {
  const row = { id: 'i-9', name: 'Fallback', values: {
    [C.name]: 'Inglewood Lounge', [C.type]: ['Partner'], [C.street]: '3914 Gallatin Pike', [C.unit]: '',
    [C.city]: 'Nashville', [C.state]: 'TN', [C.zip]: '37216', [C.address]: '3914 Gallatin Pike, Nashville, TN 37216',
    [C.ebVenueId]: '111', [C.ebPrivateVenueId]: '222' } };
  assert.deepEqual(venueFromRow(row), { id: 'i-9', name: 'Inglewood Lounge', type: 'Partner',
    street: '3914 Gallatin Pike', unit: '', city: 'Nashville', state: 'TN', zip: '37216',
    address: '3914 Gallatin Pike, Nashville, TN 37216', ebVenueId: '111', ebPrivateVenueId: '222' });
});
test('venueFromRow: missing values are blank strings; name falls back to the display name', () => {
  const v = venueFromRow({ id: 'i-3', name: 'Park', values: { [C.zip]: 37206 } });
  assert.equal(v.name, 'Park'); assert.equal(v.type, ''); assert.equal(v.street, ''); assert.equal(v.zip, '37206');
  assert.equal(venueFromRow(null).id, undefined);
});
test('venueForEditor: drops both Eventbrite venue ids', () => {
  const out = venueForEditor({ id: 'i', name: 'n', type: 't', street: 's', unit: '', city: 'c', state: 'TN', zip: '', address: 'a', ebVenueId: '1', ebPrivateVenueId: '2' });
  assert.deepEqual(out, { id: 'i', name: 'n', type: 't', street: 's', unit: '', city: 'c', state: 'TN', zip: '', address: 'a' });
});

test('createCells: ok — trimmed name, type id, the five fields normalized, composed Address', () => {
  const out = createCells({ name: '  New   Place ', typeId: 'i-partner', ...ADDR }, { venues: VENUES, types: TYPES });
  assert.ok(out.cells, JSON.stringify(out));
  const k = out.cells;
  assert.equal(cell(k, C.name), 'New Place');
  assert.equal(cell(k, C.type), 'i-partner');
  assert.equal(cell(k, C.street), '12 Main St');
  assert.equal(cell(k, C.unit), 'Apt 2');
  assert.equal(cell(k, C.city), 'Nashville');
  assert.equal(cell(k, C.state), 'TN');
  assert.equal(cell(k, C.zip), '37206');
  assert.equal(cell(k, C.address), '12 Main St, Apt 2, Nashville, TN 37206');
  assert.ok(k.every(c => /^c-/.test(c.column)), 'every cell is written by column id');
});
test('createCells: missing name → 400', () => {
  const out = createCells({ name: '   ', typeId: 'i-partner', ...ADDR }, { venues: VENUES, types: TYPES });
  assert.equal(out.status, 400); assert.ok(out.error); assert.equal(out.cells, undefined);
});
test('createCells: duplicate name with different case/spacing → 409 naming the venue', () => {
  const out = createCells({ name: 'the  basement ', typeId: 'i-partner', ...ADDR }, { venues: VENUES, types: TYPES });
  assert.equal(out.status, 409);
  assert.equal(out.error, 'A venue called The Basement already exists');
});
test('createCells: unknown or missing type → 400', () => {
  assert.equal(createCells({ name: 'X', typeId: 'i-nope', ...ADDR }, { venues: VENUES, types: TYPES }).status, 400);
  assert.equal(createCells({ name: 'X', ...ADDR }, { venues: VENUES, types: TYPES }).status, 400);
});
test('createCells: partial address → 400 with the field errors', () => {
  const out = createCells({ name: 'X', typeId: 'i-partner', street: '12 Main St' }, { venues: VENUES, types: TYPES });
  assert.equal(out.status, 400);
  assert.equal(out.errors.city, 'Add the city');
  assert.equal(out.errors.state, 'Use the 2-letter state (e.g. TN)');
  assert.equal(out.error, 'Add the city');
});
test('createCells: blank address is refused for a non-Home venue', () => {
  const out = createCells({ name: 'X', typeId: 'i-partner' }, { venues: VENUES, types: TYPES });
  assert.equal(out.status, 400); assert.equal(out.errors.street, 'Add the street');
});
test('createCells: a Home may be saved with no address (blank cells, blank Address)', () => {
  const out = createCells({ name: 'Someone Home', typeId: 'i-home', street: ' ', city: '' }, { venues: VENUES, types: TYPES });
  assert.ok(out.cells, JSON.stringify(out));
  assert.equal(cell(out.cells, C.address), '');
  assert.equal(cell(out.cells, C.street), '');
});
test('createCells: a Home with a partial address is still refused', () => {
  const out = createCells({ name: 'H', typeId: 'i-home', city: 'Nashville' }, { venues: VENUES, types: TYPES });
  assert.equal(out.status, 400); assert.equal(out.errors.street, 'Add the street');
});

const ROW = { id: 'i-1', name: 'The Basement', type: 'Partner', street: '1 Old St', unit: '', city: 'Nashville', state: 'TN', zip: '', address: '1 Old St, Nashville, TN', ebVenueId: '111', ebPrivateVenueId: '222' };
test('updateCells: composes Address and clears BOTH cached Eventbrite venue ids', () => {
  const out = updateCells({ street: '9 New Rd', unit: '', city: 'Franklin', state: 'TN', zip: '37064' }, ROW);
  assert.ok(out.cells, JSON.stringify(out));
  const k = out.cells;
  assert.equal(cell(k, C.street), '9 New Rd');
  assert.equal(cell(k, C.city), 'Franklin');
  assert.equal(cell(k, C.address), '9 New Rd, Franklin, TN 37064');
  assert.equal(cell(k, C.ebVenueId), '');
  assert.equal(cell(k, C.ebPrivateVenueId), '');
  assert.equal(cell(k, C.name), undefined, 'name is not changed by an address update');
  assert.equal(cell(k, C.type), undefined, 'type is not changed by an address update');
});
test('updateCells: invalid address → 400; no row → 404', () => {
  assert.equal(updateCells({ street: '9 New Rd', state: 'TN' }, ROW).status, 400);
  assert.equal(updateCells({ street: '', city: '' }, ROW).status, 400);
  assert.equal(updateCells({ street: '9 New Rd', city: 'X', state: 'TN' }, null).status, 404);
});
test('updateCells: a Home may clear its address', () => {
  const out = updateCells({}, { ...ROW, type: 'Home' });
  assert.ok(out.cells);
  assert.equal(cell(out.cells, C.address), '');
  assert.equal(cell(out.cells, C.ebVenueId), '');
});
