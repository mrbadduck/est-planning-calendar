import { test } from 'node:test';
import assert from 'node:assert/strict';
import { personFacts, orderRows, claimantRows, mergeRoster, rosterSummary, buildRoster } from '../src/roster.js';
import { PEOPLE_COLS, SLOT_COLS, CLAIM_COLS } from '../src/coda-columns.js';

const person = (id, name, emails, member) => ({ id, values: {
  [PEOPLE_COLS.fullName]: name, [PEOPLE_COLS.allEmails]: emails, [PEOPLE_COLS.activeMember]: member,
} });

test('personFacts: id, name, first email (lowercased), member flag; null row -> empty facts', () => {
  assert.deepEqual(personFacts(person('i-a', 'Dana Levy', ['Dana@X.com', 'd2@x.com'], true), PEOPLE_COLS),
    { personId: 'i-a', name: 'Dana Levy', email: 'dana@x.com', member: true });
  assert.deepEqual(personFacts(person('i-b', 'No Mail', [], 'true'), PEOPLE_COLS),
    { personId: 'i-b', name: 'No Mail', email: '', member: true });
  assert.deepEqual(personFacts(null, PEOPLE_COLS), { personId: null, name: '', email: '', member: false });
});

test('orderRows: one row per active order, tickets rolled up by class, email lowercased', () => {
  const rows = orderRows([
    { id: '101', name: 'Dana Levy', email: 'Dana@X.com', status: 'placed', attendees: [
      { ticket_class_name: 'General Admission', quantity: 1 },
      { ticket_class_name: 'General Admission', quantity: 1 },
      { ticket_class_name: 'Kids', quantity: 1 },
      { ticket_class_name: 'Kids', quantity: 1, cancelled: true },   // excluded
    ] },
  ]);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], {
    key: 'order:101', kind: 'order', orderId: '101', name: 'Dana Levy', email: 'dana@x.com', orderStatus: 'placed',
    tickets: [{ class: 'General Admission', qty: 2 }, { class: 'Kids', qty: 1 }],
    claims: [], personId: null, matched: false, member: false,
  });
});

test('orderRows: skips cancelled/refunded orders; falls back to first+last name; blank email stays blank', () => {
  const rows = orderRows([
    { id: '1', name: 'Gone', email: 'g@x.com', status: 'cancelled', attendees: [] },
    { id: '2', name: 'Money Back', email: 'm@x.com', status: 'refunded', attendees: [] },
    { id: '3', first_name: 'At The', last_name: 'Door', email: '', status: 'placed', attendees: [{ ticket_class_name: 'GA' }] },
    null,
  ]);
  assert.deepEqual(rows.map((r) => r.orderId), ['3']);
  assert.equal(rows[0].name, 'At The Door');
  assert.equal(rows[0].email, '');
  assert.deepEqual(rows[0].tickets, [{ class: 'GA', qty: 1 }]);   // missing quantity counts as 1
});

const slot = (id, kind, label) => ({ id, values: { [SLOT_COLS.kind]: kind, [SLOT_COLS.label]: label } });
const claim = (memberId, memberName, contribution, qty) => ({ id: 'i-c' + Math.random(), values: {
  [CLAIM_COLS.member]: { rowId: memberId, name: memberName }, [CLAIM_COLS.contributionDetail]: contribution, [CLAIM_COLS.qty]: qty,
} });

test('claimantRows: one row per distinct claimant person, claims grouped, person facts from People', () => {
  const slots = [slot('i-s1', 'Potluck', 'Dessert'), slot('i-s2', 'Volunteer', 'Setup')];
  const claimsBySlot = {
    'i-s1': [claim('i-p1', 'Dana Levy', 'kugel', 1), claim('i-p2', 'Ari Gold', 'cookies', 2)],
    'i-s2': [claim('i-p1', 'Dana Levy', '', 1)],
  };
  const people = [person('i-p1', 'Dana Levy', ['dana@x.com'], true)];   // i-p2 has no People row -> unmatched
  const rows = claimantRows(slots, claimsBySlot, people, PEOPLE_COLS);
  assert.equal(rows.length, 2);
  const dana = rows.find((r) => r.personId === 'i-p1');
  assert.deepEqual(dana, {
    key: 'person:i-p1', kind: 'claimant', orderId: null, name: 'Dana Levy', email: 'dana@x.com', orderStatus: null,
    tickets: [], personId: 'i-p1', matched: true, member: true,
    claims: [
      { slotId: 'i-s1', kind: 'Potluck', label: 'Dessert', contribution: 'kugel', qty: 1 },
      { slotId: 'i-s2', kind: 'Volunteer', label: 'Setup', contribution: '', qty: 1 },
    ],
  });
  const ari = rows.find((r) => r.personId === 'i-p2');
  assert.equal(ari.name, 'Ari Gold');       // falls back to the relation's display name
  assert.equal(ari.email, '');
  assert.equal(ari.matched, false);
  assert.equal(ari.member, false);
  assert.equal(ari.claims[0].qty, 2);
});

test('claimantRows: a claim with no member relation id is skipped; no slots -> []', () => {
  const rows = claimantRows([slot('i-s1', 'Potluck', 'Dessert')], { 'i-s1': [{ values: { [CLAIM_COLS.member]: 'Name Only' } }] }, [], PEOPLE_COLS);
  assert.deepEqual(rows, []);
  assert.deepEqual(claimantRows([], {}, [], PEOPLE_COLS), []);
});

