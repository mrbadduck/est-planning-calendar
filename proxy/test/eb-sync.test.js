import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ebToFields, ebStatusCells, ebSnapshot } from '../src/eb-sync.js';
import { normText } from '../src/eventbrite.js';

const sc = (html) => ({ modules: [{ type: 'text', data: { body: { text: html } } }] });
const body = (o = {}) => ({
  id: '123', name: { text: '  Littles Shabbat ' }, status: 'live', url: 'https://eb/123',
  start: { local: '2027-03-13T10:00:00' }, end: { local: '2027-03-13T11:30:00' },
  capacity: 25, changed: '2027-03-01T12:00:00Z', online_event: false, venue_id: '77',
  venue: { id: '77', name: 'The Hall', address: { address_1: '1 Main St', localized_address_display: '1 Main St, Nashville, TN' } },
  ticket_classes: [{ id: 'tc1', quantity_total: 40 }], ...o,
});

test('splits local start/end into date, start, end', () => {
  const f = ebToFields(body(), sc(''));
  assert.equal(f.date, '2027-03-13'); assert.equal(f.start, '10:00'); assert.equal(f.end, '11:30');
  assert.equal(f.ebId, '123'); assert.equal(f.url, 'https://eb/123'); assert.equal(f.changed, '2027-03-01T12:00:00Z');
});
test('DST day keeps the wall clock', () => {
  const f = ebToFields(body({ start: { local: '2026-11-01T18:00:00' }, end: { local: '2026-11-01T19:00:00' } }), sc(''));
  assert.equal(f.date, '2026-11-01'); assert.equal(f.start, '18:00');
});
test('series parent returns null; series child returns fields', () => {
  assert.equal(ebToFields(body({ is_series_parent: true }), sc('')), null);
  assert.ok(ebToFields(body({ series_id: 's1', is_series_parent: false }), sc('')));
});
test('capacity falls back to the single ticket class, null with two', () => {
  assert.equal(ebToFields(body({ capacity: null }), sc('')).capacity, 40);
  assert.equal(ebToFields(body({ capacity: null, ticket_classes: [{ id: 'a', quantity_total: 1 }, { id: 'b', quantity_total: 2 }] }), sc('')).capacity, null);
});
test('title trimmed; description from structured content', () => {
  const f = ebToFields(body(), sc('<p>Hi&nbsp;there</p>'));
  assert.equal(f.title, 'Littles Shabbat');
  assert.equal(f.publicDescription, normText('Hi there'));
});
test('venue, online, ticket class and street address fields', () => {
  const f = ebToFields(body(), sc(''));
  assert.equal(f.ebVenueId, '77'); assert.equal(f.online, false);
  assert.equal(f.venueText, 'The Hall, 1 Main St, Nashville, TN');
  assert.equal(f.hasStreetAddress, true); assert.equal(f.ticketClassId, 'tc1');
  const o = ebToFields(body({ online_event: true, venue: null, venue_id: null, ticket_classes: [] }), sc(''));
  assert.equal(o.online, true); assert.equal(o.venueText, ''); assert.equal(o.hasStreetAddress, false);
  assert.equal(o.ebVenueId, ''); assert.equal(o.ticketClassId, '');
  assert.equal(ebToFields(body({ ticket_classes: [{ id: 'a' }, { id: 'b' }] }), sc('')).ticketClassId, '');
});
test('ebStatusCells', () => {
  assert.deepEqual(ebStatusCells('draft'), { status: 'Approved', publishStatus: 'Draft', published: false });
  for (const s of ['live', 'started', 'ended', 'completed'])
    assert.deepEqual(ebStatusCells(s), { status: 'Approved', publishStatus: 'Published', published: true });
  assert.deepEqual(ebStatusCells('canceled'), { status: 'Cancelled', publishStatus: 'Cancelled', published: false });
});
test('ebSnapshot carries keep values, ebChanged, ebVenueId and ebStatus', () => {
  const f = ebToFields(body(), sc('Desc'));
  const s = JSON.parse(ebSnapshot(f, { publicSummary: 'S' }));
  assert.equal(s.publicSummary, 'S'); assert.equal(s.ebChanged, f.changed);
  assert.equal(s.ebVenueId, '77'); assert.equal(s.ebStatus, 'live');
  assert.equal(s.title, 'Littles Shabbat'); assert.equal(s.capacity, 25);
  assert.equal(s.venueName, ''); assert.equal(s.ticketClassId, 'tc1');
  assert.equal(JSON.parse(ebSnapshot({ ...f, capacity: null }, {})).capacity, 0);
});

