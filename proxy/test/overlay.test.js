import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isLive, mergeRows, RELATION_COLS } from '../src/overlay.js';
import { FAIL_AFTER_MS, APPLY_MARGIN_MS } from '../src/overlay-do.js';
import { PLANNING_COLS, SLOT_COLS, CLAIM_COLS } from '../src/coda-columns.js';
import { hhmm, rowToListingEvent } from '../src/publish.js';
import { stripRich, relId, relName, plain } from '../src/gather.js';

const T = 'grid-plan';
const NOW = 1_800_000_000_000;
// A live pending entry by default (written 1 s ago).
const set = (rowId, key, value, o = {}) => ({
  tableId: T, rowId, key, keying: /^c-/.test(key) ? 'id' : 'name', value, op: 'set',
  requestId: 'mut-' + Math.random(), writtenAt: NOW - 1000, state: 'pending', ...o,
});
const row = (id, values) => ({ id, values });
const colMap = {
  nameToId: { Title: PLANNING_COLS.title, Status: PLANNING_COLS.status, 'Publish status': PLANNING_COLS.publishStatus, 'Last EB push at': PLANNING_COLS.lastEbPushAt, Leads: PLANNING_COLS.leads, Start: PLANNING_COLS.start, Venue: PLANNING_COLS.venue, 'All day': PLANNING_COLS.allDay, Capacity: PLANNING_COLS.capacity },
  idToName: {},
};
for (const [n, id] of Object.entries(colMap.nameToId)) colMap.idToName[id] = n;
const names = {
  people: { 'i-p1': 'Leah Cohen', 'i-p2': 'Dana Levy' },
  programs: { 'i-g1': 'Shabbat' },
  venues: { 'i-v1': 'Community Hall' },
  venueTypes: { 'i-t1': 'Partner' },
};
const opts = (o = {}) => ({ shape: 'name', snapshotAt: NOW, now: NOW, colMap, names, ...o });

test('isLive: pending until FAIL_AFTER_MS, applied until appliedAt + margin, failed never', () => {
  const now = NOW;
  assert.equal(isLive({ state: 'pending', writtenAt: now - 1000 }, { snapshotAt: now, now }), true);
  assert.equal(isLive({ state: 'pending', writtenAt: now - FAIL_AFTER_MS }, { snapshotAt: now, now }), false);
  assert.equal(isLive({ state: 'applied', writtenAt: now - 10_000, appliedAt: now - 5000 }, { snapshotAt: now - 6000, now }), true);
  assert.equal(isLive({ state: 'applied', writtenAt: now - 60_000, appliedAt: now - 40_000 }, { snapshotAt: now, now }), false);
  assert.equal(isLive({ state: 'failed', writtenAt: now - 1000 }, { snapshotAt: now, now }), false);
});

test('two sets on one cell: the newer writtenAt wins, whatever the order', () => {
  const rows = [row('i-1', { Title: 'Old' })];
  const newer = set('i-1', 'Title', 'Newer', { writtenAt: NOW - 1000 });
  const older = set('i-1', 'Title', 'Older', { writtenAt: NOW - 5000 });
  assert.equal(mergeRows(rows, [newer, older], opts()).rows[0].values.Title, 'Newer');
  assert.equal(mergeRows(rows, [older, newer], opts()).rows[0].values.Title, 'Newer');
});

test('an insert appears; a delete hides; an insert Coda already has is left to Coda', () => {
  const rows = [row('i-1', { Title: 'Keep' }), row('i-2', { Title: 'Gone' })];
  const ins = { ...set('i-9', 'Title', 'Brand new'), op: 'insert' };
  const del = { ...set('i-2', '', null), op: 'delete', keying: 'name' };
  const out = mergeRows(rows, [ins, del], opts());
  assert.deepEqual(out.rows.map((r) => r.id), ['i-1', 'i-9']);
  assert.equal(out.rows[1].values.Title, 'Brand new');
  const already = mergeRows([row('i-9', { Title: 'Coda copy' })], [ins], opts());
  assert.equal(already.rows[0].values.Title, 'Coda copy');
  assert.deepEqual(out.stale, []);
});

