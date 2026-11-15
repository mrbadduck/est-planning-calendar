import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mutationResult, cancelPlan, ebGone, deleteGate, isPublishedCell } from '../src/publish.js';

test('mutationResult: 200 completed true', () => {
  assert.deepEqual(mutationResult(200, { completed: true }), { httpStatus: 200, json: { completed: true } });
});
test('mutationResult: 200 completed false / missing', () => {
  assert.deepEqual(mutationResult(200, { completed: false }), { httpStatus: 200, json: { completed: false } });
  assert.deepEqual(mutationResult(200, {}), { httpStatus: 200, json: { completed: false } });
  assert.deepEqual(mutationResult(200, null), { httpStatus: 200, json: { completed: false } });
});
test('mutationResult: 400 is unknown request id', () => {
  assert.deepEqual(mutationResult(400, {}), { httpStatus: 400, json: { error: 'unknown request id' } });
});
test('mutationResult: other is 502', () => {
  assert.deepEqual(mutationResult(500, {}), { httpStatus: 502, json: { error: 'coda 500' } });
});

import { rowToListingEvent, pushedValues, hhmm } from '../src/publish.js';

const row = {
  Title: 'Shabbat Dinner', Status: 'Approved', Scheduling: 'Exact', 'All day': false,
  Date: '2026-12-05T00:00:00.000-06:00', Start: '1899-12-30T18:30:00.000-06:00', End: '19:45',
  Capacity: 40, Venue: ['Mirowitz Home'], 'Venue (other)': '', 'Address visibility': 'Registrants only',
  'Public summary': 'Sum', 'Public description': '<p>Hi</p>', 'Event Description': 'internal',
  'Eventbrite Event ID': '123', 'Eventbrite Ticket Class ID': '456',
  'Last EB pushed values': '{"title":"Shabbat Dinner","capacity":40}',
};

test('hhmm normalises Coda times', () => {
  assert.equal(hhmm('1899-12-30T18:30:00.000-06:00'), '18:30');
  assert.equal(hhmm('09:05'), '09:05');
  assert.equal(hhmm(undefined), '');
});
test('rowToListingEvent maps a probe-shaped row', () => {
  const ev = rowToListingEvent(row);
  assert.equal(ev.status, 'approved');
  assert.equal(ev.scheduling, 'exact');
  assert.equal(ev.allDay, false);
  assert.equal(ev.date, '2026-12-05');
  assert.equal(ev.start, '18:30');
  assert.equal(ev.end, '19:45');
  assert.equal(ev.capacity, 40);
  assert.equal(ev.venueName, 'Mirowitz Home');
  assert.equal(ev.addressVisibility, 'Registrants only');
  assert.equal(ev.description, 'internal');
  assert.equal(ev.eventbriteId, '123');
  assert.equal(ev.ticketClassId, '456');
  assert.deepEqual(ev.pushed, { title: 'Shabbat Dinner', capacity: 40 });
});
test('empty Venue array gives venueName empty', () => {
  assert.equal(rowToListingEvent({ ...row, Venue: [] }).venueName, '');
});
test('bad or missing pushed JSON gives null', () => {
  assert.equal(rowToListingEvent({ ...row, 'Last EB pushed values': '{nope' }).pushed, null);
  assert.equal(rowToListingEvent({ ...row, 'Last EB pushed values': '' }).pushed, null);
  assert.equal(rowToListingEvent({ ...row, 'Last EB pushed values': undefined }).pushed, null);
});
test('pushedValues round-trips with numeric capacity', () => {
  const ev = rowToListingEvent(row);
  const p = JSON.parse(pushedValues({ ...ev, capacity: '40' }, { ticketClassId: 'tc9' }));
  assert.deepEqual(Object.keys(p).sort(), ['addressVisibility', 'capacity', 'date', 'end', 'publicDescription', 'publicSummary', 'start', 'ticketClassId', 'title', 'venueName']);
  assert.strictEqual(p.capacity, 40);
  assert.equal(p.ticketClassId, 'tc9');
  assert.equal(p.venueName, 'Mirowitz Home');
});

import { descriptionToWrite } from '../src/publish.js';

test('descriptionToWrite: blank public description -> null (never the internal one)', () => {
  assert.equal(descriptionToWrite({ publicDescription: '', description: 'internal' }, null), null);
  assert.equal(descriptionToWrite({ publicDescription: '   ', description: 'internal' }, { publicDescription: 'x' }), null);
});
test('descriptionToWrite: equals pushed (whitespace-insensitive) -> null', () => {
  assert.equal(descriptionToWrite({ publicDescription: ' Come  sing\nwith us ' }, { publicDescription: 'Come sing with us' }), null);
});
test('descriptionToWrite: different from pushed -> the text', () => {
  assert.equal(descriptionToWrite({ publicDescription: 'New copy' }, { publicDescription: 'Old copy' }), 'New copy');
});
test('descriptionToWrite: no pushed snapshot + non-blank -> the text', () => {
  assert.equal(descriptionToWrite({ publicDescription: 'Hello' }, null), 'Hello');
});