test('mergeRoster: orders resolve to people by email; a claimant matching by personId or email merges in; leftovers append', () => {
  const people = [
    person('i-p1', 'Dana Levy', ['dana@x.com', 'dana-alt@x.com'], true),
    person('i-p2', 'Ari Gold', ['ari@x.com'], false),
    person('i-p3', 'Noa Peretz', ['noa@x.com'], false),
  ];
  const orders = orderRows([
    { id: '1', name: 'D. Levy', email: 'DANA-ALT@x.com', status: 'placed', attendees: [{ ticket_class_name: 'GA' }] },   // matches i-p1 via alt email
    { id: '2', name: 'Stranger', email: 'who@x.com', status: 'placed', attendees: [{ ticket_class_name: 'GA' }] },       // unmatched
    { id: '3', name: 'Ari Gold', email: 'ari@x.com', status: 'placed', attendees: [{ ticket_class_name: 'GA' }] },
  ]);
  const claimants = [
    { key: 'person:i-p1', kind: 'claimant', orderId: null, name: 'Dana Levy', email: 'dana@x.com', orderStatus: null, tickets: [], personId: 'i-p1', matched: true, member: true,
      claims: [{ slotId: 'i-s1', kind: 'Potluck', label: 'Dessert', contribution: 'kugel', qty: 1 }] },
    { key: 'person:i-p3', kind: 'claimant', orderId: null, name: 'Noa Peretz', email: 'noa@x.com', orderStatus: null, tickets: [], personId: 'i-p3', matched: true, member: false,
      claims: [{ slotId: 'i-s2', kind: 'Volunteer', label: 'Setup', contribution: '', qty: 1 }] },
  ];
  const rows = mergeRoster(orders, claimants, people, PEOPLE_COLS);
  assert.deepEqual(rows.map((r) => r.key), ['order:3', 'order:1', 'person:i-p3', 'order:2']);   // sorted by name: Ari, D. Levy, Noa, Stranger
  const dana = rows.find((r) => r.key === 'order:1');
  assert.equal(dana.name, 'D. Levy');                  // orders keep the Eventbrite name (what they typed for THIS event)
  assert.equal(dana.personId, 'i-p1');
  assert.equal(dana.matched, true);
  assert.equal(dana.member, true);
  assert.equal(dana.claims.length, 1);                 // claimant merged into the order row
  assert.ok(!rows.some((r) => r.key === 'person:i-p1'));   // ...and not duplicated
  const ari = rows.find((r) => r.key === 'order:3');
  assert.deepEqual([ari.personId, ari.matched, ari.member, ari.claims], ['i-p2', true, false, []]);
  const stranger = rows.find((r) => r.key === 'order:2');
  assert.deepEqual([stranger.personId, stranger.matched, stranger.member], [null, false, false]);
  const noa = rows.find((r) => r.key === 'person:i-p3');
  assert.equal(noa.kind, 'claimant');
});

test('mergeRoster: a claimant with no People row still merges into an order by email', () => {
  const orders = orderRows([{ id: '9', name: 'Ghost', email: 'ghost@x.com', status: 'placed', attendees: [] }]);
  const claimants = [{ key: 'person:i-zz', kind: 'claimant', orderId: null, name: 'Ghost', email: 'ghost@x.com', orderStatus: null, tickets: [], personId: 'i-zz', matched: false, member: false, claims: [{ slotId: 'i-s1', kind: 'Potluck', label: 'Salad', contribution: '', qty: 1 }] }];
  const rows = mergeRoster(orders, claimants, [], PEOPLE_COLS);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].claims.length, 1);
});

test('rosterSummary counts orders, tickets, claimants, unregistered, members, unmatched, noEmail', () => {
  const rows = [
    { kind: 'order', email: 'a@x', tickets: [{ class: 'GA', qty: 2 }], claims: [{}], matched: true, member: true },
    { kind: 'order', email: '', tickets: [{ class: 'GA', qty: 1 }], claims: [], matched: false, member: false },
    { kind: 'claimant', email: 'c@x', tickets: [], claims: [{}], matched: true, member: false },
  ];
  assert.deepEqual(rosterSummary(rows), { rows: 3, orders: 2, tickets: 3, claimants: 2, unregisteredClaimants: 1, members: 1, unmatched: 1, noEmail: 1 });
});

test('buildRoster composes orders + slots/claims + people into { rows, summary }', () => {
  const out = buildRoster({
    orders: [{ id: '1', name: 'Dana Levy', email: 'dana@x.com', status: 'placed', attendees: [{ ticket_class_name: 'GA' }] }],
    slots: [slot('i-s1', 'Potluck', 'Dessert')],
    claimsBySlot: { 'i-s1': [claim('i-p1', 'Dana Levy', 'kugel', 1)] },
    people: [person('i-p1', 'Dana Levy', ['dana@x.com'], true)],
    cols: PEOPLE_COLS,
  });
  assert.equal(out.rows.length, 1);
  assert.equal(out.rows[0].claims[0].label, 'Dessert');
  assert.equal(out.summary.orders, 1);
  assert.equal(out.summary.members, 1);
  assert.equal(out.summary.unregisteredClaimants, 0);
});