test('pendingInserts: the rows the merge added from un-applied insert entries, nothing else', () => {
  const ins = (id, o = {}) => ({ ...set(id, 'Title', 'New ' + id, o), op: 'insert' });
  const out = mergeRows([row('i-1', { Title: 'Keep' })], [ins('i-9'), ins('i-1'), set('i-1', 'Title', 'Edited')], opts());
  assert.deepEqual(out.rows.map((r) => r.id), ['i-1', 'i-9']);
  assert.deepEqual(out.pendingInserts, ['i-9'], 'an insert Coda already has is not pending');
  // Applied, still merging into an older snapshot: Coda has the row, so it isn't pending.
  const applied = mergeRows([], [ins('i-8', { state: 'applied', appliedAt: NOW - 500 })], opts());
  assert.deepEqual(applied.rows.map((r) => r.id), ['i-8']);
  assert.deepEqual(applied.pendingInserts, []);
  // An insert dropped by a later delete, or whose row couldn't be translated, isn't added, so isn't pending.
  const del = { ...set('i-7', '', null), op: 'delete', keying: 'name' };
  const gone = mergeRows([], [ins('i-7'), { ...del, writtenAt: NOW - 500 }, { ...set('i-6', 'c-unknown', 'x'), op: 'insert' }], opts());
  assert.deepEqual(gone.rows, []);
  assert.deepEqual(gone.pendingInserts, []);
  assert.deepEqual(mergeRows([row('i-1', {})], [], opts()).pendingInserts, []);
});

test('a name-keyed planning write read with shape rich is translated through colMap; an unknown key is stale', () => {
  const rows = [row('i-1', { [PLANNING_COLS.status]: '```Draft```', [PLANNING_COLS.title]: '```T```' })];
  const out = mergeRows(rows, [set('i-1', 'Status', 'Approved')], opts({ shape: 'rich' }));
  assert.equal(plain(out.rows[0].values[PLANNING_COLS.status]), 'Approved');
  assert.equal(out.rows[0].values.Status, undefined);
  const miss = mergeRows(rows, [set('i-1', 'No such column', 'v')], opts({ shape: 'rich' }));
  assert.deepEqual(miss.stale, ['i-1']);
  assert.deepEqual(miss.rows[0].values, rows[0].values);
});

test('one write with mixed keys merges both into a name-keyed read', () => {
  const rows = [row('i-1', { 'Publish status': 'Draft', 'Last EB push at': '' })];
  const out = mergeRows(rows, [
    set('i-1', 'Publish status', 'Published'),
    set('i-1', PLANNING_COLS.lastEbPushAt, '2026-11-23T10:00:00.000Z'),
  ], opts());
  assert.equal(out.rows[0].values['Publish status'], 'Published');
  assert.equal(out.rows[0].values['Last EB push at'], '2026-11-23T10:00:00.000Z');
  assert.deepEqual(out.stale, []);
});

test('relations: name shape gets display names, rich gets {rowId, name}', () => {
  const nm = mergeRows([row('i-1', { Leads: ['Someone'] })], [set('i-1', 'Leads', ['i-p1', 'i-p2'])], opts());
  assert.deepEqual(nm.rows[0].values.Leads, ['Leah Cohen', 'Dana Levy']);
  const rich = mergeRows([row('i-1', {})], [set('i-1', 'Leads', ['i-p1'])], opts({ shape: 'rich' }));
  const cell = rich.rows[0].values[PLANNING_COLS.leads];
  assert.deepEqual(cell, [{ rowId: 'i-p1', name: 'Leah Cohen' }]);
  assert.equal(relId(cell), 'i-p1');
  assert.equal(relName(cell), 'Leah Cohen');
  // An id-keyed claim member (gather writes by id) on a rich claims read.
  const claim = mergeRows([], [{ ...set('i-c1', CLAIM_COLS.member, 'i-p2'), op: 'insert' }], opts({ shape: 'rich' }));
  assert.equal(relId(claim.rows[0].values[CLAIM_COLS.member]), 'i-p2');
  assert.equal(relName(claim.rows[0].values[CLAIM_COLS.member]), 'Dana Levy');
  // Slot -> event and claim -> slot have no name cache: rich gets the row id, which is all gather reads.
  const slot = mergeRows([], [{ ...set('i-s1', SLOT_COLS.event, ['i-1']), op: 'insert' }], opts({ shape: 'rich' }));
  assert.equal(relId(slot.rows[0].values[SLOT_COLS.event]), 'i-1');
  assert.deepEqual(slot.stale, []);
});

