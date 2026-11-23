// The write-through overlay merge (decision 0012). Pure: no I/O, unit-tested.
//
// The Worker remembers each write it sent to Coda (an Entry, see overlay-do.js) until Coda
// has applied it, and lays those entries over every read it serves. Four rules:
//   1. Live:   only live entries merge (isLive). A pending entry for FAIL_AFTER_MS after it
//              was written; an applied one only into snapshots taken before
//              appliedAt + APPLY_MARGIN_MS, so Coda's copy (and any later Coda-side edit)
//              wins after that; a failed one never.
//   2. Newest: when several live entries touch one cell, the newest writtenAt wins.
//   3. Keying: an entry keeps the key it was written with (a column name or a c- id). It is
//              used as is when it matches the reader's keying (name for shape 'name', id for
//              'id' and 'rich'), else translated through colMap (planning only). A key
//              colMap doesn't know marks the row stale and leaves Coda's cell.
//   4. Shapes: each reader gets its own format. Relations are written as row ids and read
//              as display names (simpleWithArrays: 'name', 'id') or {rowId, name} ('rich'),
//              via the `names` caches; an id missing there marks the row stale. Text is
//              fenced for 'rich' the way Coda fences it (stripRich reads it back). A written
//              'HH:MM' time and 'YYYY-MM-DD' date become the ISO forms Coda returns.
//              Relations always come back as arrays (names, or {rowId, name}); the rich
//              objects leave out Coda's `type` and `targetTableId` (no reader uses them).
// Column kinds: relation, time, date, and plain scalars (text, select, number, checkbox,
// link, JSON text: strings fenced for rich, the rest as written). Formula, lookup and button
// columns and the row's display name are not overlaid: nothing writes them.
// Where kinds come from:
//   - With `colKinds` (the planning table; Task 3 builds it from /columns: `calculated` plus
//     format.type): colKinds first, keyed by column id or name. A `calculated` column, or one
//     colKinds doesn't know, marks the row stale (0007: no silent pass-through).
//   - Without it (slots, claims, venues: id-keyed, fully covered by RELATION_COLS and the ids
//     below): KIND_BY_ID, then KIND_BY_NAME, else a plain scalar. An array written to a
//     column classified this way is stale, never shown as raw ids.
// No silent drops, two cases. A key that can't be translated to the reader's keying drops
// the row's whole overlay (the row keeps Coda's copy) and marks it stale. A cell whose kind
// is unknown or whose value can't be converted keeps Coda's value for that cell only (the
// row's other overlaid cells still merge) and marks the row stale. `tableId`, when given,
// ignores entries for other tables.
// Returns { rows, stale, pendingInserts }: pendingInserts are the rows the merge added from
// insert entries Coda hasn't applied yet (not in Coda's rows, entry not `applied`); gather
// marks the caller's own such claim `pending` (its edit/remove would answer 409).

import { APPLY_MARGIN_MS, FAIL_AFTER_MS } from './overlay-do.js';
import { PLANNING_COLS, SLOT_COLS, CLAIM_COLS, VENUE_COLS } from './coda-columns.js';

// Relation column id -> the `names` cache its target rows are named from. 'events' and
// 'slots' have no name cache: rich reads get {rowId, name: ''} (gather reads them with
// relId only); a name-shaped read of them is stale.
export const RELATION_COLS = {
  [PLANNING_COLS.programs]: 'programs',
  [PLANNING_COLS.leads]: 'people',
  [PLANNING_COLS.volunteers]: 'people',
  [PLANNING_COLS.venue]: 'venues',
  [PLANNING_COLS.createdBy]: 'people',
  [PLANNING_COLS.editedBy]: 'people',
  [PLANNING_COLS.approvedBy]: 'people',
  [PLANNING_COLS.venueType]: 'venueTypes',
  [SLOT_COLS.event]: 'events',
  [CLAIM_COLS.slot]: 'slots',
  [CLAIM_COLS.member]: 'people',
  [VENUE_COLS.type]: 'venueTypes',
};
const KIND_BY_ID = {
  ...RELATION_COLS,
  [PLANNING_COLS.start]: 'time', [PLANNING_COLS.end]: 'time',
  [PLANNING_COLS.date]: 'date', [PLANNING_COLS.windowStart]: 'date', [PLANNING_COLS.windowEnd]: 'date',
  [PLANNING_COLS.approvedAt]: 'date',
};
// The planning seam writes by name (web/data.js eventToCodaCells, worker.js attribution).
// The fallback after ids, for a name-keyed entry whose id is unknown (read without colMap).
const KIND_BY_NAME = {
  'Program(s)': 'programs', Leads: 'people', Volunteers: 'people', Venue: 'venues',
  'Venue Type': 'venueTypes', 'Created by': 'people', 'Edited by': 'people', 'Approved by': 'people',
  Start: 'time', End: 'time', Date: 'date', 'Window start': 'date', 'Window end': 'date',
  'Approved at': 'date',
};
const COL_KIND = { text: null, time: 'time', date: 'date' };
// A colKinds value -> internal kind (a names cache, 'time', 'date' or null for plain), or FAIL.
function fromColKinds(k) {
  if (typeof k !== 'string') return FAIL;
  if (k.startsWith('relation:') && k.length > 9) return k.slice(9);
  return Object.prototype.hasOwnProperty.call(COL_KIND, k) ? COL_KIND[k] : FAIL;   // 'calculated' too
}
const NAMELESS = new Set(['events', 'slots']);
const FAIL = Symbol('stale');

