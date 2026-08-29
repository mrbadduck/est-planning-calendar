import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  zonedToUtcISO, eventToEventbritePayload, ticketClassPayload,
  structuredContentBody, venuePayload, eventbriteWebUrl, nextScVersion,
  ebEventSnapshot, structuredContentText, editedSincePush, activeAttendeeEmails, normText,
} from '../src/eventbrite.js';

const TZ = 'America/Chicago';

test('zonedToUtcISO converts Central wall-time to UTC (CDT, summer)', () => {
  assert.equal(zonedToUtcISO('2026-09-01', '18:00', TZ), '2026-09-01T23:00:00Z');
});
test('zonedToUtcISO converts Central wall-time to UTC (CST, winter, crosses midnight)', () => {
  assert.equal(zonedToUtcISO('2026-01-15', '18:00', TZ), '2026-01-16T00:00:00Z');
});

test('eventToEventbritePayload builds create body with utc+tz, currency, capacity; create falls back to description snippet for summary', () => {
  const ev = { title: 'Kabbalat Shabbat', date: '2026-09-01', start: '18:00', end: '20:00',
    capacity: 40, description: 'Come sing with us. '.repeat(20) };
  const p = eventToEventbritePayload(ev, TZ, { isCreate: true });
  assert.equal(p.event.name.html, 'Kabbalat Shabbat');
  assert.deepEqual(p.event.start, { timezone: TZ, utc: '2026-09-01T23:00:00Z' });
  assert.deepEqual(p.event.end, { timezone: TZ, utc: '2026-09-02T01:00:00Z' });
  assert.equal(p.event.currency, 'USD');
  assert.equal(p.event.capacity, 40);
  assert.equal(p.event.listed, true);
  assert.ok(p.event.summary.length <= 140);
});

test('eventToEventbritePayload prefers publicSummary for summary (<=140)', () => {
  const ev = { title: 'Kabbalat Shabbat', date: '2026-09-01', start: '18:00', end: '20:00',
    publicSummary: 'Sing in Shabbat with us.', description: '<p>Long internal planning copy.</p>' };
  const p = eventToEventbritePayload(ev, TZ);
  assert.equal(p.event.summary, 'Sing in Shabbat with us.');
  assert.ok(p.event.summary.length <= 140);
});

test('eventToEventbritePayload OMITS summary on update when none staged (never wipes the live blurb)', () => {
  const ev = { title: 'Kabbalat Shabbat', date: '2026-09-01', start: '18:00', end: '20:00', description: 'internal copy' };
  const upd = eventToEventbritePayload(ev, TZ);                 // no isCreate, no publicSummary
  assert.equal('summary' in upd.event, false);                 // omitted -> Eventbrite keeps its summary
  const crt = eventToEventbritePayload(ev, TZ, { isCreate: true });
  assert.equal(crt.event.summary, 'internal copy');            // create still seeds one
  // a staged summary is always sent (update included)
  assert.equal(eventToEventbritePayload({ ...ev, publicSummary: 'Blurb' }, TZ).event.summary, 'Blurb');
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
  assert.equal(b.modules[0].data.body.alignment, 'left');
  assert.equal(b.publish, true);
});

test('nextScVersion — string page_version_number (Eventbrite returns "12") → 13', () => {
  // The real §B bug: EB returns page_version_number as a STRING; a typeof-number
  // check silently rewrote version 0 forever → page-version discontinuity.
  assert.equal(nextScVersion({ page_version_number: '12' }), 13);
});
test('nextScVersion — numeric page_version_number → +1', () => {
  assert.equal(nextScVersion({ page_version_number: 4 }), 5);
});
test('nextScVersion — brand-new event (no structured content yet) → 0', () => {
  assert.equal(nextScVersion({ error: 'NOT_FOUND' }), 0);
  assert.equal(nextScVersion(null), 0);
  assert.equal(nextScVersion({}), 0);
});

