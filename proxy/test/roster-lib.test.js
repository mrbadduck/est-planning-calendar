// web/roster-lib.js is a plain browser script that attaches `RosterLib` to
// globalThis — importing it for side effects makes it testable under node too.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../../web/roster-lib.js';

const L = globalThis.RosterLib;
const rows = [
  { key: 'order:1', kind: 'order', email: 'a@x.com', member: true, claims: [{ slotId: 's1', label: 'Dessert', kind: 'Potluck' }] },
  { key: 'order:2', kind: 'order', email: 'B@X.com', member: false, claims: [] },
  { key: 'order:3', kind: 'order', email: '', member: false, claims: [] },
  { key: 'person:p9', kind: 'claimant', email: 'c@x.com', member: false, claims: [{ slotId: 's2', label: 'Setup', kind: 'Volunteer' }, { slotId: 's1', label: 'Dessert', kind: 'Potluck' }] },
];

test('segmentsFor: the fixed segments plus one per distinct slot seen in claims (first-seen order)', () => {
  const segs = L.segmentsFor(rows);
  assert.deepEqual(segs.map((s) => s.id), ['all', 'registered', 'unregisteredClaimants', 'registeredNoClaim', 'members', 'nonMembers', 'slot:s1', 'slot:s2']);
  assert.equal(segs.find((s) => s.id === 'slot:s2').label, 'Setup');
});

test('applySegment filters by predicate; unknown id falls back to All', () => {
  const segs = L.segmentsFor(rows);
  const keys = (id) => L.applySegment(rows, segs, id).map((r) => r.key);
  assert.deepEqual(keys('all'), ['order:1', 'order:2', 'order:3', 'person:p9']);
  assert.deepEqual(keys('registered'), ['order:1', 'order:2', 'order:3']);
  assert.deepEqual(keys('unregisteredClaimants'), ['person:p9']);
  assert.deepEqual(keys('registeredNoClaim'), ['order:2', 'order:3']);
  assert.deepEqual(keys('members'), ['order:1']);
  assert.deepEqual(keys('nonMembers'), ['order:2', 'order:3', 'person:p9']);
  assert.deepEqual(keys('slot:s1'), ['order:1', 'person:p9']);
  assert.deepEqual(keys('slot:s2'), ['person:p9']);
  assert.deepEqual(keys('nope'), keys('all'));
});

test('emailsOf: lowercased, deduped, blanks dropped', () => {
  assert.deepEqual(L.emailsOf(rows.concat([{ email: 'a@x.com' }])), ['a@x.com', 'b@x.com', 'c@x.com']);
});

test('mailtoHref: bcc list + subject, null when the link would exceed the safe length', () => {
  assert.equal(L.mailtoHref(['a@x.com', 'b@x.com'], 'Potluck!'), 'mailto:?bcc=a%40x.com,b%40x.com&subject=Potluck!');
  assert.equal(L.mailtoHref(['a@x.com'], ''), 'mailto:?bcc=a%40x.com');
  const many = Array.from({ length: 120 }, (_, i) => `person${i}@example.org`);   // ~2.9k chars
  assert.equal(L.mailtoHref(many, 'x'), null);
  assert.ok(L.MAILTO_MAX >= 1800 && L.MAILTO_MAX <= 2000);
});
