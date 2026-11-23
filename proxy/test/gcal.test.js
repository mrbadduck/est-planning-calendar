import { test } from 'node:test';
import assert from 'node:assert/strict';
import { onCalendar, inSyncWindow, gcalEventBody, gcalPlan, gcalHash, gcalModeAction, afterGcalResponse, gcalEventIdFor, planGcalRow } from '../src/gcal.js';

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

// ── modes and Google's answers (Task 11) ──
test('gcalModeAction: off skips, shadow logs only, live calls; none always skips', () => {
  assert.equal(gcalModeAction('shadow', 'insert'), 'log-only');
  assert.equal(gcalModeAction('live', 'none'), 'skip');
  assert.equal(gcalModeAction('shadow', 'none'), 'skip');
  assert.equal(gcalModeAction('off', 'insert'), 'skip');
  assert.equal(gcalModeAction(undefined, 'delete'), 'skip');
  assert.equal(gcalModeAction('live', 'patch'), 'call');
  assert.equal(gcalModeAction('live', 'delete'), 'call');
  assert.equal(gcalModeAction('LIVE', 'insert'), 'skip', 'exact value only');
});
test('afterGcalResponse: an insert stores the new id', () => {
  assert.deepEqual(afterGcalResponse('insert', 200, { id: 'abc' }), { ok: true, storeId: 'abc' });
});
test('afterGcalResponse: an insert with no id in the answer is a failure', () => {
  assert.deepEqual(afterGcalResponse('insert', 200, {}), { ok: false });
  assert.deepEqual(afterGcalResponse('insert', 403, { error: {} }), { ok: false });
});
test('afterGcalResponse: an update that 404s or 410s re-inserts', () => {
  assert.deepEqual(afterGcalResponse('patch', 404, null), { ok: false, reinsert: true });
  assert.deepEqual(afterGcalResponse('patch', 410, null), { ok: false, reinsert: true });
  assert.deepEqual(afterGcalResponse('patch', 200, { id: 'abc' }), { ok: true });
  assert.deepEqual(afterGcalResponse('patch', 500, null), { ok: false });
});
test('afterGcalResponse: a delete clears the id, also when Google no longer has it', () => {
  assert.deepEqual(afterGcalResponse('delete', 204, null), { ok: true, clearId: true });
  assert.deepEqual(afterGcalResponse('delete', 410, null), { ok: true, clearId: true });
  assert.deepEqual(afterGcalResponse('delete', 404, null), { ok: true, clearId: true });
  assert.deepEqual(afterGcalResponse('delete', 403, null), { ok: false });
});

// ── fix round 1: one event per row, stale dates, tombstones ──
test('gcalEventIdFor: lowercase hex of the UTF-8 row id, valid base32hex', () => {
  assert.equal(gcalEventIdFor('i-abc'), '692d616263');
  assert.equal(gcalEventIdFor('i-é'), '692dc3a9');
  assert.match(gcalEventIdFor('i-Zx_9-Q'), /^[0-9a-v]{5,1024}$/);
  assert.equal(gcalEventIdFor('i-abc'), gcalEventIdFor('i-abc'), 'deterministic');
});
test('afterGcalResponse: an insert answered 409 means the event already exists', () => {
  assert.deepEqual(afterGcalResponse('insert', 409, { error: { message: 'The requested identifier already exists.' } }), { ok: false, exists: true });
});
const P = (e, st, o = {}) => planGcalRow(e, st, { todayIso: TODAY, opts: OPTS, tomb: null, reapproved: false, ...o });
test('planGcalRow: in the window it is gcalPlan, with the stored id (KV first, then the row)', () => {
  const p = P(ev({ gcalEventId: 'row-id' }), { id: 'kv-id', hash: 'old', date: '2026-12-05' });
  assert.equal(p.op, 'patch');
  assert.equal(p.storedId, 'kv-id');
  assert.equal(P(ev({ gcalEventId: 'row-id' }), null).storedId, 'row-id');
  assert.equal(P(ev(), null).op, 'insert');
});
test('planGcalRow: a date moved back out of the window deletes the event the Worker put up', () => {
  const p = P(ev({ date: '2026-11-10', gcalEventId: 'g1' }), { id: 'g1', hash: 'h', date: '2026-12-05' });
  assert.deepEqual(p, { op: 'delete', storedId: 'g1' });
});
test('planGcalRow: a cleared date deletes too', () => {
  assert.deepEqual(P(ev({ date: '' }), { id: 'g1', hash: 'h', date: '2026-11-21' }), { op: 'delete', storedId: 'g1' });
});
test('planGcalRow: history (stored date already past) is never touched', () => {
  assert.equal(P(ev({ date: '2026-11-01', gcalEventId: 'g1' }), { id: 'g1', hash: 'h', date: '2026-11-01' }).op, 'none');
  assert.equal(P(ev({ date: '2026-11-01', status: 'cancelled', gcalEventId: 'g1' }), null).op, 'none');
});
test('planGcalRow: a tombstone hides the stale row (no update, no insert)', () => {
  const stale = ev({ gcalEventId: 'g1' });   // the cancel has not applied in Coda yet
  assert.equal(P(stale, null, { tomb: { at: 'x' } }).op, 'none');
  assert.equal(P(ev({ status: 'cancelled', gcalEventId: 'g1' }), null, { tomb: { at: 'x' } }).op, 'none');
});
test('planGcalRow: a real re-approval during a tombstone inserts (deterministic id)', () => {
  const p = P(ev({ gcalEventId: 'g1' }), null, { tomb: { at: 'x' }, reapproved: true });
  assert.equal(p.op, 'insert');
  assert.equal(p.storedId, '');
});

test('body: Removed from Eventbrite -> no registration line, unless an external url is set', () => {
  const d = gcalEventBody(ev({ publishStatus: 'Removed from Eventbrite', eventbriteUrl: 'https://eb/1' }), OPTS).description;
  assert.doesNotMatch(d, /Regist/);
  assert.equal(d, 'Join us.\n\nSign up to help: https://gather.eastsidetribe.org/#/event/i-abc');
  const x = 'https://example.org/rsvp';
  assert.match(gcalEventBody(ev({ publishStatus: 'Removed from Eventbrite', externalRegistrationUrl: x }), OPTS).description, new RegExp('Register: ' + x));
});
