import { test } from 'node:test';
import assert from 'node:assert/strict';
import { onCalendar, inSyncWindow, gcalEventBody, gcalPlan, gcalHash } from '../src/gcal.js';

const OPTS = { tz: 'America/Chicago', gatherBase: 'https://gather.eastsidetribe.org', area: 'Nashville, TN' };
const ev = (o = {}) => ({
  rowId: 'i-abc', title: 'Shabbat Dinner', status: 'approved', scheduling: 'exact',
  allDay: false, date: '2026-12-05', start: '18:00', end: '20:00',
  venueName: 'The Hall', venueOther: '', venueAddress: '1 Main St, Nashville, TN 37201',
  addressVisibility: '', publicSummary: 'Join us.', publishStatus: '', eventbriteUrl: '', ...o,
});
const TODAY = '2026-11-22';

test('onCalendar: approved exact dated future event', () => {
  assert.equal(onCalendar(ev(), TODAY), true);
});
test('onCalendar: no date window, past events still count', () => {
  assert.equal(onCalendar(ev({ date: '2020-01-01' })), true);
});
test('inSyncWindow: yesterday counts, two days ago does not', () => {
  assert.equal(inSyncWindow(ev({ date: '2026-11-21' }), TODAY), true);
  assert.equal(inSyncWindow(ev({ date: '2026-11-20' }), TODAY), false);
});
test('inSyncWindow: yesterday across a month boundary', () => {
  assert.equal(inSyncWindow(ev({ date: '2026-11-30' }), '2026-12-01'), true);
  assert.equal(inSyncWindow(ev({ date: '2026-11-29' }), '2026-12-01'), false);
});
test('onCalendar: cancelled, draft, month idea, no date are off', () => {
  assert.equal(onCalendar(ev({ status: 'cancelled' }), TODAY), false);
  assert.equal(onCalendar(ev({ status: 'proposed' }), TODAY), false);
  assert.equal(onCalendar(ev({ scheduling: 'month' }), TODAY), false);
  assert.equal(onCalendar(ev({ date: '' }), TODAY), false);
});

test('body: summary, timed start/end with zone', () => {
  const b = gcalEventBody(ev(), OPTS);
  assert.equal(b.summary, 'Shabbat Dinner');
  assert.deepEqual(b.start, { dateTime: '2026-12-05T18:00:00', timeZone: 'America/Chicago' });
  assert.deepEqual(b.end, { dateTime: '2026-12-05T20:00:00', timeZone: 'America/Chicago' });
});
test('body: missing end is start + 2 hours, across midnight too', () => {
  assert.equal(gcalEventBody(ev({ end: '' }), OPTS).end.dateTime, '2026-12-05T20:00:00');
  assert.equal(gcalEventBody(ev({ start: '23:00', end: '' }), OPTS).end.dateTime, '2026-12-06T01:00:00');
});
test('body: all-day uses date and next day', () => {
  const b = gcalEventBody(ev({ allDay: true, date: '2026-12-06' }), OPTS);
  assert.deepEqual(b.start, { date: '2026-12-06' });
  assert.deepEqual(b.end, { date: '2026-12-07' });
  assert.deepEqual(gcalEventBody(ev({ allDay: true, date: '2026-12-31' }), OPTS).end, { date: '2027-01-01' });
});
test('body: not on Eventbrite -> coming soon, exact description', () => {
  assert.equal(
    gcalEventBody(ev(), OPTS).description,
    'Join us.\n\nRegistration on Eventbrite coming soon\n\nSign up to help: https://gather.eastsidetribe.org/#/event/i-abc',
  );
});
test('body: published -> Register: eventbrite url', () => {
  const b = gcalEventBody(ev({ publishStatus: 'Published', eventbriteUrl: 'https://www.eventbrite.com/e/x-1' }), OPTS);
  assert.match(b.description, /\n\nRegister: https:\/\/www\.eventbrite\.com\/e\/x-1\n\n/);
});
test('body: external url used when not published; Eventbrite wins when published', () => {
  const x = 'https://example.org/rsvp';
  assert.match(gcalEventBody(ev({ externalRegistrationUrl: x }), OPTS).description, new RegExp('Register: ' + x));
  const b = gcalEventBody(ev({ externalRegistrationUrl: x, publishStatus: 'Published', eventbriteUrl: 'https://eb/1' }), OPTS);
  assert.match(b.description, /Register: https:\/\/eb\/1/);
  assert.doesNotMatch(b.description, /example\.org/);
});
test('body: published without a url falls through to coming soon', () => {
  assert.match(gcalEventBody(ev({ publishStatus: 'Published' }), OPTS).description, /coming soon/);
});
test('body: empty summary drops its blank line', () => {
  const d = gcalEventBody(ev({ publicSummary: '' }), OPTS).description;
  assert.ok(d.startsWith('Registration on Eventbrite coming soon\n\nSign up'));
});
test('body: location rules', () => {
  assert.equal(gcalEventBody(ev(), OPTS).location, '1 Main St, Nashville, TN 37201');
  assert.equal(gcalEventBody(ev({ venueAddress: '' }), OPTS).location, 'The Hall');
  assert.equal(gcalEventBody(ev({ venueAddress: '', venueName: '', venueOther: 'Eric’s porch' }), OPTS).location, 'Eric’s porch');
  assert.equal(gcalEventBody(ev({ addressVisibility: 'Registrants only' }), OPTS).location, 'Nashville, TN');
  const none = gcalEventBody(ev({ venueAddress: '', venueName: '', venueOther: '' }), OPTS);
  assert.equal('location' in none, false);
});