// ── Task 4: import or flow-in ──────────────────────────────────────────────
import { SYNCED, matchVenue, importCells, planFlowIn } from '../src/eb-sync.js';
import { PLANNING_COLS as C } from '../src/coda-columns.js';

const NOW = '2027-03-02T00:00:00Z';
const cell = (cells, col) => cells.find(c => c.column === col);
const venues = [
  { id: 'i-hall', name: 'The Hall', ebVenueId: '77', ebPrivateVenueId: '78' },
  { id: 'i-park', name: 'The Park', ebVenueId: '90', ebPrivateVenueId: '' },
];
// A row as rowToListingEvent gives it, pushed with snapshot = Eventbrite's values.
const liveF = (o = {}) => ({ ...ebToFields(body(), sc('Hi there')), ...o });
const rowOf = (f, plan = {}, snap = {}) => ({
  title: f.title, status: 'approved', date: f.date, start: f.start, end: f.end,
  capacity: f.capacity, venueName: 'The Hall', venueOther: '', addressVisibility: 'Public',
  publicSummary: 'S', publicDescription: f.publicDescription, eventbriteId: f.ebId,
  ticketClassId: f.ticketClassId,
  pushed: { ...JSON.parse(ebSnapshot(f, { venueName: 'The Hall', addressVisibility: 'Public', publicSummary: 'S' })), ...snap },
  ...plan,
});

