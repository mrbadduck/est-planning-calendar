import { test } from 'node:test';
import assert from 'node:assert/strict';
import { slotRemaining, validateClaimInput, projectEventForMember } from '../src/gather.js';

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
    Title: 'Potluck', Scheduling: 'Exact', Date: '2026-09-01', 'Public summary': 'Come eat',
    'Public description': 'Bring a dish', Venue: 'JCC', 'Eventbrite URL': 'https://eventbrite/e/1',
    // internal fields that must NOT leak:
    'Planning Notes': 'SECRETNOTES', 'Event Description': 'INTERNALCOPY', 'Created by': 'Someone',
    'Approved by': 'Council', 'Publish status': 'ok',
  } };
  const slots = [{ id: 'i-s1', values: { Label: 'Dessert', Kind: 'Potluck', 'Needed qty': 3, 'Sort order': 2 } },
                 { id: 'i-s2', values: { Label: 'Setup', Kind: 'Volunteer', 'Needed qty': 2, 'Sort order': 1 } }];
  const claimsBySlot = { 'i-s1': [{ values: { Member: 'Leah', 'Contribution detail': 'kugel', Qty: 1 } }] };
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
  for (const leak of ['SECRETNOTES', 'INTERNALCOPY', 'Someone', 'Council', 'Publish status', 'Planning Notes']) {
    assert.ok(!blob.includes(leak), `leaked internal field: ${leak}`);
  }
});

test('projectEventForMember omits claimants unless requested (list view)', () => {
  const row = { id: 'i-ev', values: { Title: 'X' } };
  const slots = [{ id: 'i-s1', values: { Label: 'Dessert', 'Needed qty': 1, 'Sort order': 1 } }];
  const claimsBySlot = { 'i-s1': [{ values: { Member: 'Leah', Qty: 1 } }] };
  const proj = projectEventForMember(row, slots, claimsBySlot, 'Dana');   // caller Dana, not the claimant
  assert.equal(proj.slots[0].mineClaimed, false);
  assert.equal(proj.slots[0].remaining, 0);
  assert.equal('claims' in proj.slots[0], false);              // no claimant names in list view
});