const AREA = { city: 'Nashville', region: 'TN', country: 'US' };
test('venuePayload — public sends the full street address + structured city/region/country', () => {
  const v = venuePayload({ name: 'JCC', address: '801 Percy Warner Blvd, Nashville, TN' }, 'Public', AREA);
  assert.equal(v.venue.name, 'JCC');
  assert.equal(v.venue.address.address_1, '801 Percy Warner Blvd, Nashville, TN');
  assert.equal(v.venue.address.city, 'Nashville');
  assert.equal(v.venue.address.country, 'US');
});
test('venuePayload — registrants-only sends only a coarse area + generic name, never the real street/name (safety invariant)', () => {
  const v = venuePayload({ name: "Eric & Hilary's House", address: '1115 Delmas Ave Nashville, TN 37216' }, 'Registrants only', AREA);
  assert.equal(v.venue.name, 'Address shared upon registration');   // generic — no host name
  assert.equal(v.venue.address.city, 'Nashville');                  // coarse area only
  assert.equal(v.venue.address.country, 'US');
  assert.equal(v.venue.address.address_1, undefined);               // NO street line
  const blob = JSON.stringify(v);
  assert.ok(!blob.includes('Delmas'), 'must not leak the street');
  assert.ok(!blob.includes('Eric & Hilary'), 'must not leak the host-identifying name');
});

test('eventbriteWebUrl builds the myevent manage link', () => {
  assert.equal(eventbriteWebUrl('123456789'), 'https://www.eventbrite.com/myevent?eid=123456789');
});

test('ebEventSnapshot normalizes the expanded event read', () => {
  const s = ebEventSnapshot({
    name: { text: 'Break Fast', html: '<b>Break Fast</b>' },
    status: 'live', url: 'https://www.eventbrite.com/e/123', listed: true, capacity: 40,
    changed: '2026-08-30T10:00:00Z',
    start: { local: '2026-09-22T18:00:00', timezone: 'America/Chicago' },
    end: { local: '2026-09-22T20:00:00' },
    venue: { name: 'JCC' }, online_event: false,
    ticket_classes: [{ quantity_sold: 12, quantity_total: 40 }, { quantity_sold: 3, quantity_total: 10 }],
  });
  assert.equal(s.name, 'Break Fast');
  assert.equal(s.summary, '');
  assert.equal(s.status, 'live');
  assert.equal(s.startLocal, '2026-09-22T18:00:00');
  assert.equal(s.capacity, 40);
  assert.equal(s.venueName, 'JCC');
  assert.equal(s.ticketClasses, 2);
  assert.equal(s.sold, 15);
  assert.equal(s.ticketTotal, 50);
  assert.equal(s.changed, '2026-08-30T10:00:00Z');
  // sparse body -> safe defaults
  const empty = ebEventSnapshot({});
  assert.equal(empty.name, '');
  assert.equal(empty.sold, 0);
  assert.equal(empty.capacity, null);
});

test('structuredContentText extracts + strips the text modules', () => {
  const body = { modules: [
    { type: 'text', data: { body: { text: '<p>Come <b>eat</b>.</p>' } } },
    { type: 'image', data: {} },
    { type: 'text', data: { body: { text: 'Bring a dish.' } } },
  ] };
  assert.equal(structuredContentText(body), 'Come eat.\nBring a dish.');
  assert.equal(structuredContentText({}), '');
  assert.equal(structuredContentText(null), '');
});

test('editedSincePush: conflict only when EB changed > last push + 60s skew', () => {
  const push = '2026-08-30T10:00:00Z';
  assert.equal(editedSincePush('2026-08-30T12:00:00Z', push), true);    // real EB-side edit
  assert.equal(editedSincePush('2026-08-30T10:00:30Z', push), false);   // our own push bumping `changed`
  assert.equal(editedSincePush('2026-08-30T09:00:00Z', push), false);   // older than push
  assert.equal(editedSincePush('', push), false);                       // unknown -> never block
  assert.equal(editedSincePush('2026-08-30T12:00:00Z', ''), false);     // no stamp yet (pre-guard events)
});

test('activeAttendeeEmails filters cancelled/refunded and normalizes', () => {
  const emails = activeAttendeeEmails([
    { cancelled: false, refunded: false, profile: { email: 'Leah@X.com ' } },
    { cancelled: true, profile: { email: 'gone@x.com' } },
    { refunded: true, profile: { email: 'refund@x.com' } },
    { cancelled: false, profile: {} },
    null,
  ]);
  assert.deepEqual(emails, ['leah@x.com']);
});

test('normText: the did-the-user-change-it signal for the description skip', () => {
  assert.equal(normText('  Come   eat.\n\nBring a dish. '), 'Come eat. Bring a dish.');
  // stripped live copy vs re-staged plain text: equal -> the SC rewrite is
  // skipped and Eventbrite-side rich formatting survives
  const liveSc = { modules: [{ type: 'text', data: { body: { text: '<p>Come <b>eat</b>.</p><p>Bring a dish.</p>' } } }] };
  assert.equal(normText(structuredContentText(liveSc)), normText('Come eat.\nBring a dish.'));
  assert.equal(normText(''), '');
  assert.equal(normText(null), '');
});
