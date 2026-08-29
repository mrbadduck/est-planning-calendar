import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  slotRemaining, validateClaimInput, projectEventForMember,
  relName, relId, splitName, findPersonByEmail, personCreateCells,
  claimCreateCells, claimOwnerId, slotCells, isPublishedUpcoming,
  isApprovedUpcoming, stripRich, plain, slimPeopleRows, friendlyName, claimUpdateCells,
} from '../src/gather.js';
import { PLANNING_COLS, SLOT_COLS, CLAIM_COLS, PEOPLE_COLS } from '../src/coda-columns.js';

test('slotRemaining subtracts filled qty, never negative', () => {
  assert.equal(slotRemaining(3, [{ qty: 1 }, { qty: 1 }]), 1);
  assert.equal(slotRemaining(2, []), 2);
  assert.equal(slotRemaining(1, [{ qty: 1 }, { qty: 1 }]), 0);   // oversubscribed clamps to 0
});

test('validateClaimInput requires slot, defaults + clamps qty, trims strings', () => {
  assert.throws(() => validateClaimInput({}), /slot required/);
  assert.deepEqual(validateClaimInput({ slot: 'i-1' }), { slot: 'i-1', qty: 1, contributionDetail: '', notes: '', member: '' });
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
  assert.deepEqual(proj.slots[1].claims, [{ name: 'Leah', contribution: 'kugel', qty: 1, mine: true }]);

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

test('projectEventForMember reads a rich (object) member cell for the claimant name', () => {
  const row = { id: 'i-ev', values: { [PLANNING_COLS.title]: 'X' } };
  const slots = [{ id: 'i-s1', values: { [SLOT_COLS.label]: 'Dessert', [SLOT_COLS.neededQty]: 2, [SLOT_COLS.sortOrder]: 1 } }];
  // rich read: member relation is a { rowId, name } object, not a string
  const claimsBySlot = { 'i-s1': [{ values: { [CLAIM_COLS.member]: { rowId: 'i-p9', name: 'Leah' }, [CLAIM_COLS.qty]: 1 } }] };
  const proj = projectEventForMember(row, slots, claimsBySlot, 'Leah', { includeClaimants: true });
  assert.equal(proj.slots[0].mineClaimed, true);
  assert.deepEqual(proj.slots[0].claims, [{ name: 'Leah', contribution: '', qty: 1, mine: true }]);
});

test('projectEventForMember prefers callerId for mine + exposes only the caller\'s own claimId', () => {
  const row = { id: 'i-ev', values: { [PLANNING_COLS.title]: 'X' } };
  const slots = [{ id: 'i-s1', values: { [SLOT_COLS.label]: 'Dessert', [SLOT_COLS.neededQty]: 3, [SLOT_COLS.sortOrder]: 1 } }];
  const claimsBySlot = { 'i-s1': [
    { id: 'i-c1', values: { [CLAIM_COLS.member]: { rowId: 'i-me', name: 'Leah' }, [CLAIM_COLS.qty]: 1 } },
    { id: 'i-c2', values: { [CLAIM_COLS.member]: { rowId: 'i-other', name: 'Leah' }, [CLAIM_COLS.qty]: 1 } },  // same NAME, different person
  ] };
  const proj = projectEventForMember(row, slots, claimsBySlot, 'Leah', { includeClaimants: true, callerId: 'i-me' });
  const [c1, c2] = proj.slots[0].claims;
  assert.equal(c1.mine, true);   assert.equal(c1.claimId, 'i-c1');
  assert.equal(c2.mine, false);  assert.equal('claimId' in c2, false);   // name collides, but id doesn't -> not mine, no id leaked
  assert.equal(proj.slots[0].mineClaimed, true);
});

test('relName / relId coerce simpleWithArrays strings and rich objects', () => {
  assert.equal(relName('Leah'), 'Leah');
  assert.equal(relName(['Leah', 'Dana']), 'Leah');
  assert.equal(relName({ rowId: 'i-1', name: 'Leah' }), 'Leah');
  assert.equal(relName([{ rowId: 'i-1', name: 'Leah' }]), 'Leah');
  assert.equal(relName(null), '');
  // relId only trusts a rich object — a bare name string yields null (never a false match)
  assert.equal(relId({ rowId: 'i-1', name: 'Leah' }), 'i-1');
  assert.equal(relId([{ rowId: 'i-7' }]), 'i-7');
  assert.equal(relId('Leah'), null);
  assert.equal(relId(null), null);
});

test('splitName splits first token from the rest', () => {
  assert.deepEqual(splitName('Leah Cohen'), { first: 'Leah', last: 'Cohen' });
  assert.deepEqual(splitName('Sarah Beth Levy'), { first: 'Sarah', last: 'Beth Levy' });
  assert.deepEqual(splitName('Cher'), { first: 'Cher', last: '' });
  assert.deepEqual(splitName('   '), { first: '', last: '' });
});

test('findPersonByEmail matches against All Emails, case-insensitively', () => {
  const rows = [
    { id: 'i-a', values: { [PEOPLE_COLS.allEmails]: ['leah@example.org', 'leah2@x.com'] } },
    { id: 'i-b', values: { [PEOPLE_COLS.allEmails]: 'dana@example.org' } },
    { id: 'i-c', values: { [PEOPLE_COLS.allEmails]: '' } },
  ];
  assert.equal(findPersonByEmail(rows, 'LEAH2@x.com', PEOPLE_COLS).id, 'i-a');
  assert.equal(findPersonByEmail(rows, 'dana@example.org', PEOPLE_COLS).id, 'i-b');
  assert.equal(findPersonByEmail(rows, 'nobody@x.com', PEOPLE_COLS), null);
});

test('slimPeopleRows keeps only the auth/picker columns, same row shape', () => {
  const rows = [
    { id: 'i-a', values: {
      [PEOPLE_COLS.fullName]: 'Leah Cohen',
      [PEOPLE_COLS.firstName]: 'Leah',
      [PEOPLE_COLS.lastName]: 'Cohen',
      [PEOPLE_COLS.allEmails]: ['leah@x.com'],
      [PEOPLE_COLS.leadershipStatus]: ['Tribal Council'],
      'c-something-huge': 'FIFTY OTHER COLUMNS OF PAYLOAD',
    } },
    { id: 'i-b', values: {} },   // sparse row -> safe defaults
  ];
  const slim = slimPeopleRows(rows, PEOPLE_COLS);
  assert.deepEqual(slim[0], { id: 'i-a', values: {
    [PEOPLE_COLS.fullName]: 'Leah Cohen',
    [PEOPLE_COLS.firstName]: 'Leah',
    [PEOPLE_COLS.lastName]: 'Cohen',
    [PEOPLE_COLS.allEmails]: ['leah@x.com'],
    [PEOPLE_COLS.leadershipStatus]: ['Tribal Council'],
  } });
  assert.deepEqual(slim[1], { id: 'i-b', values: { [PEOPLE_COLS.fullName]: '', [PEOPLE_COLS.firstName]: '', [PEOPLE_COLS.lastName]: '', [PEOPLE_COLS.allEmails]: [], [PEOPLE_COLS.leadershipStatus]: [] } });
  assert.ok(!JSON.stringify(slim).includes('FIFTY OTHER'));
  // the slim shape still feeds the existing matcher unchanged
  assert.equal(findPersonByEmail(slim, 'LEAH@x.com', PEOPLE_COLS).id, 'i-a');
});

test('friendlyName: member-safe display forms', () => {
  assert.equal(friendlyName('Leah', 'Cohen', 'Leah Cohen'), 'Leah C.');
  assert.equal(friendlyName('Leah', '', 'whatever'), 'Leah');                       // first only
  assert.equal(friendlyName('', '', 'Sarah Beth Levy'), 'Sarah L.');                // split spaced full name
  assert.equal(friendlyName('', '', 'leah@example.org'), 'Anonymous Neighbor');     // email in Full Name
  assert.equal(friendlyName('', '', 'Cher'), 'Anonymous Neighbor');                 // single token
  assert.equal(friendlyName('', '', ''), 'Anonymous Neighbor');                     // all blank
  assert.equal(friendlyName(null, undefined, null), 'Anonymous Neighbor');
});

test('projectEventForMember applies nameOf to claimant names (raw name still drives mine)', () => {
  const row = { id: 'i-ev', values: { [PLANNING_COLS.title]: 'X' } };
  const slots = [{ id: 'i-s1', values: { [SLOT_COLS.label]: 'Dessert', [SLOT_COLS.neededQty]: 2, [SLOT_COLS.sortOrder]: 1 } }];
  const claimsBySlot = { 'i-s1': [{ id: 'i-c1', values: { [CLAIM_COLS.member]: { rowId: 'i-p9', name: 'Leah Cohen' }, [CLAIM_COLS.qty]: 1 } }] };
  const nameOf = (pid, fallback) => (pid === 'i-p9' ? 'Leah C.' : fallback);
  // name-fallback mine matching (no callerId) compares the RAW name, then displays the safe one
  const proj = projectEventForMember(row, slots, claimsBySlot, 'Leah Cohen', { includeClaimants: true, nameOf });
  assert.equal(proj.slots[0].claims[0].name, 'Leah C.');
  assert.equal(proj.slots[0].claims[0].mine, true);
});

test('validateClaimInput passes member through for the lead path; claimUpdateCells clamps', () => {
  assert.equal(validateClaimInput({ slot: 'i-1' }).member, '');
  assert.equal(validateClaimInput({ slot: 'i-1', member: 'i-p7' }).member, 'i-p7');
  assert.equal(validateClaimInput({ slot: 'i-1', member: 42 }).member, '');         // non-string ignored
  const cells = claimUpdateCells({ qty: 100, contributionDetail: '  kugel ' }, CLAIM_COLS);
  const byCol = Object.fromEntries(cells.map((c) => [c.column, c.value]));
  assert.equal(byCol[CLAIM_COLS.qty], 20);
  assert.equal(byCol[CLAIM_COLS.contributionDetail], 'kugel');
  const cleared = Object.fromEntries(claimUpdateCells({}, CLAIM_COLS).map((c) => [c.column, c.value]));
  assert.equal(cleared[CLAIM_COLS.qty], 1);
  assert.equal(cleared[CLAIM_COLS.contributionDetail], '');                          // empty clears
});

test('personCreateCells builds a self-onboarded row (writable cols + Notes marker)', () => {
  const cells = personCreateCells('New@Person.org', 'New Person', PEOPLE_COLS, '2026-08-24T00:00:00Z');
  const byCol = Object.fromEntries(cells.map((c) => [c.column, c.value]));
  assert.equal(byCol[PEOPLE_COLS.fullName], 'New Person');
  assert.equal(byCol[PEOPLE_COLS.firstName], 'New');
  assert.equal(byCol[PEOPLE_COLS.lastName], 'Person');
  assert.equal(byCol[PEOPLE_COLS.emailManual], 'new@person.org');       // lowercased so All Emails matches later
  assert.match(byCol[PEOPLE_COLS.notes], /Self-onboarded via gather 2026-08-24/);
});

test('claimCreateCells writes relations as row ids, omits empty optionals', () => {
  const cells = claimCreateCells({ slot: 'i-s1', qty: 2, contributionDetail: '', notes: '' }, 'i-p1', CLAIM_COLS);
  const byCol = Object.fromEntries(cells.map((c) => [c.column, c.value]));
  assert.deepEqual(byCol[CLAIM_COLS.slot], ['i-s1']);
  assert.deepEqual(byCol[CLAIM_COLS.member], ['i-p1']);
  assert.equal(byCol[CLAIM_COLS.qty], 2);
  assert.equal(CLAIM_COLS.contributionDetail in byCol, false);
  const cells2 = claimCreateCells({ slot: 'i-s1', qty: 1, contributionDetail: 'kugel', notes: 'warm' }, 'i-p1', CLAIM_COLS);
  const byCol2 = Object.fromEntries(cells2.map((c) => [c.column, c.value]));
  assert.equal(byCol2[CLAIM_COLS.contributionDetail], 'kugel');
  assert.equal(byCol2[CLAIM_COLS.notes], 'warm');
});

test('claimOwnerId reads the member row id from a rich claim row only', () => {
  assert.equal(claimOwnerId({ values: { [CLAIM_COLS.member]: { rowId: 'i-p1', name: 'Leah' } } }, CLAIM_COLS), 'i-p1');
  assert.equal(claimOwnerId({ values: { [CLAIM_COLS.member]: [{ rowId: 'i-p2' }] } }, CLAIM_COLS), 'i-p2');
  // a name-only cell (row read WITHOUT rich relations) must NOT resolve an owner
  assert.equal(claimOwnerId({ values: { [CLAIM_COLS.member]: 'Leah' } }, CLAIM_COLS), null);
});

test('slotCells writes the Event relation only on create, only provided fields', () => {
  const create = slotCells({ event: 'i-ev', kind: 'Potluck', label: 'Dessert', neededQty: 3, sortOrder: 1 }, SLOT_COLS, { withEvent: true });
  const c = Object.fromEntries(create.map((x) => [x.column, x.value]));
  assert.deepEqual(c[SLOT_COLS.event], ['i-ev']);
  assert.equal(c[SLOT_COLS.kind], 'Potluck');
  assert.equal(c[SLOT_COLS.neededQty], 3);
  const update = slotCells({ event: 'i-ev', label: 'Setup' }, SLOT_COLS);   // no withEvent -> no Event cell
  const u = Object.fromEntries(update.map((x) => [x.column, x.value]));
  assert.equal(SLOT_COLS.event in u, false);
  assert.equal(u[SLOT_COLS.label], 'Setup');
});

test('stripRich unwraps rich-format markdown text (fences + escapes)', () => {
  // Coda valueFormat=rich fences text values in ``` and backslash-escapes markdown
  assert.equal(stripRich('```Main dish```'), 'Main dish');
  assert.equal(stripRich('```Potluck```'), 'Potluck');
  assert.equal(stripRich('Setup 5\\-6pm'), 'Setup 5-6pm');
  assert.equal(stripRich('```multi\nline```'), 'multi\nline');
  assert.equal(stripRich('plain'), 'plain');                       // untouched
  assert.equal(stripRich(true), true);                             // non-strings pass through
  assert.equal(stripRich(3), 3);
});

test('plain / relName strip the rich-format fencing from strings and object names', () => {
  assert.equal(plain('```PJ Library Musical Shabbat```'), 'PJ Library Musical Shabbat');
  assert.equal(plain({ name: '```Potluck```' }), 'Potluck');
  assert.equal(plain(['```Dessert```']), 'Dessert');
  assert.equal(plain(true), true);                                 // booleans untouched (Published?)
  assert.equal(relName({ rowId: 'i-1', name: '```Leah Cohen```' }), 'Leah Cohen');
});

test('projectEventForMember: preview flag set only when asked', () => {
  const row = { id: 'i-ev', values: { [PLANNING_COLS.title]: 'X' } };
  assert.equal(projectEventForMember(row, [], {}, '').preview, undefined);
  assert.equal(projectEventForMember(row, [], {}, '', { preview: true }).preview, true);
});

test('isApprovedUpcoming gates on Status=Approved AND effective date', () => {
  const mk = (v) => ({ values: v });
  const today = '2026-08-24';
  // approved + future -> preview-eligible (rich reads fence the select value)
  assert.equal(isApprovedUpcoming(mk({ [PLANNING_COLS.status]: '```Approved```', [PLANNING_COLS.date]: '2026-09-01' }), PLANNING_COLS, today), true);
  assert.equal(isApprovedUpcoming(mk({ [PLANNING_COLS.status]: 'Approved', [PLANNING_COLS.date]: '2026-09-01' }), PLANNING_COLS, today), true);
  // not approved -> never, regardless of date
  assert.equal(isApprovedUpcoming(mk({ [PLANNING_COLS.status]: 'Proposed', [PLANNING_COLS.date]: '2027-01-01' }), PLANNING_COLS, today), false);
  assert.equal(isApprovedUpcoming(mk({ [PLANNING_COLS.status]: 'Cancelled', [PLANNING_COLS.date]: '2027-01-01' }), PLANNING_COLS, today), false);
  assert.equal(isApprovedUpcoming(mk({}), PLANNING_COLS, today), false);
  // approved + past -> hidden; undated -> shown
  assert.equal(isApprovedUpcoming(mk({ [PLANNING_COLS.status]: 'Approved', [PLANNING_COLS.date]: '2026-08-01' }), PLANNING_COLS, today), false);
  assert.equal(isApprovedUpcoming(mk({ [PLANNING_COLS.status]: 'Approved' }), PLANNING_COLS, today), true);
});

test('isPublishedUpcoming gates on Published? AND effective date', () => {
  const mk = (v) => ({ values: v });
  const today = '2026-08-24';
  // unpublished -> hidden regardless of date
  assert.equal(isPublishedUpcoming(mk({ [PLANNING_COLS.published]: false, [PLANNING_COLS.date]: '2027-01-01' }), PLANNING_COLS, today), false);
  // published + future date -> shown
  assert.equal(isPublishedUpcoming(mk({ [PLANNING_COLS.published]: true, [PLANNING_COLS.date]: '2026-09-01' }), PLANNING_COLS, today), true);
  // published + past date -> hidden
  assert.equal(isPublishedUpcoming(mk({ [PLANNING_COLS.published]: true, [PLANNING_COLS.date]: '2026-08-01' }), PLANNING_COLS, today), false);
  // published today -> shown (>=)
  assert.equal(isPublishedUpcoming(mk({ [PLANNING_COLS.published]: true, [PLANNING_COLS.date]: '2026-08-24T18:00:00' }), PLANNING_COLS, today), true);
  // published, undated -> shown; falls back to window end
  assert.equal(isPublishedUpcoming(mk({ [PLANNING_COLS.published]: true }), PLANNING_COLS, today), true);
  assert.equal(isPublishedUpcoming(mk({ [PLANNING_COLS.published]: true, [PLANNING_COLS.windowEnd]: '2026-12-01' }), PLANNING_COLS, today), true);
});

test('isPublishedUpcoming hides cancelled events even when Published? is still set', () => {
  const mk = (v) => ({ values: v });
  const today = '2026-08-24';
  // cancel tears down the EB listing but leaves Published? checked — must still hide
  assert.equal(isPublishedUpcoming(mk({ [PLANNING_COLS.published]: true, [PLANNING_COLS.status]: 'Cancelled', [PLANNING_COLS.date]: '2026-09-01' }), PLANNING_COLS, today), false);
  // rich reads fence the select value
  assert.equal(isPublishedUpcoming(mk({ [PLANNING_COLS.published]: true, [PLANNING_COLS.status]: '```Cancelled```', [PLANNING_COLS.date]: '2026-09-01' }), PLANNING_COLS, today), false);
  // any other status stays visible
  assert.equal(isPublishedUpcoming(mk({ [PLANNING_COLS.published]: true, [PLANNING_COLS.status]: 'Approved', [PLANNING_COLS.date]: '2026-09-01' }), PLANNING_COLS, today), true);
  // and a cancelled row is not preview-eligible either (no leak to leads)
  assert.equal(isApprovedUpcoming(mk({ [PLANNING_COLS.status]: 'Cancelled', [PLANNING_COLS.date]: '2026-09-01' }), PLANNING_COLS, today), false);
});