test('an unknown venue id is stale and leaves the cell as Coda had it', () => {
  const rows = [row('i-1', { Venue: ['Community Hall'] })];
  const out = mergeRows(rows, [set('i-1', 'Venue', ['i-v404'])], opts());
  assert.deepEqual(out.stale, ['i-1']);
  assert.deepEqual(out.rows[0].values.Venue, ['Community Hall']);
  // An array written to a column the merge can't classify is stale too, never a raw id.
  const unk = mergeRows(rows, [set('i-1', 'Mystery relation', ['i-p1'])], opts());
  assert.deepEqual(unk.stale, ['i-1']);
  assert.equal(unk.rows[0].values['Mystery relation'], undefined);
});

test('times and text come back in the reader\'s own format', () => {
  const nm = mergeRows([row('i-1', { Start: '1899-12-30T18:30:00.000-06:00' })], [set('i-1', 'Start', '19:00')], opts());
  assert.equal(hhmm(nm.rows[0].values.Start), '19:00');
  assert.match(nm.rows[0].values.Start, /^1899-12-30T19:00:00\.000-06:00$/);
  assert.equal(rowToListingEvent(nm.rows[0].values).start, '19:00');
  const rich = mergeRows([row('i-1', {})], [set('i-1', 'Start', '19:00')], opts({ shape: 'rich' }));
  assert.equal(hhmm(plain(rich.rows[0].values[PLANNING_COLS.start])), '19:00');
  const text = 'Bring *one* dish (main_course) - #1 [see] `notes`.\nline 2';
  const t = mergeRows([row('i-1', {})], [set('i-1', 'Title', text)], opts({ shape: 'rich' }));
  assert.match(t.rows[0].values[PLANNING_COLS.title], /^```[\s\S]*```$/);
  assert.equal(stripRich(t.rows[0].values[PLANNING_COLS.title]), text);
  const cleared = mergeRows([row('i-1', {})], [set('i-1', 'Start', '')], opts());
  assert.equal(hhmm(cleared.rows[0].values.Start), '');
});

test('dates come back as the ISO datetime Coda returns, so slicing and new Date both read the day', () => {
  const nm = mergeRows([row('i-1', {})], [set('i-1', PLANNING_COLS.date, '2026-12-05')], opts({ shape: 'id' }));
  assert.equal(nm.rows[0].values[PLANNING_COLS.date], '2026-12-05T00:00:00.000-06:00');
  const summer = mergeRows([row('i-1', {})], [set('i-1', PLANNING_COLS.date, '2026-07-04')], opts({ shape: 'id' }));
  assert.equal(summer.rows[0].values[PLANNING_COLS.date], '2026-07-04T00:00:00.000-05:00');
});

test('age-aware: a snapshot from before the apply keeps the write; one 31 s after it does not', () => {
  const appliedAt = NOW - 4 * 60_000;
  const e = set('i-1', 'Status', 'Approved', { state: 'applied', writtenAt: appliedAt - 28_000, appliedAt });
  const rows = [row('i-1', { Status: 'Draft' })];
  // Snapshot stamped before appliedAt, served 4 min later.
  assert.equal(mergeRows(rows, [e], opts({ snapshotAt: appliedAt - 1000, now: NOW })).rows[0].values.Status, 'Approved');
  // Snapshot stamped 31 s after appliedAt: Coda's copy (including a later Coda-side edit) wins.
  const later = [row('i-1', { Status: 'Cancelled' })];
  assert.equal(mergeRows(later, [e], opts({ snapshotAt: appliedAt + APPLY_MARGIN_MS + 1000, now: NOW })).rows[0].values.Status, 'Cancelled');
});