import { ticketPlan } from '../src/publish.js';

test('ticketPlan: create path always creates', () => {
  assert.deepEqual(ticketPlan({ isCreate: true, storedTcId: '', classes: null, capacity: 40 }), { action: 'create' });
});
test('ticketPlan: stored id + capacity -> update that class', () => {
  assert.deepEqual(ticketPlan({ isCreate: false, storedTcId: 'tc1', classes: null, capacity: 40 }), { action: 'update', id: 'tc1' });
});
test('ticketPlan: stored id, no capacity -> none', () => {
  assert.deepEqual(ticketPlan({ isCreate: false, storedTcId: 'tc1', classes: null, capacity: '' }), { action: 'none' });
});
test('ticketPlan: no stored id, 0 classes -> create', () => {
  assert.deepEqual(ticketPlan({ isCreate: false, storedTcId: '', classes: [], capacity: 40 }), { action: 'create' });
});
test('ticketPlan: no stored id, exactly 1 class -> adopt it', () => {
  assert.deepEqual(ticketPlan({ isCreate: false, storedTcId: '', classes: [{ id: 'tc9' }], capacity: 40 }), { action: 'adopt', id: 'tc9' });
});
test('ticketPlan: no stored id, more than 1 class -> leave alone', () => {
  assert.deepEqual(ticketPlan({ isCreate: false, storedTcId: '', classes: [{ id: 'a' }, { id: 'b' }], capacity: 40 }), { action: 'leave' });
});
test('ticketPlan: no stored id, classes not fetched -> none', () => {
  assert.deepEqual(ticketPlan({ isCreate: false, storedTcId: '', classes: null, capacity: 40 }), { action: 'none' });
});

import { previewModel } from '../src/publish.js';

test('previewModel: online draft, no tickets, null summary', () => {
  const m = previewModel(
    { name: { text: 'Shabbat' }, summary: null, start: { local: '2026-12-05T18:00:00', timezone: 'America/Chicago' }, end: { local: '2026-12-05T20:00:00', timezone: 'America/Chicago' }, status: 'draft', online_event: true, venue: null, ticket_classes: [], logo: null },
    { description: '<p>Hi</p>' }, 'Public');
  assert.equal(m.location.online, true);
  assert.equal(m.location.displayAddress, '');
  assert.equal(m.location.name, '');
  assert.deepEqual(m.tickets, []);
  assert.equal(m.summary, '');
  assert.equal(m.logoUrl, null);
  assert.equal(m.descriptionHtml, '<p>Hi</p>');
  assert.equal(m.name, 'Shabbat');
  assert.equal(m.startLocal, '2026-12-05T18:00:00');
  assert.equal(m.timezone, 'America/Chicago');
  assert.equal(m.status, 'draft');
});
const venueEv = () => ({ name: { text: 'X' }, summary: 's', start: { local: 'a', timezone: 'tz' }, end: { local: 'b', timezone: 'tz' }, status: 'draft', online_event: false,
  venue: { name: 'The Hall', address: { localized_address_display: '1 Main St, Nashville, TN 37201', city: 'Nashville', region: 'TN' } },
  ticket_classes: [{ name: 'General', free: true, quantity_total: 50 }], logo: { url: 'http://l' } });
test('previewModel: registrants only hides street address', () => {
  const m = previewModel(venueEv(), { description: '' }, 'Registrants only');
  assert.equal(m.location.displayAddress, 'Nashville, TN');
  assert.equal(m.location.note, 'Full address shown to registrants only');
  assert.equal(m.location.name, 'The Hall');
  assert.ok(!JSON.stringify(m).includes('1 Main St'));
  assert.deepEqual(m.tickets, [{ name: 'General', free: true, quantityTotal: 50 }]);
  assert.equal(m.logoUrl, 'http://l');
});
test('previewModel: public shows full address', () => {
  const m = previewModel(venueEv(), { description: '' }, 'Public');
  assert.equal(m.location.displayAddress, '1 Main St, Nashville, TN 37201');
  assert.equal(m.location.note, '');
});

