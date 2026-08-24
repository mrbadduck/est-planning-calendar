import { test } from 'node:test';
import assert from 'node:assert/strict';
import { slotRemaining, validateClaimInput, projectEventForMember } from '../src/gather.js';
import { PLANNING_COLS, SLOT_COLS, CLAIM_COLS } from '../src/coda-columns.js';

test('slotRemaining subtracts filled qty, never negative', () => {
  assert.equal(slotRemaining(3, [{ qty: 1 }, { qty: 1 }]), 1);
  assert.equal(slotRemaining(2, []), 2);
  assert.equal(slotRemaining(1, [{ qty: 1 }, { qty: 1 }]), 0);   // oversubscribed clamps to 0
});

test('validateClaimInput requires slot, defaults + clamps qty, trims strings', () => {
  assert.throws(() => validateClaimInput({}), /slot required/);
  assert.deepEqual(validateClaimInput({ slot: 'i-1' }), { slot: 'i-1', qty: 1, contributionDetail: '', notes: '' });
  assert.equal(validateClaimInput({ slot: 'i-1', qty: '3' }).qty, 3);
  assert.equal(validateClaimInput({ slot: 'i-1', qty: 0 }).qty, 1);
  assert.equal(validateClaimInput({ slot: 'i-1', qty: 100 }).qty, 20);
  assert.equal(validateClaimInput({ slot: 'i-1', contributionDetail: '  kugel  ' }).contributionDetail, 'kugel');
});

test('projectEventForMember returns only public fields', () => {
  const row = { id: 'i-ev', values: {
    [PLANNING_COLS.title]: 'Potluck', [PLANNING_COLS.scheduling]: 'Exact', [PLANNING_COLS.date]: '2026-09-01',
    [PLANNING_COLS.publicSummary]: 'Come eat', [PLANNING_COLS.publicDescription]: 'Bring a dish',
    [PLANNING_COLS.venue]: 'JCC', [PLANNING_COLS.eventbriteUrl]: 'https://eventbrite/e/1',
    // internal fields that must NOT leak:
    'c-spB8boMm3y': 'SECRETNOTES', // Planning Notes
    'c-ZJO5Ge_PyI': 'INTERNALCOPY', // Event Description
    'c-ueS3RrH9ie': 'Someone', // Created by
    'c-FLp0tKwJg6': 'Council', // Approved by
  } };
  const slots = [
    { id: 'i-s1', values: { [SLOT_COLS.label]: 'Dessert', [SLOT_COLS.kind]: 'Potluck', [SLOT_COLS.neededQty]: 3, [SLOT_COLS.sortOrder]: 2 } },
    { id: 'i-s2', values: { [SLOT_COLS.label]: 'Setup', [SLOT_COLS.kind]: 'Volunteer', [SLOT_COLS.neededQty]: 2, [SLOT_COLS.sortOrder]: 1 } },
  ];
  const claimsBySlot = { 'i-s1': [{ values: { [CLAIM_COLS.member]: 'Leah', [CLAIM_COLS.contributionDetail]: 'kugel', [CLAIM_COLS.qty]: 1 } }] };
  const proj = projectEventForMember(row, slots, claimsBySlot, 'Leah', { includeClaimants: true });

  assert.equal(proj.title, 'Potluck');
  assert.equal(proj.summary, 'Come eat');
  assert.equal(proj.eventbriteUrl, 'https://eventbrite/e/1');
  assert.equal(proj.location, 'JCC');
  // slots sorted by sortOrder; remaining + mineClaimed computed:
  assert.equal(proj.slots[0].label, 'Setup');                 // sortOrder 1 first
  assert.equal(proj.slots[1].label, 'Dessert');
  assert.equal(proj.slots[1].remaining, 2);                    // needed 3 - 1 claimed
  assert.equal(proj.slots[1].mineClaimed, true);
  assert.deepEqual(proj.slots[1].claims, [{ name: 'Leah', contribution: 'kugel', qty: 1 }]);

  // SECURITY: no internal field content anywhere in the output.
  const blob = JSON.stringify(proj);
  for (const leak of ['SECRETNOTES', 'INTERNALCOPY', 'Someone', 'Council']) {
    assert.ok(!blob.includes(leak), `leaked internal field: ${leak}`);
  }
});

test('projectEventForMember omits claimants unless requested (list view)', () => {
  const row = { id: 'i-ev', values: { [PLANNING_COLS.title]: 'X' } };
  const slots = [{ id: 'i-s1', values: { [SLOT_COLS.label]: 'Dessert', [SLOT_COLS.neededQty]: 1, [SLOT_COLS.sortOrder]: 1 } }];
  const claimsBySlot = { 'i-s1': [{ values: { [CLAIM_COLS.member]: 'Leah', [CLAIM_COLS.qty]: 1 } }] };
  const proj = projectEventForMember(row, slots, claimsBySlot, 'Dana');   // caller Dana, not the claimant
  assert.equal(proj.slots[0].mineClaimed, false);
  assert.equal(proj.slots[0].remaining, 0);
  assert.equal('claims' in proj.slots[0], false);              // no claimant names in list view
});
