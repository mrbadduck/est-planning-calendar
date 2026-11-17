import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planRow, renderTable, cellsFor } from '../../scripts/backfill-venue-address.mjs';
import { VENUE_COLS as C } from '../src/coda-columns.js';

const row = (address, extra = {}) => ({ id: 'i-1', values: { [C.name]: 'V', [C.address]: address, ...extra } });

test('a full address maps to the five fields', () => {
  const p = planRow(row('1115 Delmas Ave, Nashville, TN 37216'));
  assert.equal(p.status, 'OK');
  assert.deepEqual(p.fields, { street: '1115 Delmas Ave', unit: '', city: 'Nashville', state: 'TN', zip: '37216' });
});

test('rows with Street already filled are skipped', () => {
  assert.equal(planRow(row('1 A St, Nashville, TN', { [C.street]: '1 A St' })).status, 'SKIP');
});

test('flags: blank, non-address words, no city/state, invalid', () => {
  assert.equal(planRow(row('')).status, 'FLAG');
  assert.equal(planRow(row('TBD')).status, 'FLAG');
  assert.equal(planRow(row('Online via Zoom')).status, 'FLAG');
  assert.equal(planRow(row('https://example.com/x')).status, 'FLAG');
  assert.match(planRow(row('Somewhere Nice')).reason, /no city\/state/);
});

test('cellsFor writes only the five fields; table has a summary line', () => {
  const p = planRow(row('1115 Delmas Ave, Nashville, TN 37216'));
  assert.deepEqual(cellsFor(p.fields).map(c => c.column), [C.street, C.unit, C.city, C.state, C.zip]);
  assert.match(renderTable([p, planRow(row(''))]), /1 OK, 1 flagged, 0 skipped/);
});

test('a trailing Apt/Unit moves into Unit; a letter after the house number does not', () => {
  const a = planRow(row('221 31st Ave N Apt 222, Nashville, TN 37203'));
  assert.equal(a.fields.street, '221 31st Ave N');
  assert.equal(a.fields.unit, 'Apt 222');
  const b = planRow(row('1709 A 5th Ave North, Nashville, TN 37208'));
  assert.equal(b.fields.street, '1709 A 5th Ave North');
  assert.equal(b.fields.unit, '');
});
