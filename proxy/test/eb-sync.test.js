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
  assert.equal(JSON.parse(ebSnapshot({ ...f, capacity: null }, {})).capacity, '');
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
test('flow-in echo: plan already holds the live value; only the snapshot is refreshed', () => {
  const f0 = liveF({ start: '18:00' });
  const r = planFlowIn(rowOf(f0, { start: '19:00' }), { ...f0, start: '19:00', changed: 'X2' }, matchVenue('77', venues), NOW);
  assert.deepEqual(r.changed, []); assert.deepEqual(r.conflicts, []);
  assert.equal(r.cells.length, 1, 'just the snapshot cell, no Last from Eventbrite');
  const snap = JSON.parse(cell(r.cells, C.lastEbPushedValues).value);
  assert.equal(snap.start, '19:00'); assert.equal(snap.ebChanged, 'X2');
});
test('flow-in: Eventbrite HTML description equals the plain snapshot', () => {
  const f = ebToFields(body(), sc('<p>Hi there</p>'));
  const row = rowOf(f, {}, { publicDescription: 'Hi there' });
  assert.deepEqual(planFlowIn(row, f, matchVenue('77', venues), NOW).changed, []);
});
test('flow-in: text compared with normText, capacity null equals 0', () => {
  const f0 = liveF({ capacity: null });
  const row = rowOf(f0, { title: ' Littles  Shabbat ', capacity: '' });
  assert.equal(row.pushed.capacity, '');
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

// ── Webhook, sweep and the one handler (Task 6) ──────────────────────────
import { removedCells, parseEbWebhook, syncDecision, sweepBatch, secretMatches, seenCells, sweepCandidates, stampPushAt, REMOVED_STATUS, IMPORTING } from '../src/eb-sync.js';

test('removedCells: Publish status Removed from Eventbrite, Published? false, id kept', () => {
  const cells = removedCells();
  assert.equal(REMOVED_STATUS, 'Removed from Eventbrite');
  assert.equal(cells.find((c) => c.column === C.publishStatus).value, 'Removed from Eventbrite');
  assert.equal(cells.find((c) => c.column === C.published).value, false);
  assert.equal(cells.find((c) => c.column === C.eventbriteId), undefined);
});
test('parseEbWebhook: only an Eventbrite event api_url gives an id', () => {
  assert.equal(parseEbWebhook({ api_url: 'https://www.eventbriteapi.com/v3/events/123/' }), '123');
  assert.equal(parseEbWebhook({ api_url: 'https://www.eventbriteapi.com/v3/events/123' }), '123');
  assert.equal(parseEbWebhook({ api_url: 'https://evil.example.com/v3/events/123/' }), null);
  assert.equal(parseEbWebhook({ api_url: 'http://www.eventbriteapi.com/v3/events/123/' }), null);
  assert.equal(parseEbWebhook({ api_url: 'https://www.eventbriteapi.com/v3/events/abc/' }), null);
  assert.equal(parseEbWebhook({ api_url: 'https://www.eventbriteapi.com/v3/orders/123/' }), null);
  assert.equal(parseEbWebhook({}), null);
  assert.equal(parseEbWebhook(null), null);
});
test('syncDecision: pending skip, marker or one row flow-in, none import, two error', () => {
  assert.equal(syncDecision({ rowsWithId: [{ id: 'r1' }], markerRowId: null, pending: { ebId: '1' } }), 'skip');
  assert.equal(syncDecision({ rowsWithId: [], markerRowId: 'r1', pending: null }), 'flowin');
  assert.equal(syncDecision({ rowsWithId: [{ id: 'r1' }], markerRowId: null, pending: null }), 'flowin');
  assert.equal(syncDecision({ rowsWithId: [], markerRowId: null, pending: null }), 'import');
  assert.equal(syncDecision({ rowsWithId: [{ id: 'r1' }, { id: 'r2' }], markerRowId: null, pending: null }), 'error');
});
test('syncDecision: an import still applying (marker importing) skips until the row is visible', () => {
  assert.equal(IMPORTING, 'importing');
  assert.equal(syncDecision({ rowsWithId: [], markerRowId: 'importing', pending: null }), 'skip');
  assert.equal(syncDecision({ rowsWithId: [{ id: 'r1' }], markerRowId: 'importing', pending: null }), 'flowin');
});
test('stampPushAt: Last EB push at becomes Eventbrite\'s changed stamp', () => {
  const a = stampPushAt([{ column: C.title, value: 'x' }], '2027-03-01T12:00:00Z');
  assert.deepEqual(a, [{ column: C.title, value: 'x' }, { column: C.lastEbPushAt, value: '2027-03-01T12:00:00Z' }]);
  const b = stampPushAt([{ column: C.lastEbPushAt, value: NOW }, { column: C.title, value: 'x' }], 'ch');
  assert.equal(b.filter((c) => c.column === C.lastEbPushAt).length, 1);
  assert.equal(cell(b, C.lastEbPushAt).value, 'ch');
  assert.deepEqual(stampPushAt([{ column: C.title, value: 'x' }], ''), [{ column: C.title, value: 'x' }]);
});
test('sweepBatch: slices from the cursor; last slice has nextCursor null', () => {
  const c = Array.from({ length: 20 }, (_, i) => i);
  assert.deepEqual(sweepBatch(c, 8, 8), { batch: [8, 9, 10, 11, 12, 13, 14, 15], nextCursor: 16 });
  assert.deepEqual(sweepBatch(c, 16, 8), { batch: [16, 17, 18, 19], nextCursor: null });
  assert.deepEqual(sweepBatch(c, null, 8).batch, [0, 1, 2, 3, 4, 5, 6, 7]);
  // A cursor past the end (the list shrank) starts over.
  assert.deepEqual(sweepBatch(c.slice(0, 5), 8, 8), { batch: [0, 1, 2, 3, 4], nextCursor: null });
});
test('secretMatches: exact match only', () => {
  assert.equal(secretMatches('abc123', 'abc123'), true);
  assert.equal(secretMatches('abc124', 'abc123'), false);
  assert.equal(secretMatches('abc', 'abc123'), false);
  assert.equal(secretMatches('', ''), false);
  assert.equal(secretMatches('x', undefined), false);
});
test('seenCells: records the live changed stamp when nothing flowed in', () => {
  const pushed = { title: 'A', ebChanged: 'old', ebVenueId: '7', ebStatus: 'live' };
  const cells = seenCells({ pushed }, { changed: 'new' });
  assert.equal(cells.length, 1);
  const snap = JSON.parse(cells[0].value);
  assert.equal(cells[0].column, C.lastEbPushedValues);
  assert.equal(snap.ebChanged, 'new'); assert.equal(snap.title, 'A');
  assert.deepEqual(seenCells({ pushed: { ...pushed, ebChanged: 'new' } }, { changed: 'new' }), []);
  assert.deepEqual(seenCells({ pushed: null, title: 'A' }, { changed: '' }), []);
});
test('seenCells: a never-pushed row gets plan as its snapshot, with the live stamp, venue id and status', () => {
  const cells = seenCells({ pushed: null, title: 'A', date: '2027-01-02', capacity: '12', venueName: 'The Hall' },
    { changed: 'new', ebVenueId: '77', ebStatus: 'live' });
  assert.equal(cells.length, 1);
  const snap = JSON.parse(cells[0].value);
  assert.equal(snap.title, 'A'); assert.equal(snap.date, '2027-01-02'); assert.equal(snap.capacity, 12);
  assert.equal(snap.venueName, 'The Hall');
  assert.equal(snap.ebChanged, 'new'); assert.equal(snap.ebVenueId, '77'); assert.equal(snap.ebStatus, 'live');
});
test('sweepCandidates: changed or unknown listed events, plus upcoming rows missing from the listing', () => {
  const row = (id, ebId, o = {}) => ({ id, values: { [C.eventbriteId]: ebId, [C.date]: o.date || '2027-01-10',
    [C.publishStatus]: o.ps || 'Published', [C.lastEbPushedValues]: o.snap === undefined ? JSON.stringify({ ebChanged: 'c1' }) : o.snap } });
  const rows = [
    row('r1', '1'),                                   // listed, same changed -> not a candidate
    row('r2', '2'),                                   // listed, changed differs -> candidate
    row('r5', '5'),                                   // upcoming, not listed -> candidate (no body)
    row('r6', '6', { date: '2026-01-01' }),           // past, not listed -> no
    row('r7', '7', { ps: 'Removed from Eventbrite' }),// already removed -> no
    row('r8', '', {}),                                // no Eventbrite id -> no
  ];
  const listed = [{ id: '1', changed: 'c1' }, { id: '2', changed: 'c2' }, { id: '3', changed: 'c9' }];
  const c = sweepCandidates({ listed, rows, today: '2026-11-22' });
  assert.deepEqual(c.map((x) => x.ebId), ['2', '3', '5']);
  assert.equal(c[0].body.id, '2'); assert.equal(c[2].body, null);
});

// ── Final fix C1: a plan Cancel is never undone by the sync ───────────────
test('C1 flow-in: a Cancelled row never gets Status Approved back from an unpublished listing', () => {
  const f0 = liveF();
  // The cancel route unpublished the listing; the snapshot still says live (not applied yet).
  const r = planFlowIn(rowOf(f0, { status: 'cancelled' }), { ...f0, ebStatus: 'draft', changed: 'X2' }, matchVenue('77', venues), NOW);
  assert.equal(cell(r.cells, C.status), undefined);
  assert.equal(cell(r.cells, C.publishStatus), undefined);
  assert.ok(!r.changed.includes('publishState'));
  // Eventbrite saying canceled still flows in on a Cancelled row.
  const c = planFlowIn(rowOf(f0, { status: 'cancelled' }), { ...f0, ebStatus: 'canceled' }, matchVenue('77', venues), NOW);
  assert.ok(c.changed.includes('publishState'));
  assert.equal(cell(c.cells, C.status).value, 'Cancelled');
});
test('C1 sweepCandidates: a Cancelled row missing from the listing is not checked again', () => {
  const rows = [{ id: 'r1', values: { [C.eventbriteId]: '9', [C.date]: '2027-01-10', [C.status]: 'Cancelled',
    [C.publishStatus]: 'Cancelled', [C.lastEbPushedValues]: '{}' } }];
  assert.deepEqual(sweepCandidates({ listed: [], rows, today: '2026-11-22' }), []);
});

// ── Final fix I1: the webhook for a lead's own push never reverts the fresh snapshot ──
import { pushSnapshot } from '../src/publish.js';
test('I1: a mid-push webhook that reads the old snapshot writes a snapshot equal to the new one', () => {
  const f0 = liveF();
  const edits = { title: 'Littles  Shabbat at the Park', start: '19:00', end: '20:00', capacity: 30, publicDescription: 'New words' };
  const row = rowOf(f0, edits);   // plan holds the pushed values; its snapshot is still the old one
  const f1 = { ...f0, ...edits, title: 'Littles Shabbat at the Park', changed: 'X9' };   // Eventbrite after the push
  const fresh = JSON.parse(pushSnapshot({ ...row, ...edits }, f1, 'tc1'));
  const r = planFlowIn(row, f1, matchVenue('77', venues), NOW);
  assert.deepEqual(r.changed, []); assert.deepEqual(r.conflicts, []);
  assert.equal(r.cells.length, 1); assert.equal(cell(r.cells, C.lastFromEb), undefined);
  const snap = JSON.parse(cell(r.cells, C.lastEbPushedValues).value);
  for (const k of ['title', 'date', 'start', 'end', 'capacity', 'publicDescription', 'venueName', 'addressVisibility', 'ebVenueId', 'ebStatus'])
    assert.deepEqual(snap[k], fresh[k], k);
});
test('I1: an echo that matches the snapshot already writes nothing', () => {
  const f0 = liveF();
  assert.deepEqual(planFlowIn(rowOf(f0), f0, matchVenue('77', venues), NOW), { cells: [], changed: [], conflicts: [] });
});

// ── Final fix I2: automatic status steps are not Eventbrite changes ──
test('I2: live -> ended changes no row cell and is not reported as changed', () => {
  const f0 = liveF();
  const r = planFlowIn(rowOf(f0), { ...f0, ebStatus: 'ended', changed: 'X3' }, matchVenue('77', venues), NOW);
  assert.deepEqual(r.changed, []);
  for (const col of [C.status, C.publishStatus, C.published, C.lastFromEb]) assert.equal(cell(r.cells, col), undefined);
  assert.equal(r.cells.length, 1);
  assert.equal(JSON.parse(cell(r.cells, C.lastEbPushedValues).value).ebStatus, 'ended');
});

// ── Final fix M1: imports store a blank capacity as blank ──
test('M1: ebSnapshot stores a null capacity as blank, matching the import cell', () => {
  const f = liveF({ capacity: null });
  assert.equal(JSON.parse(ebSnapshot(f, {})).capacity, '');
  const cells = importCells(f, matchVenue('77', venues), NOW);
  assert.equal(cell(cells, C.capacity).value, '');
  assert.equal(JSON.parse(cell(cells, C.lastEbPushedValues).value).capacity, cell(cells, C.capacity).value);
  assert.equal(JSON.parse(ebSnapshot(liveF(), {})).capacity, 25);
});
