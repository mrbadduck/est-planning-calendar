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
  assert.equal(r.publish.filter(c => !c.ok)[0].message, 'Add a description (Eventbrite requires one to publish)');
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
  ['capacity', { capacity: '' }, 'Add the number of free tickets'],
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

// ---- footerModel / changeNotice (Task 3) ----
const LEAD = { canEdit: true, canApprove: false };
const COUNCIL = { canEdit: true, canApprove: true };
const fm = (o) => {
  const ev = o.ev || ready();
  return R.footerModel({ stage: 'approved', past: false, role: LEAD, pending: false, unpushed: [],
    ebEditedElsewhere: false, registrants: null, proposedBy: null, justChanged: null,
    checks: R.readiness(ev, { todayISO: TODAY }), ...o });
};
const acts = m => m.menu.map(x => x.act);

test('footerModel draft lead', () => {
  const m = fm({ stage: 'draft' });
  assert.equal(m.title, 'Draft: only leads can see this');
  assert.equal(m.primary.label, 'Propose to council');
  assert.equal(m.primary.act, 'propose');
  assert.deepEqual(acts(m), ['delete']);
  assert.deepEqual(m.steps.map(s => s.state), ['current', 'todo', 'todo', 'todo', 'todo']);
});

test('footerModel proposed lead and council', () => {
  const l = fm({ stage: 'proposed' });
  assert.equal(l.title, 'Awaiting Tribal Council approval');
  assert.equal(l.primary.label, '✓ Saved');
  assert.equal(l.primary.enabled, false);
  assert.deepEqual(acts(l), ['delete']);
  const c = fm({ stage: 'proposed', role: COUNCIL, proposedBy: { name: 'Dana', date: 'Nov 3' } });
  assert.equal(c.title, 'Needs your approval');
  assert.match(c.sub, /Proposed Nov 3 by Dana\./);
  assert.equal(c.primary.act, 'approve');
  assert.deepEqual(acts(c), ['delete']);
});

test('footerModel approved not ready', () => {
  const ev = { ...ready(), end: '', capacity: '' };
  const m = fm({ ev });
  assert.equal(m.title, 'Approved. 2 things left before Eventbrite');
  assert.deepEqual(m.links.map(l => l.field), ['end', 'capacity']);
  assert.equal(m.primary.label, 'Add to Eventbrite');
  assert.equal(m.primary.enabled, false);
  assert.deepEqual(acts(m), ['delete']);
  const one = fm({ ev: { ...ready(), capacity: '' } });
  assert.equal(one.title, 'Approved. 1 thing left before Eventbrite');
});

test('footerModel approved ready', () => {
  const m = fm({});
  assert.equal(m.title, 'Ready for Eventbrite');
  assert.equal(m.primary.enabled, true);
  assert.equal(m.primary.act, 'add-eb');
  assert.deepEqual(m.links, []);
});