export function isLive(entry, { snapshotAt, now }) {
  if (!entry) return false;
  if (entry.state === 'applied') return snapshotAt < entry.appliedAt + APPLY_MARGIN_MS;
  // Not applied: never past FAIL_AFTER_MS, even before the alarm has marked it failed.
  if (entry.state === 'pending') return now - entry.writtenAt < FAIL_AFTER_MS;
  return false;
}

// UTC offset ('-06:00') of `tz` at a given instant.
function offsetAt(tz, isoInstant) {
  const p = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'longOffset' })
    .formatToParts(new Date(isoInstant)).find((x) => x.type === 'timeZoneName');
  const m = /GMT([+-]\d{2}:\d{2})?/.exec(p ? p.value : '');
  return (m && m[1]) || '+00:00';
}
// Coda serializes a time as a 1899-12-30 placeholder datetime and a date as local midnight.
const timeIso = (v, tz) => `1899-12-30T${v}:00.000${offsetAt(tz, `1899-12-30T12:00:00Z`)}`;
const dateIso = (v, tz) => `${v}T00:00:00.000${offsetAt(tz, `${v}T12:00:00Z`)}`;
// Inverse of stripRich: escape what it unescapes, then fence.
const fence = (s) => '```' + s.replace(/[\\`*_~[\]()#+\-.!>|{}]/g, '\\$&') + '```';

function convert(value, kind, shape, names, tz) {
  if (kind === 'time' && typeof value === 'string' && /^\d{2}:\d{2}$/.test(value)) return timeIso(value, tz);
  if (kind === 'date' && typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) return dateIso(value, tz);
  if (kind && kind !== 'time' && kind !== 'date') {
    const ids = value == null || value === '' ? [] : (Array.isArray(value) ? value : [value]);
    if (ids.some((id) => typeof id !== 'string')) return FAIL;
    if (NAMELESS.has(kind)) return shape === 'rich' ? ids.map((rowId) => ({ rowId, name: '' })) : FAIL;
    const map = (names && names[kind]) || {};
    if (ids.some((id) => typeof map[id] !== 'string')) return FAIL;
    return ids.map((id) => (shape === 'rich' ? { rowId: id, name: map[id] } : map[id]));
  }
  if (Array.isArray(value)) return FAIL;   // unclassified column written with a list: likely a relation
  if (shape === 'rich' && typeof value === 'string' && value !== '') return fence(value);
  return value;
}

export function mergeRows(rows, entries, { shape, snapshotAt, now, colMap, colKinds, names, tableId, tz = 'America/Chicago' } = {}) {
  const readerKeying = shape === 'name' ? 'name' : 'id';
  const stale = new Set();
  const live = (entries || [])
    .filter((e) => (tableId == null || e.tableId === tableId) && isLive(e, { snapshotAt, now }))
    .sort((a, b) => a.writtenAt - b.writtenAt);
  const have = new Set((rows || []).map((r) => r.id));
  const deleted = new Set(), inserted = [], cells = new Map();   // rowId -> Map(readerKey -> {entry, kind})
  const untranslated = new Set();   // rows whose overlay is dropped whole
  const unapplied = new Set();      // inserted rows Coda hasn't applied yet
  for (const e of live) {
    if (e.op === 'delete') { deleted.add(e.rowId); continue; }
    if (e.op === 'insert') {
      if (have.has(e.rowId)) continue;   // Coda already has the row: its copy wins
      if (!inserted.includes(e.rowId)) inserted.push(e.rowId);
      if (e.state !== 'applied') unapplied.add(e.rowId);
    }
    const colId = e.keying === 'id' ? e.key : colMap && colMap.nameToId && colMap.nameToId[e.key];
    const colName = e.keying === 'name' ? e.key : colMap && colMap.idToName && colMap.idToName[e.key];
    const readerKey = e.keying === readerKeying ? e.key : (readerKeying === 'id' ? colId : colName);
    if (!readerKey) { stale.add(e.rowId); untranslated.add(e.rowId); continue; }
    let kind;
    if (colKinds) {
      const k = (colId && colKinds[colId]) || (colName && colKinds[colName]);
      kind = fromColKinds(k);
    } else kind = KIND_BY_ID[colId] || KIND_BY_NAME[colName] || null;
    if (!cells.has(e.rowId)) cells.set(e.rowId, new Map());
    cells.get(e.rowId).set(readerKey, { entry: e, kind });   // ascending writtenAt: newest wins
  }
  const overlay = (r) => {
    const touched = cells.get(r.id);
    if (!touched) return r;
    const values = { ...(r.values || {}) };
    for (const [k, { entry, kind }] of touched) {
      const v = kind === FAIL ? FAIL : convert(entry.value, kind, shape, names, tz);
      if (v === FAIL) stale.add(r.id); else values[k] = v;
    }
    return { ...r, values };
  };
  const out = (rows || []).filter((r) => !deleted.has(r.id))
    .map((r) => (untranslated.has(r.id) ? r : overlay(r)));
  const pendingInserts = [];
  for (const id of inserted) {
    if (have.has(id) || deleted.has(id) || untranslated.has(id)) continue;
    out.push(overlay({ id, values: {} }));
    if (unapplied.has(id)) pendingInserts.push(id);
  }
  return { rows: out, stale: [...stale], pendingInserts };
}
