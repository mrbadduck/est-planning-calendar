import { test } from 'node:test';
import assert from 'node:assert/strict';
import { personFacts, orderRows } from '../src/roster.js';
import { PEOPLE_COLS } from '../src/coda-columns.js';

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