test('footerModel onEventbrite: publish, update draft, disabled', () => {
  const ev = { ...ready(), publicDescription: 'x' };
  const p = fm({ stage: 'onEventbrite', ev });
  assert.equal(p.title, 'On Eventbrite as a private draft');
  assert.equal(p.primary.label, 'Publish');
  assert.equal(p.primary.enabled, true);
  assert.equal(p.secondary, null);   // Preview listing lives on the listing card (R26)
  assert.match(p.sub, /Preview listing/);
  assert.deepEqual(acts(p), ['delete']);
  const d = fm({ stage: 'onEventbrite', ev, unpushed: ['start'] });
  assert.equal(d.primary.label, 'Update draft');
  assert.equal(d.primary.act, 'update-eb');
  assert.match(d.sub, /1 change isn't on Eventbrite yet/);
  const no = fm({ stage: 'onEventbrite' }); // no public description
  assert.equal(no.primary.label, 'Publish');
  assert.equal(no.primary.enabled, false);
  assert.deepEqual(no.links.map(l => l.field), ['publicDescription']);
});

test('footerModel published', () => {
  const ev = { ...ready(), publicDescription: 'x' };
  const u = fm({ stage: 'published', ev, unpushed: ['start', 'capacity'], registrants: 0 });
  assert.equal(u.title, "2 changes aren't on Eventbrite yet");
  assert.equal(u.primary.label, 'Update listing');
  assert.equal(u.primary.act, 'update-listing');
  assert.deepEqual(acts(u), ['unpublish', 'cancel']);
  const s = fm({ stage: 'published', ev, registrants: 3, capacity: 20 });
  assert.equal(s.title, 'Published · registration open · 3 of 20 registered');
  assert.equal(s.primary.label, '✓ Saved');
  assert.deepEqual(acts(s), ['cancel']); // registrants > 0: no unpublish
  assert.deepEqual(acts(fm({ stage: 'published', ev, registrants: null })), ['unpublish', 'cancel']);
});

test('footerModel published, just changed', () => {
  const m = fm({ stage: 'published', justChanged: { fields: ['start'], registrants: 4 } });
  assert.equal(m.title, 'The start time changed. Let the 4 registrants know?');
  assert.equal(m.primary.act, 'email-registrants');
  assert.equal(m.secondary.act, 'dismiss-notice');
  assert.ok(acts(m).includes('cancel'));
});

test('footerModel cancelled', () => {
  const c = fm({ stage: 'cancelled', role: COUNCIL });
  assert.equal(c.title, 'Cancelled');
  assert.equal(c.primary.act, 'reopen');
  assert.deepEqual(acts(c), ['delete']);
  assert.ok(c.steps.every(s => s.state === 'todo'));
  const l = fm({ stage: 'cancelled' });
  assert.equal(l.primary, null);
  assert.deepEqual(acts(l), []);
});

test('footerModel pending replaces primary only', () => {
  const ev = { ...ready(), publicDescription: 'x' };
  const m = fm({ stage: 'onEventbrite', ev, pending: true });
  assert.deepEqual(m.primary, { label: 'Saving…', act: null, enabled: false, tone: 'primary' });
  assert.equal(m.title, 'On Eventbrite as a private draft');
  assert.deepEqual(acts(m), ['delete']);
});

test('footerModel past: no primary, no menu, unless just changed', () => {
  for (const stage of ['published', 'onEventbrite']) {
    const m = fm({ stage, past: true });
    assert.equal(m.primary, null);
    assert.deepEqual(m.menu, []);
  }
  const j = fm({ stage: 'published', past: true, justChanged: { fields: ['date'], registrants: 2 } });
  assert.equal(j.primary.act, 'email-registrants');
  assert.deepEqual(j.menu, []);
});

test('footerModel past clears actions at every stage (R10)', () => {
  const pastEv = { ...ready(), date: '2000-01-01' };
  for (const [stage, role] of [['approved', LEAD], ['draft', LEAD], ['proposed', COUNCIL], ['cancelled', COUNCIL]]) {
    const m = fm({ stage, role, past: true, ev: pastEv });
    assert.equal(m.primary, null, stage);
    assert.equal(m.secondary, null, stage);
    assert.deepEqual(m.menu, [], stage);
    assert.deepEqual(m.links, [], stage);
  }
});

test('footerModel never offers delete and cancel together', () => {
  for (const stage of ['draft', 'proposed', 'approved', 'onEventbrite', 'published', 'cancelled'])
    for (const role of [LEAD, COUNCIL, { canEdit: false, canApprove: false }])
      for (const registrants of [null, 0, 5]) {
        const a = acts(fm({ stage, role, registrants }));
        assert.ok(!(a.includes('delete') && a.includes('cancel')), stage);
        if (stage !== 'published') assert.ok(!a.includes('cancel'), stage);
      }
});

test('changeNotice', () => {
  const ev = { title: 'Shabbat dinner', date: '2027-03-01' };
  const b = { date: '2027-03-01', start: '18:00', end: '20:00', venueName: 'Cafe A' };
  const n = R.changeNotice(b, { ...b, start: '18:30' }, ev);
  assert.deepEqual(n.fields, ['start']);
  assert.equal(n.subject, 'Update: Shabbat dinner on Mon, Mar 1');
  assert.ok(n.body.includes('Start time: 6:00 PM → 6:30 PM'));
  assert.ok(n.body.endsWith('\n\nSee you there!'));
  const v = R.changeNotice(b, { ...b, venueName: 'Cafe B' }, ev);
  assert.ok(v.body.includes('Where: Cafe A → Cafe B'));
  assert.deepEqual(R.changeNotice(b, { ...b, title: 'x' }, ev).fields, []);
});

test('footerModel sending: primary reads Sending to Eventbrite…, wins over pending', () => {
  const ev = { ...ready(), publicDescription: 'x' };
  const m = fm({ stage: 'onEventbrite', ev, sending: true, pending: true });
  assert.deepEqual(m.primary, { label: 'Sending to Eventbrite…', act: null, enabled: false, tone: 'primary' });
  assert.deepEqual(acts(m), ['delete']);
});

test('EB_CONFLICT_NOTICE is the footer sub text (one constant)', () => {
  assert.equal(R.EB_CONFLICT_NOTICE, 'Someone changed this listing on Eventbrite since your last update. Updating will replace their changes.');
  const ev = { ...ready(), publicDescription: 'x' };
  for (const stage of ['onEventbrite', 'published']) {
    const m = fm({ stage, ev, ebEditedElsewhere: true });
    assert.ok(m.sub.endsWith(R.EB_CONFLICT_NOTICE), stage + ': ' + m.sub);
  }
});

test('footerModel legacy row (pushed null): offers the update, not compared yet', () => {
  const ev = { ...ready(), publicDescription: 'x' };
  const d = fm({ stage: 'onEventbrite', ev, pushed: null });
  assert.equal(d.primary.label, 'Update draft');
  assert.equal(d.primary.act, 'update-eb');
  assert.equal(d.primary.enabled, true);
  assert.equal(d.sub, 'Not compared with Eventbrite yet');
  assert.equal(d.secondary, null);
  const p = fm({ stage: 'published', ev, pushed: null, registrants: 2, capacity: 20 });
  assert.equal(p.primary.label, 'Update listing');
  assert.equal(p.primary.act, 'update-listing');
  assert.equal(p.primary.enabled, true);
  assert.equal(p.title, 'Published · registration open · 2 of 20 registered');
  assert.equal(p.sub, 'Not compared with Eventbrite yet');
  // a known snapshot with nothing changed keeps Publish / ✓ Saved
  assert.equal(fm({ stage: 'onEventbrite', ev, pushed: {} }).primary.label, 'Publish');
  assert.equal(fm({ stage: 'published', ev, pushed: {} }).primary.label, '✓ Saved');
  // not for someone who can't edit, nor once the event is past
  assert.equal(fm({ stage: 'published', ev, pushed: null, role: { canEdit: false } }).primary, null);
  assert.equal(fm({ stage: 'published', ev, pushed: null, past: true }).primary, null);
});

test('footerModel published: Cancel event… says it takes the listing down', () => {
  const m = fm({ stage: 'published', ev: { ...ready(), publicDescription: 'x' }, registrants: 0 });
  const c = m.menu.find(x => x.act === 'cancel');
  assert.equal(c.label, 'Cancel event…');
  assert.equal(c.sub, 'Takes the listing down. Not possible once people register.');
});

test('footerModel slow pending: Still saving… with the Coda-is-slow tip (R21)', () => {
  const ev = { ...ready(), publicDescription: 'x' };
  const m = fm({ stage: 'onEventbrite', ev, pending: true, slow: true });
  assert.deepEqual(m.primary, { label: 'Still saving…', act: null, enabled: false, tone: 'primary',
    tip: 'Coda is slow right now; your change is safe' });
  // not pending: slow means nothing
  assert.equal(fm({ stage: 'onEventbrite', ev, slow: true }).primary.act, 'publish-eb');
  // sending wins
  assert.equal(fm({ stage: 'onEventbrite', ev, sending: true, pending: true, slow: true }).primary.label, 'Sending to Eventbrite…');
});

test('footerModel busy (a transition/cancel/delete in flight) holds the primary even when the stage has none', () => {
  // A lead's cancelled event has no primary; a cancel in flight still shows in the button.
  const c = fm({ stage: 'cancelled', role: LEAD, busy: 'Cancelling…' });
  assert.deepEqual(c.primary, { label: 'Cancelling…', act: null, enabled: false, tone: 'primary' });
  // busy: true reads Saving…, and goes slow like pending does
  const p = fm({ stage: 'proposed', role: COUNCIL, busy: true });
  assert.equal(p.primary.label, 'Saving…');
  assert.equal(fm({ stage: 'proposed', role: COUNCIL, busy: true, slow: true }).primary.label, 'Still saving…');
  // a named busy label never turns into Still saving…
  assert.equal(fm({ stage: 'draft', busy: 'Deleting…', slow: true }).primary.label, 'Deleting…');
  // read-only viewers see nothing in flight
  assert.equal(fm({ stage: 'draft', role: { canEdit: false, canApprove: false }, busy: true }).primary, null);
});

test('footerModel busy marks the footer busy (secondary and ⋮ get disabled); idle and sending-only do not', () => {
  const ev = { ...ready(), publicDescription: 'x' };
  const b = fm({ stage: 'onEventbrite', ev, busy: 'Deleting…' });
  assert.equal(b.busy, true);
  assert.equal(b.secondary, null);   // no footer secondary at any stage (R26)
  assert.deepEqual(acts(b), ['delete']);
  assert.equal(fm({ stage: 'onEventbrite', ev }).busy, false);
  assert.equal(fm({ stage: 'onEventbrite', ev, pending: true }).busy, false);
  assert.equal(fm({ stage: 'draft', role: { canEdit: false, canApprove: false }, busy: true }).busy, false);
});

test('Capacity reads as Free tickets (R29)', () => {
  assert.equal(R.FIELDS.capacity.label, 'Free tickets');
  const m = fm({ stage: 'published', ev: { ...ready(), publicDescription: 'x' }, unpushed: ['capacity'] });
  assert.match(m.sub, /Not on Eventbrite yet: Free tickets\./);
});

test('footerModel: Preview listing is never a footer secondary (R26)', () => {
  const ev = { ...ready(), publicDescription: 'x' };
  for (const stage of ['draft', 'proposed', 'approved', 'onEventbrite', 'published', 'cancelled'])
    for (const pushed of [{}, null]) assert.equal(fm({ stage, ev, pushed }).secondary, null, stage);
});

// ---- footerModel checklist (Task 8) ----
const LABELS = ['Title', 'Date and times', 'Free tickets', 'Venue and address', 'Description'];
const cl = (stage, ev) => R.footerModel({ stage, past: false, role: LEAD, unpushed: [],
  checks: R.readiness(ev, { todayISO: TODAY }) }).checklist;

test('footerModel checklist is empty before approval and after cancel', () => {
  for (const stage of ['draft', 'proposed', 'cancelled']) assert.deepEqual(cl(stage, ready()), []);
});

test('footerModel checklist names the first failing date check; no description row before Eventbrite', () => {
  const rows = cl('approved', { ...ready(), end: '' });
  const date = rows.find(r => r.key === 'date');
  assert.equal(date.ok, false);
  assert.equal(date.field, 'end');
  assert.equal(date.message, 'Add an end time');
  assert.equal(rows.find(r => r.key === 'publicDescription'), undefined);
  assert.ok(rows.every(r => LABELS.includes(r.label)));
});

test('footerModel checklist adds Description on Eventbrite and all-pass rows are ok', () => {
  const rows = cl('onEventbrite', { ...ready(), publicDescription: 'Come eat' });
  assert.ok(rows.find(r => r.key === 'publicDescription'));
  assert.deepEqual(rows.map(r => r.label), LABELS);
  assert.ok(rows.every(r => r.ok && r.message === ''));
  const bad = cl('published', ready()).find(r => r.key === 'publicDescription');
  assert.equal(bad.ok, false);
  assert.equal(bad.field, 'publicDescription');
});

test('footerModel checklist follows what the primary is gated on, not just the stage', () => {
  // On Eventbrite with unpushed edits: the primary is Update draft, gated on the add
  // checks, so a missing public description is no ✗ row (and no link).
  const ev = ready();   // no public description
  const upd = fm({ stage: 'onEventbrite', ev, unpushed: ['title'] });
  assert.equal(upd.primary.act, 'update-eb');
  assert.equal(upd.primary.enabled, true);
  assert.equal(upd.checklist.find(r => r.key === 'publicDescription'), undefined);
  assert.ok(upd.checklist.every(r => r.ok));
  assert.deepEqual(upd.links, []);
  // No unpushed edits: the primary is Publish, gated on the publish checks.
  const pubm = fm({ stage: 'onEventbrite', ev });
  assert.equal(pubm.primary.act, 'publish-eb');
  const row = pubm.checklist.find(r => r.key === 'publicDescription');
  assert.equal(row.ok, false);
  assert.deepEqual(pubm.links.map(l => l.field), ['publicDescription']);
  // Published with unpushed edits: Update listing is gated on the publish checks.
  const ul = fm({ stage: 'published', ev, unpushed: ['title'] });
  assert.equal(ul.primary.act, 'update-listing');
  assert.equal(ul.checklist.find(r => r.key === 'publicDescription').ok, false);
});

test('footerModel checklist is empty for a past event (nothing left to do, R10)', () => {
  const m = R.footerModel({ stage: 'approved', past: true, role: LEAD, unpushed: [],
    checks: R.readiness({ ...ready(), end: '' }, { todayISO: TODAY }) });
  assert.deepEqual(m.checklist, []);
  assert.deepEqual(m.links, []);
});

test('footerModel checklist is empty while the registrant-email offer shows', () => {
  for (const stage of ['published', 'onEventbrite']) {
    const ev = ready();   // no public description: the publish list has a failing row
    assert.ok(fm({ stage, ev }).checklist.length > 0, stage);
    const m = fm({ stage, ev, justChanged: { fields: ['date'], registrants: 3 } });
    assert.equal(m.primary.act, 'email-registrants', stage);
    assert.deepEqual(m.checklist, [], stage);
  }
});

test('footerModel copy names the panel, not the footer or the title', () => {
  const subs = [
    R.footerModel({ stage: 'proposed', past: false, role: LEAD, unpushed: [], checks: R.readiness(ready(), { todayISO: TODAY }) }).sub,
    R.footerModel({ stage: 'onEventbrite', past: false, role: LEAD, unpushed: [], pushed: {}, checks: R.readiness(ready(), { todayISO: TODAY }) }).sub,
  ];
  for (const s of subs) assert.ok(!/footer|above the title/i.test(s), s);
});