// --- Task 9: cancel / delete against Eventbrite's order rules (F7) ---
test('ebGone: 404, deleted and canceled count as already done', () => {
  assert.equal(ebGone({ status: 404 }), true);
  assert.equal(ebGone({ ok: true, status: 200, body: { status: 'deleted' } }), true);
  assert.equal(ebGone({ ok: true, status: 200, body: { status: 'canceled' } }), true);
  assert.equal(ebGone({ ok: true, status: 200, body: { status: 'live' } }), false);
  assert.equal(ebGone({ ok: false, status: 500, body: null }), false);
});
test('cancelPlan: registrants block; live/started unpublish; draft delete; others leave alone', () => {
  assert.deepEqual(cancelPlan({ status: 'live', sold: 12 }), { action: 'blocked', registrants: 12 });
  assert.deepEqual(cancelPlan({ status: 'draft', sold: 1 }), { action: 'blocked', registrants: 1 });
  assert.deepEqual(cancelPlan({ status: 'live', sold: 0 }), { action: 'unpublish' });
  assert.deepEqual(cancelPlan({ status: 'started', sold: 0 }), { action: 'unpublish' });
  assert.deepEqual(cancelPlan({ status: 'draft', sold: 0 }), { action: 'delete' });
  assert.deepEqual(cancelPlan({ status: 'ended', sold: 0 }), { action: 'none' });
});
test('isPublishedCell reads Coda booleans', () => {
  assert.equal(isPublishedCell(true), true);
  assert.equal(isPublishedCell('true'), true);
  assert.equal(isPublishedCell(false), false);
  assert.equal(isPublishedCell(''), false);
  assert.equal(isPublishedCell(undefined), false);
});
test('deleteGate: published refused for everyone; leads may delete unpublished non-cancelled rows', () => {
  const lead = { canWrite: true, canApprove: false }, council = { canWrite: true, canApprove: true };
  assert.deepEqual(deleteGate({ published: true, status: 'Approved' }, council), { status: 409, error: 'Cancel this event before deleting it' });
  assert.deepEqual(deleteGate({ published: true, status: 'Approved' }, lead), { status: 409, error: 'Cancel this event before deleting it' });
  assert.equal(deleteGate({ published: false, status: 'Draft' }, lead), null);
  assert.equal(deleteGate({ published: false, status: 'Proposed' }, lead), null);
  assert.deepEqual(deleteGate({ published: false, status: 'Cancelled' }, lead), { status: 403, error: 'delete requires Tribal Council' });
  assert.equal(deleteGate({ published: false, status: 'Cancelled' }, council), null);
  assert.deepEqual(deleteGate({ published: false, status: 'Draft' }, { canWrite: false, canApprove: false }), { status: 403, error: 'not authorized' });
});
test('deleteGate: a live/started Eventbrite listing refuses delete even when Published? is stale-false', () => {
  const lead = { canWrite: true, canApprove: false }, council = { canWrite: true, canApprove: true };
  const refused = { status: 409, error: 'Cancel this event before deleting it' };
  for (const who of [lead, council]) {
    assert.deepEqual(deleteGate({ published: false, status: 'Approved', ebStatus: 'live' }, who), refused);
    assert.deepEqual(deleteGate({ published: false, status: 'Approved', ebStatus: 'started' }, who), refused);
    assert.equal(deleteGate({ published: false, status: 'Approved', ebStatus: 'draft' }, who), null);
  }
});

import { venueRefItem } from '../src/publish.js';

test('venueRefItem: projects a venue row without its address (R12)', () => {
  const row = { id: 'i-1', name: 'Mirowitz Home', href: 'x', values: {
    'Venue Name': 'Mirowitz Home', 'Venue Type': 'Home', 'Closed/Unavailable?': false,
    Address: '123 Secret St, Nashville, TN', Notes: 'gate code 1234' } };
  const out = venueRefItem(row);
  assert.deepEqual(out, { id: 'i-1', name: 'Mirowitz Home',
    values: { 'Venue Type': 'Home', 'Closed/Unavailable?': false }, hasAddress: true });
  assert.ok(!JSON.stringify(out).includes('Secret'));
});
test('venueRefItem: no address, array type, closed', () => {
  const out = venueRefItem({ id: 'i-2', name: 'Park', values: { 'Venue Type': ['Outdoor'], 'Closed/Unavailable?': true, Address: '' } });
  assert.deepEqual(out, { id: 'i-2', name: 'Park', values: { 'Venue Type': 'Outdoor', 'Closed/Unavailable?': true }, hasAddress: false });
  assert.equal(venueRefItem({ id: 'i-3', name: 'X' }).hasAddress, false);
});

import { effectiveAddressVisibility } from '../src/publish.js';

test('effectiveAddressVisibility: blank at a Home venue is Registrants only (R14)', () => {
  assert.equal(effectiveAddressVisibility('', { name: 'H', type: 'Home', hasAddress: true }), 'Registrants only');
  assert.equal(effectiveAddressVisibility(null, { name: 'H', type: 'Home' }), 'Registrants only');
  assert.equal(effectiveAddressVisibility('  ', { name: 'H', type: 'Home' }), 'Registrants only');
});
test('effectiveAddressVisibility: explicit choices and non-Home venues are kept', () => {
  assert.equal(effectiveAddressVisibility('Public', { name: 'H', type: 'Home' }), 'Public');
  assert.equal(effectiveAddressVisibility('Registrants only', { name: 'H', type: 'Home' }), 'Registrants only');
  assert.equal(effectiveAddressVisibility('', { name: 'JCC', type: 'Partner' }), '');
  assert.equal(effectiveAddressVisibility('', null), '');
});
