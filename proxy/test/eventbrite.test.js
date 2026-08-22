import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  zonedToUtcISO, eventToEventbritePayload, ticketClassPayload,
  structuredContentBody, venuePayload, eventbriteWebUrl,
} from '../src/eventbrite.js';

const TZ = 'America/Chicago';

test('zonedToUtcISO converts Central wall-time to UTC (CDT, summer)', () => {
  assert.equal(zonedToUtcISO('2026-09-01', '18:00', TZ), '2026-09-01T23:00:00Z');
});
test('zonedToUtcISO converts Central wall-time to UTC (CST, winter, crosses midnight)', () => {
  assert.equal(zonedToUtcISO('2026-01-15', '18:00', TZ), '2026-01-16T00:00:00Z');
});

test('eventToEventbritePayload builds create body with utc+tz, currency, capacity, summary', () => {
  const ev = { title: 'Kabbalat Shabbat', date: '2026-09-01', start: '18:00', end: '20:00',
    capacity: 40, description: 'Come sing with us. '.repeat(20) };
  const p = eventToEventbritePayload(ev, TZ);
  assert.equal(p.event.name.html, 'Kabbalat Shabbat');
  assert.deepEqual(p.event.start, { timezone: TZ, utc: '2026-09-01T23:00:00Z' });
  assert.deepEqual(p.event.end, { timezone: TZ, utc: '2026-09-02T01:00:00Z' });
  assert.equal(p.event.currency, 'USD');
  assert.equal(p.event.capacity, 40);
  assert.equal(p.event.listed, true);
  assert.ok(p.event.summary.length <= 140);
});

test('ticketClassPayload — free ticket uses capacity', () => {
  assert.deepEqual(ticketClassPayload({ capacity: 40 }), {
    ticket_class: { name: 'General Admission', free: true, quantity_total: 40 },
  });
});
test('ticketClassPayload — paid tier (v2 shape) emits cost in cents', () => {
  assert.deepEqual(ticketClassPayload({ capacity: 40, ticketType: 'paid', price: 15 }), {
    ticket_class: { name: 'General Admission', cost: 'USD,1500', quantity_total: 40 },
  });
});

test('structuredContentBody wraps html in a single text module at the given version', () => {
  const b = structuredContentBody('<p>Hi</p>', 3);
  assert.equal(b.modules[0].type, 'text');
  assert.equal(b.modules[0].data.body.text, '<p>Hi</p>');
  assert.equal(b.publish, true);
});

test('venuePayload — public sends the full address', () => {
  const v = venuePayload({ name: 'JCC', address: '801 Percy Warner Blvd, Nashville, TN' }, 'Public');
  assert.equal(v.venue.name, 'JCC');
  assert.equal(v.venue.address.address_1, '801 Percy Warner Blvd, Nashville, TN');
});
test('venuePayload — registrants-only sends NO address (safety invariant)', () => {
  const v = venuePayload({ name: 'Private home', address: '123 Secret St, Nashville, TN' }, 'Registrants only');
  assert.equal(v.venue.name, 'Private home');
  assert.equal(v.venue.address, undefined);   // address must never be present
});

test('eventbriteWebUrl builds the myevent manage link', () => {
  assert.equal(eventbriteWebUrl('123456789'), 'https://www.eventbrite.com/myevent?eid=123456789');
});