test('plan: on calendar, no id -> insert with body and hash', () => {
  const p = gcalPlan(ev(), '', '');
  assert.equal(p.op, 'insert');
  assert.equal(p.body.summary, 'Shabbat Dinner');
  assert.equal(typeof p.hash, 'string');
});
test('plan: same event again -> none; changed -> patch', () => {
  const first = gcalPlan(ev(), '', '');
  assert.equal(gcalPlan(ev(), 'g1', first.hash).op, 'none');
  const p = gcalPlan(ev({ title: 'New' }), 'g1', first.hash);
  assert.equal(p.op, 'patch');
  assert.notEqual(p.hash, first.hash);
});
test('plan: hash is independent of key order', () => {
  const a = gcalPlan(ev(), 'g', '').hash;
  const e = ev(); const rev = Object.fromEntries(Object.entries(e).reverse());
  assert.equal(gcalPlan(rev, 'g', '').hash, a);
});
test('plan: cancelled or back to draft with id -> delete; without id -> none', () => {
  assert.deepEqual(gcalPlan(ev({ status: 'cancelled' }), 'g1', 'h'), { op: 'delete' });
  assert.equal(gcalPlan(ev({ status: 'proposed' }), 'g1', 'h').op, 'delete');
  assert.deepEqual(gcalPlan(ev({ status: 'cancelled' }), '', ''), { op: 'none' });
});

test('plan: a past approved event with a stored id is left alone', () => {
  const past = ev({ date: '2020-01-01' });
  const h = gcalPlan(past, '', '').hash;
  assert.deepEqual(gcalPlan(past, 'g1', h), { op: 'none' });
});
test('body: overnight end rolls to the next day; equal end stays', () => {
  const b = gcalEventBody(ev({ start: '20:00', end: '01:00' }), OPTS);
  assert.equal(b.end.dateTime, '2026-12-06T01:00:00');
  assert.equal(gcalEventBody(ev({ start: '9:00', end: '10:00' }), OPTS).end.dateTime, '2026-12-05T10:00:00');
  assert.equal(gcalEventBody(ev({ start: '18:00', end: '18:00' }), OPTS).end.dateTime, '2026-12-05T18:00:00');
});
test('body: missing start falls back to all-day', () => {
  const b = gcalEventBody(ev({ start: '', end: '' }), OPTS);
  assert.deepEqual(b.start, { date: '2026-12-05' });
  assert.deepEqual(b.end, { date: '2026-12-06' });
});
test('gcalHash: nested key order does not matter', () => {
  assert.equal(gcalHash({ a: { x: 1, y: [{ q: 1, r: 2 }] }, b: 2 }), gcalHash({ b: 2, a: { y: [{ r: 2, q: 1 }], x: 1 } }));
});