test('a pending entry 121 s old and a failed entry do not merge', () => {
  const rows = [row('i-1', { Status: 'Draft' })];
  const old = set('i-1', 'Status', 'Approved', { writtenAt: NOW - 121_000 });
  const failed = set('i-1', 'Status', 'Approved', { state: 'failed' });
  assert.equal(mergeRows(rows, [old], opts()).rows[0].values.Status, 'Draft');
  assert.equal(mergeRows(rows, [failed], opts()).rows[0].values.Status, 'Draft');
  // An old pending insert or delete is ignored too.
  const oldIns = { ...set('i-9', 'Title', 'x', { writtenAt: NOW - 121_000 }), op: 'insert' };
  const oldDel = { ...set('i-1', '', null, { writtenAt: NOW - 121_000 }), op: 'delete' };
  assert.deepEqual(mergeRows(rows, [oldIns, oldDel], opts()).rows.map((r) => r.id), ['i-1']);
});

test('rows without entries come back unchanged, and the input is not mutated', () => {
  const rows = [row('i-1', { Title: 'A' }), row('i-2', { Title: 'B' })];
  const before = JSON.stringify(rows);
  const out = mergeRows(rows, [set('i-2', 'Title', 'B2')], opts());
  assert.equal(out.rows[0], rows[0]);
  assert.equal(out.rows[1].values.Title, 'B2');
  assert.equal(JSON.stringify(rows), before);
  assert.deepEqual(mergeRows(rows, [], opts()).rows, rows);
});

test('RELATION_COLS covers the planning, slot and claim relation columns by id', () => {
  for (const id of [PLANNING_COLS.programs, PLANNING_COLS.leads, PLANNING_COLS.volunteers, PLANNING_COLS.venue,
    PLANNING_COLS.createdBy, PLANNING_COLS.editedBy, PLANNING_COLS.approvedBy, PLANNING_COLS.venueType,
    SLOT_COLS.event, CLAIM_COLS.slot, CLAIM_COLS.member]) {
    assert.ok(RELATION_COLS[id], id);
  }
  assert.equal(PLANNING_COLS.venueType, 'c-pVQ7AT4ZI4');
  assert.equal(RELATION_COLS[PLANNING_COLS.editedBy], 'people');
  assert.equal(RELATION_COLS[PLANNING_COLS.approvedBy], 'people');
  assert.equal(RELATION_COLS[PLANNING_COLS.venueType], 'venueTypes');
});

test('Edited by, Venue Type and Approved at convert by id on a rich read', () => {
  const out = mergeRows([row('i-1', {})], [
    set('i-1', PLANNING_COLS.editedBy, ['i-p1']),
    set('i-1', PLANNING_COLS.venueType, ['i-t1']),
    set('i-1', PLANNING_COLS.approvedAt, '2026-12-05'),
  ], opts({ shape: 'rich' }));
  const v = out.rows[0].values;
  assert.equal(relName(v[PLANNING_COLS.editedBy]), 'Leah Cohen');
  assert.equal(relId(v[PLANNING_COLS.venueType]), 'i-t1');
  assert.equal(v[PLANNING_COLS.approvedAt], '2026-12-05T00:00:00.000-06:00');
  assert.deepEqual(out.stale, []);
});

const colKinds = {
  [PLANNING_COLS.title]: 'text', Status: 'text', 'Computed thing': 'calculated',
  [PLANNING_COLS.leads]: 'relation:people', Start: 'time',
};

