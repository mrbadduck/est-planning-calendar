// web/listing-readiness.js is a plain script attaching `ListingRules` to globalThis.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../../web/listing-readiness.js';

const R = globalThis.ListingRules;
const TODAY = '2026-11-14';
const ready = () => ({ status: 'approved', title: 'Shabbat dinner', scheduling: 'exact', allDay: false,
  date: '2027-03-01', start: '18:00', end: '20:00', capacity: '20', venueName: '', venueOther: '',
  addressVisibility: '', publicDescription: '' });
const failing = (ev, venue = null, which = 'add') =>
  R.readiness(ev, { venue, todayISO: TODAY })[which].filter(c => !c.ok);

test('stageOf follows spec 5.1', () => {
  assert.equal(R.stageOf({ status: 'cancelled', eventbriteId: '1' }), 'cancelled');
  assert.equal(R.stageOf({ status: 'draft' }), 'draft');
  assert.equal(R.stageOf({ status: 'proposed' }), 'proposed');
  assert.equal(R.stageOf({ status: 'approved' }), 'approved');
  assert.equal(R.stageOf({ status: 'approved', eventbriteId: '1', publishStatus: 'Draft' }), 'onEventbrite');
  assert.equal(R.stageOf({ status: 'approved', eventbriteId: '1' }), 'onEventbrite');
  assert.equal(R.stageOf({ status: 'approved', eventbriteId: '1', publishStatus: 'Published' }), 'published');
});

test('stageOf defaults a missing or unknown status to draft', () => {
  assert.equal(R.stageOf({}), 'draft');
  assert.equal(R.stageOf({ status: 'weird' }), 'draft');
});

test('FIELDS marks public fields with pushedKey', () => {
  const pub = ['title', 'date', 'start', 'end', 'venue', 'publicSummary', 'publicDescription', 'capacity', 'addressVisibility'];
  for (const k of ['title', 'description', 'programs', 'leads', ...pub.slice(1)]) assert.ok(R.FIELDS[k], k);
  for (const [k, f] of Object.entries(R.FIELDS)) {
    assert.equal(f.public, pub.includes(k), k);
    if (f.public) assert.equal(f.pushedKey, k === 'venue' ? 'venueName' : k);
  }
});

test('a fully ready approved event passes add; publish needs the description', () => {
  const r = R.readiness(ready(), { venue: null, todayISO: TODAY });
  assert.ok(r.add.every(c => c.ok));
  assert.deepEqual(r.publish.filter(c => !c.ok).map(c => c.key), ['publicDescription']);
  assert.equal(r.publish.filter(c => !c.ok)[0].message, 'Add a public description (Eventbrite requires one to publish)');
  assert.equal(failing({ ...ready(), publicDescription: 'Hi' }, null, 'publish').length, 0);
});

const cases = [
  ['approved', { status: 'proposed' }, 'Needs Tribal Council approval first'],
  ['title', { title: '  ' }, 'Add a title'],
  ['exact', { scheduling: 'range' }, "Pick an exact date and times (Eventbrite can't list a range, month or all-day event)"],
  ['exact', { allDay: true }, "Pick an exact date and times (Eventbrite can't list a range, month or all-day event)"],
  ['date', { date: '' }, 'Add a date'],
  ['future', { date: '2026-11-13' }, "Pick a date that hasn't passed"],
  ['start', { start: '' }, 'Add a start time'],
  ['end', { end: '' }, 'Add an end time'],
  ['endAfterStart', { end: '18:00' }, 'End time must be after the start time'],
  ['capacity', { capacity: '' }, 'Add a capacity: how many free tickets Eventbrite offers'],
  ['venueOther', { venueOther: "Bob's house", venueName: '' }, 'Add this venue to Venues first, so Eventbrite gets its address'],
];
for (const [key, patch, message] of cases) {
  test(`readiness fails ${key}`, () => {
    const f = failing({ ...ready(), ...patch });
    assert.deepEqual(f.map(c => c.key), [key]);
    assert.equal(f[0].message, message);
  });
}

test('today is not in the past', () => assert.equal(failing({ ...ready(), date: TODAY }).length, 0));

test('capacity must be an integer >= 1', () => {
  for (const c of ['0', '1.5', '', 'abc']) assert.deepEqual(failing({ ...ready(), capacity: c }).map(x => x.key), ['capacity'], c);
  for (const c of ['20', 20]) assert.equal(failing({ ...ready(), capacity: c }).length, 0, String(c));
});

test('venue address rule', () => {
  const home = { name: 'X', type: 'Home', hasAddress: false };
  const f = failing({ ...ready(), venueName: 'X', addressVisibility: 'Public' }, home);
  assert.deepEqual(f.map(c => c.key), ['venueAddress']);
  assert.equal(f[0].message, 'Add a street address to the venue, or choose Registrants only');
  assert.equal(failing({ ...ready(), venueName: 'X', addressVisibility: '' }, home).length, 1);
  assert.equal(failing({ ...ready(), venueName: 'X', addressVisibility: 'Registrants only' }, home).length, 0);
  assert.equal(failing({ ...ready(), venueName: 'X', addressVisibility: 'Public' }, { ...home, hasAddress: true }).length, 0);
});

test('addressVisibilityDefault', () => {
  assert.equal(R.addressVisibilityDefault('', { type: 'Home' }), 'Registrants only');
  assert.equal(R.addressVisibilityDefault(undefined, { type: 'Home' }), 'Registrants only');
  assert.equal(R.addressVisibilityDefault('Public', { type: 'Home' }), 'Public');
  assert.equal(R.addressVisibilityDefault('', { type: 'Restaurant/Bar' }), '');
  assert.equal(R.addressVisibilityDefault('', null), '');
});

test('syncStatus and unpushedFields', () => {
  const ev = { title: 'T', date: '2027-03-01', start: '18:30', end: '20:00', venueName: 'V', publicSummary: 'S',
    publicDescription: 'D', capacity: '20', addressVisibility: 'Public', description: 'private' };
  const unknown = R.syncStatus(ev, null);
  assert.deepEqual(Object.keys(unknown).sort(), ['addressVisibility', 'capacity', 'date', 'end', 'publicDescription', 'publicSummary', 'start', 'title', 'venue']);
  assert.ok(Object.values(unknown).every(v => v === 'unknown'));
  const pushed = { title: ' T ', date: '2027-03-01', start: '18:00', end: '20:00', venueName: 'V', publicSummary: 'S',
    publicDescription: 'D', capacity: 20, addressVisibility: 'Public' };
  const s = R.syncStatus({ ...ev, capacity: '25' }, pushed);
  assert.equal(s.start, 'changed');
  assert.equal(s.capacity, 'changed');
  assert.equal(s.title, 'match');
  assert.equal(s.venue, 'match');
  assert.equal(R.syncStatus({ ...ev, capacity: 'abc' }, { ...pushed, capacity: 'abc' }).capacity, 'match');
  assert.equal(R.syncStatus(ev, pushed).capacity, 'match');
  assert.ok(!('description' in s));
  assert.deepEqual(R.unpushedFields({ ...ev, capacity: '25' }, pushed), ['start', 'capacity']);
  assert.deepEqual(R.unpushedFields(ev, null), []);
});
