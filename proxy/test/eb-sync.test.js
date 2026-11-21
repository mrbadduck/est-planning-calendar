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