test('SYNCED lists the synced fields', () => {
  assert.deepEqual(SYNCED, ['title', 'date', 'start', 'end', 'capacity', 'publicDescription', 'venue', 'publishState']);
});
test('matchVenue: public id, private id, no hit', () => {
  assert.deepEqual(matchVenue('77', venues), { venueRowId: 'i-hall', venueName: 'The Hall', addressVisibility: 'Public' });
  assert.deepEqual(matchVenue('78', venues), { venueRowId: 'i-hall', venueName: 'The Hall', addressVisibility: 'Registrants only' });
  assert.equal(matchVenue('99', venues).venueRowId, null);
  assert.equal(matchVenue('', [{ id: 'x', name: 'X', ebVenueId: '', ebPrivateVenueId: '' }]).venueRowId, null);
});
test('importCells for a live event', () => {
  const f = liveF();
  const cells = importCells(f, matchVenue('77', venues), NOW);
  assert.deepEqual(cell(cells, C.source), { column: C.source, value: 'Eventbrite' });
  assert.equal(cell(cells, C.published).value, true);
  assert.equal(cell(cells, C.publishStatus).value, 'Published');
  assert.equal(cell(cells, C.status).value, 'Approved');
  assert.equal(cell(cells, C.title).value, 'Littles Shabbat');
  assert.equal(cell(cells, C.start).value, '10:00');
  assert.equal(cell(cells, C.capacity).value, 25);
  assert.equal(cell(cells, C.eventbriteId).value, '123');
  assert.equal(cell(cells, C.eventbriteUrl).value, 'https://eb/123');
  assert.equal(cell(cells, C.ticketClassId).value, 'tc1');
  assert.equal(cell(cells, C.venue).value, 'i-hall');
  assert.equal(cell(cells, C.addressVisibility).value, 'Public');
  assert.equal(cell(cells, C.scheduling).value, 'Exact');
  assert.equal(cell(cells, C.lastEbPushAt).value, NOW);
  const snap = JSON.parse(cell(cells, C.lastEbPushedValues).value);
  assert.equal(snap.ebVenueId, '77'); assert.equal(snap.addressVisibility, 'Public'); assert.equal(snap.venueName, 'The Hall');
  for (const col of [C.programs, C.leads, C.createdBy]) assert.equal(cell(cells, col), undefined);
});
test('importCells: unmatched venue goes to Venue (other); visibility from street address', () => {
  const cells = importCells(liveF(), matchVenue('99', venues), NOW);
  assert.equal(cell(cells, C.venue), undefined);
  assert.equal(cell(cells, C.venueOther).value, 'The Hall, 1 Main St, Nashville, TN');
  assert.equal(cell(cells, C.addressVisibility).value, 'Public');
});
test('importCells: unmatched venue with no street address is Registrants only; online is blank', () => {
  const noAddr = importCells(liveF({ hasStreetAddress: false }), { venueRowId: null }, NOW);
  assert.equal(cell(noAddr, C.addressVisibility).value, 'Registrants only');
  assert.equal(JSON.parse(cell(noAddr, C.lastEbPushedValues).value).addressVisibility, 'Registrants only');
  const online = importCells(liveF({ online: true, ebVenueId: '', venueText: '', hasStreetAddress: false }), { venueRowId: null }, NOW);
  assert.equal(cell(online, C.addressVisibility).value, '');
});
test('flow-in: untouched in Eventbrite leaves a plan edit alone', () => {
  const f = liveF({ start: '18:00' });
  const r = planFlowIn(rowOf(f, { start: '18:30' }), f, matchVenue('77', venues), NOW);
  assert.deepEqual(r, { cells: [], changed: [], conflicts: [] });
});
test('flow-in: edited in Eventbrite copies onto the row and snapshot', () => {
  const f0 = liveF({ start: '18:00' });
  const r = planFlowIn(rowOf(f0), { ...f0, start: '19:00', changed: 'X2' }, matchVenue('77', venues), NOW);
  assert.deepEqual(r.changed, ['start']); assert.deepEqual(r.conflicts, []);
  assert.equal(cell(r.cells, C.start).value, '19:00');
  const snap = JSON.parse(cell(r.cells, C.lastEbPushedValues).value);
  assert.equal(snap.start, '19:00'); assert.equal(snap.ebChanged, 'X2'); assert.equal(snap.publicSummary, 'S');
  assert.deepEqual(JSON.parse(cell(r.cells, C.lastFromEb).value), { at: NOW, fields: ['start'] });
  assert.equal(r.cells.length, 3);
});
test('flow-in conflict: plan and Eventbrite both changed', () => {
  const f0 = liveF({ start: '18:00' });
  const r = planFlowIn(rowOf(f0, { start: '18:30' }), { ...f0, start: '19:00' }, matchVenue('77', venues), NOW);
  assert.equal(cell(r.cells, C.start), undefined);
  assert.deepEqual(r.conflicts, ['start']); assert.deepEqual(r.changed, []); assert.deepEqual(r.cells, []);
});
test('flow-in echo: plan already holds the live value', () => {
  const f0 = liveF({ start: '18:00' });
  const r = planFlowIn(rowOf(f0, { start: '19:00' }), { ...f0, start: '19:00' }, matchVenue('77', venues), NOW);
  assert.deepEqual(r, { cells: [], changed: [], conflicts: [] });
});
test('flow-in: Eventbrite HTML description equals the plain snapshot', () => {
  const f = ebToFields(body(), sc('<p>Hi there</p>'));
  const row = rowOf(f, {}, { publicDescription: 'Hi there' });
  assert.deepEqual(planFlowIn(row, f, matchVenue('77', venues), NOW).changed, []);
});
test('flow-in: text compared with normText, capacity null equals 0', () => {
  const f0 = liveF({ capacity: null });
  const row = rowOf(f0, { title: ' Littles  Shabbat ', capacity: '' });
  assert.equal(row.pushed.capacity, 0);
  assert.deepEqual(planFlowIn(row, f0, matchVenue('77', venues), NOW).changed, []);
  const r = planFlowIn(row, { ...f0, capacity: 30 }, matchVenue('77', venues), NOW);
  assert.deepEqual(r.changed, ['capacity']); assert.equal(cell(r.cells, C.capacity).value, 30);
});
test('flow-in: Eventbrite canceled on a published row', () => {
  const f0 = liveF();
  const r = planFlowIn(rowOf(f0), { ...f0, ebStatus: 'canceled' }, matchVenue('77', venues), NOW);
  assert.ok(r.changed.includes('publishState'));
  assert.equal(cell(r.cells, C.status).value, 'Cancelled');
  assert.equal(cell(r.cells, C.publishStatus).value, 'Cancelled');
  assert.equal(cell(r.cells, C.published).value, false);
  assert.equal(JSON.parse(cell(r.cells, C.lastEbPushedValues).value).ebStatus, 'canceled');
});
test('flow-in venue: changed on Eventbrite, matched and unmatched', () => {
  const f0 = liveF();
  const r = planFlowIn(rowOf(f0), { ...f0, ebVenueId: '90' }, matchVenue('90', venues), NOW);
  assert.deepEqual(r.changed, ['venue']);
  assert.equal(cell(r.cells, C.venue).value, 'i-park');
  assert.equal(cell(r.cells, C.venueOther).value, '');
  assert.equal(cell(r.cells, C.addressVisibility).value, 'Public');
  let snap = JSON.parse(cell(r.cells, C.lastEbPushedValues).value);
  assert.equal(snap.ebVenueId, '90'); assert.equal(snap.venueName, 'The Park');
  const u = planFlowIn(rowOf(f0), { ...f0, ebVenueId: '55', venueText: 'Elsewhere, 2 Oak' }, matchVenue('55', venues), NOW);
  assert.equal(cell(u.cells, C.venue).value, '');
  assert.equal(cell(u.cells, C.venueOther).value, 'Elsewhere, 2 Oak');
  snap = JSON.parse(cell(u.cells, C.lastEbPushedValues).value);
  assert.equal(snap.ebVenueId, '55'); assert.equal(snap.venueName, '');
});
test('flow-in venue: plan venue edited too is a conflict', () => {
  const f0 = liveF();
  const r = planFlowIn(rowOf(f0, { venueName: 'Somewhere' }), { ...f0, ebVenueId: '90' }, matchVenue('90', venues), NOW);
  assert.deepEqual(r.conflicts, ['venue']); assert.deepEqual(r.cells, []);
});
test('flow-in never pushed: Eventbrite wins where it differs from plan, no conflicts', () => {
  const f = liveF();
  const row = { ...rowOf(f, { start: '09:00', title: 'Old' }), pushed: null };
  const r = planFlowIn(row, f, matchVenue('77', venues), NOW);
  assert.deepEqual(r.conflicts, []);
  assert.ok(r.changed.includes('start') && r.changed.includes('title'));
  assert.ok(!r.changed.includes('date') && !r.changed.includes('venue'));
  assert.equal(cell(r.cells, C.start).value, '10:00');
  const snap = JSON.parse(cell(r.cells, C.lastEbPushedValues).value);
  assert.equal(snap.start, '10:00'); assert.equal(snap.date, f.date); assert.equal(snap.publicSummary, 'S');
});
test('flow-in: old snapshot with no ebVenueId adopts the live venue as baseline', () => {
  const f0 = liveF();
  const row = rowOf(f0);
  delete row.pushed.ebVenueId;
  const r = planFlowIn(row, { ...f0, ebVenueId: '90' }, matchVenue('90', venues), NOW);
  assert.deepEqual(r.changed, []); assert.deepEqual(r.conflicts, []);
  assert.equal(cell(r.cells, C.venue), undefined); assert.equal(cell(r.cells, C.venueOther), undefined);
  assert.equal(cell(r.cells, C.lastFromEb), undefined);
  assert.equal(r.cells.length, 1);
  const snap = JSON.parse(cell(r.cells, C.lastEbPushedValues).value);
  assert.equal(snap.ebVenueId, '90'); assert.equal(snap.venueName, 'The Hall');
});
test('flow-in: old snapshot with no ebStatus adopts the live status as baseline', () => {
  const f0 = liveF();
  const row = rowOf(f0);
  delete row.pushed.ebStatus;
  const r = planFlowIn(row, { ...f0, ebStatus: 'canceled' }, matchVenue('77', venues), NOW);
  assert.deepEqual(r.changed, []); assert.deepEqual(r.conflicts, []);
  for (const col of [C.status, C.publishStatus, C.published, C.lastFromEb]) assert.equal(cell(r.cells, col), undefined);
  assert.equal(r.cells.length, 1);
  assert.equal(JSON.parse(cell(r.cells, C.lastEbPushedValues).value).ebStatus, 'canceled');
  // Adoption alongside a real change: both land in one snapshot.
  const r2 = planFlowIn(row, { ...f0, ebStatus: 'canceled', start: '19:00' }, matchVenue('77', venues), NOW);
  assert.deepEqual(r2.changed, ['start']);
  const s2 = JSON.parse(cell(r2.cells, C.lastEbPushedValues).value);
  assert.equal(s2.ebStatus, 'canceled'); assert.equal(s2.start, '19:00');
  assert.deepEqual(JSON.parse(cell(r2.cells, C.lastFromEb).value).fields, ['start']);
});
test('flow-in venue: a lead\'s unpushed address visibility edit makes it a conflict', () => {
  const f0 = liveF();
  const row = rowOf(f0, { addressVisibility: 'Registrants only' });
  assert.equal(row.pushed.addressVisibility, 'Public');
  const r = planFlowIn(row, { ...f0, ebVenueId: '90' }, matchVenue('90', venues), NOW);
  assert.deepEqual(r.conflicts, ['venue']); assert.deepEqual(r.changed, []);
  assert.equal(cell(r.cells, C.venue), undefined); assert.equal(cell(r.cells, C.addressVisibility), undefined);
});
