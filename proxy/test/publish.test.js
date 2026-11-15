import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mutationResult } from '../src/publish.js';

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