test('colKinds: a calculated column is stale, an unknown column is stale, a relation converts', () => {
  const rows = [row('i-1', { 'Computed thing': 'x', Mystery: 'm', Leads: ['Old'] })];
  const calc = mergeRows(rows, [set('i-1', 'Computed thing', 'y')], opts({ colKinds }));
  assert.deepEqual(calc.stale, ['i-1']);
  assert.equal(calc.rows[0].values['Computed thing'], 'x');
  const unk = mergeRows(rows, [set('i-1', 'Mystery', 'scalar')], opts({ colKinds }));
  assert.deepEqual(unk.stale, ['i-1']);
  assert.equal(unk.rows[0].values.Mystery, 'm');
  const rel = mergeRows(rows, [set('i-1', 'Leads', ['i-p2'])], opts({ colKinds }));
  assert.deepEqual(rel.rows[0].values.Leads, ['Dana Levy']);
  assert.deepEqual(rel.stale, []);
  // Without colKinds, the same unknown scalar passes as written (slots/claims/venues path).
  assert.equal(mergeRows(rows, [set('i-1', 'Mystery', 'scalar')], opts()).rows[0].values.Mystery, 'scalar');
});

test('the newest entry for a cell untranslatable: the whole row keeps Coda\'s copy and is stale', () => {
  const rows = [row('i-1', { [PLANNING_COLS.status]: '```Draft```', [PLANNING_COLS.title]: '```T```' })];
  const out = mergeRows(rows, [
    set('i-1', 'Status', 'Approved', { writtenAt: NOW - 5000 }),
    set('i-1', 'Unmapped column', 'v', { writtenAt: NOW - 1000 }),
    set('i-1', 'Title', 'New title', { writtenAt: NOW - 3000 }),
  ], opts({ shape: 'rich' }));
  assert.deepEqual(out.stale, ['i-1']);
  assert.deepEqual(out.rows[0].values, rows[0].values);
});

test('tableId: entries for other tables are ignored', () => {
  const rows = [row('i-1', { Title: 'A' })];
  const other = set('i-1', 'Title', 'From another table', { tableId: 'grid-other' });
  assert.equal(mergeRows(rows, [other], opts({ tableId: T })).rows[0].values.Title, 'A');
  assert.equal(mergeRows(rows, [set('i-1', 'Title', 'Mine')], opts({ tableId: T })).rows[0].values.Title, 'Mine');
});

test('same column written once by name and once by id: the newer wins', () => {
  const rows = [row('i-1', { Status: 'Draft' })];
  const byName = set('i-1', 'Status', 'Approved', { writtenAt: NOW - 5000 });
  const byId = set('i-1', PLANNING_COLS.status, 'Cancelled', { writtenAt: NOW - 1000 });
  assert.equal(mergeRows(rows, [byId, byName], opts()).rows[0].values.Status, 'Cancelled');
  const rich = mergeRows([row('i-1', {})], [byId, { ...byName, writtenAt: NOW - 500 }], opts({ shape: 'rich' }));
  assert.equal(plain(rich.rows[0].values[PLANNING_COLS.status]), 'Approved');
});

test('applied boundary: snapshotAt === appliedAt + APPLY_MARGIN_MS is not live', () => {
  const appliedAt = NOW - 60_000;
  const e = { state: 'applied', writtenAt: appliedAt - 28_000, appliedAt };
  assert.equal(isLive(e, { snapshotAt: appliedAt + APPLY_MARGIN_MS, now: NOW }), false);
  assert.equal(isLive(e, { snapshotAt: appliedAt + APPLY_MARGIN_MS - 1, now: NOW }), true);
});

test('checkbox and number pass through as written, in every shape', () => {
  for (const shape of ['name', 'id', 'rich']) {
    const out = mergeRows([row('i-1', {})], [
      set('i-1', PLANNING_COLS.allDay, true),
      set('i-1', PLANNING_COLS.capacity, 40),
    ], opts({ shape }));
    const v = out.rows[0].values;
    const key = (id, name) => (shape === 'name' ? name : id);
    assert.equal(v[key(PLANNING_COLS.allDay, 'All day')], true, shape);
    assert.equal(v[key(PLANNING_COLS.capacity, 'Capacity')], 40, shape);
  }
});

test('a rich single relation (Venue) reads back through relId and relName', () => {
  const out = mergeRows([row('i-1', {})], [set('i-1', 'Venue', ['i-v1'])], opts({ shape: 'rich' }));
  const cell = out.rows[0].values[PLANNING_COLS.venue];
  assert.equal(relId(cell), 'i-v1');
  assert.equal(relName(cell), 'Community Hall');
});
