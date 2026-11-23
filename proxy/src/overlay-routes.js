/**
 * The routes' glue to the write overlay (decision 0012): every Worker write to the planning,
 * slots, claims and venues tables goes through codaWrite, every read of them through
 * overlayRead. Kept out of worker.js so the routes stay short. With OVERLAY_MODE off each helper does exactly what
 * the route did before; only `overlaid: false` is added to the write responses.
 */
import { codaWrite, overlayRead, bustEventCaches, overlayHasLive, mergedRows, REF_TABLES } from './worker-io.js';
import { venueRefItem } from './publish.js';
import { claimOwnerId } from './gather.js';
import { CLAIM_COLS } from './coda-columns.js';

// The app already shows this text (web/eventbrite.js); the routes never return `stale`.
export const STILL_SAVING = 'Your last update is still being saved. Try again in a few seconds.';
// Editing or removing a sign-up whose insert Coda hasn't applied yet (Coda would 404 it).
export const CLAIM_STILL_SAVING = 'Your sign-up is still being saved. Try again in a few seconds.';

// One write to a table the event snapshots are built from (planning, slots, claims; op:
// insert | update | delete). On success it busts them once: the bust refreshes the snapshot,
// the overlay covers the apply gap.
export async function planningWrite(env, { url, method, body, tableId, op, rowId, auth }) {
  const w = await codaWrite(env, { url, method, body, tableId, op, rowId, auth });
  if (w.ok) await bustEventCaches(env);
  return w;
}
// Slots and claims: the same write and bust. Not overlaid (OVERLAY_MODE off, or the overlay
// down), a gather read in the ~28 s before Coda applies the write would refill the snapshot
// without it, so the snapshots are busted again after the apply, as before 0012. Overlaid,
// one bust: the overlay covers the gap.
export const APPLY_WAIT_MS = 28_000;
export async function gatherWrite(env, ctx, args) {
  const w = await planningWrite(env, args);
  if (w.ok && !w.overlaid && ctx) ctx.waitUntil(new Promise((r) => setTimeout(r, APPLY_WAIT_MS)).then(() => bustEventCaches(env)));
  return w;
}

// /ref/venues. The KV value is Coda's projection with its `at` (venueRefItem: no addresses,
// R12), never the merged view, so a write that later fails never lingers in it. At serve
// time: no live venue entry against that `at` -> the cached projection. Otherwise (and for
// ?fresh=1, cached = null) read the venues table once, store Coda's projection, and serve
// it with the overlay merged (a just-saved address). readRaw(): the raw by-id rows (throws);
// put(at, items): store a projection.
export async function refVenues(env, { cached, readRaw, put }) {
  if (cached && !(await overlayHasLive(env, REF_TABLES.venues, cached.at))) return cached.data;
  const at = Date.now();
  const raw = await readRaw();
  await put(at, raw.map(venueRefItem));
  return (await mergedRows(env, REF_TABLES.venues, raw, at, { shape: 'id', want: ['venueTypes'] })).map(venueRefItem);
}

// A route's row write-backs (publish, cancel, unpublish). requestId: the last one Coda gave
// (the app waits on it, D3). overlaid: true only when every write in the call was overlaid.
export function planningRowSetter(env, { rowsUrl, tableId, rowId, auth }) {
  let writes = 0, all = true;
  const s = {
    requestId: null,
    get overlaid() { return writes > 0 && all; },
    async set(cells) {
      const w = await planningWrite(env, { url: `${rowsUrl}/${encodeURIComponent(rowId)}`, method: 'PUT', body: { row: { cells } }, tableId, op: 'update', rowId, auth });
      writes++; all = all && w.overlaid;
      if (w.ok) s.requestId = w.requestId || s.requestId;
      return w;
    },
  };
  return s;
}

// One row by id with the overlay merged, snapshotAt stamped before the read. `query` is the
// read's query string, `shape` the merge's ('name' | 'id' | 'rich'), `planning` as overlayRead.
// {ok:false, status, resp} when Coda can't read it, or a pending delete hides it (404). With
// `insertAware`, a Coda 404 asks the overlay: a live pending insert of this id comes back with
// pendingInsert: true. stale: this row couldn't be fully merged; outage: the overlay read failed.
export async function readRowMerged(env, { base, docId, tableId, auth, rowId, query, shape, planning, want, insertAware }) {
  const at = Date.now();
  const r = await fetch(`${base}/docs/${docId}/tables/${tableId}/rows/${encodeURIComponent(rowId)}?${query}`, { headers: auth });
  if (!r.ok && !(insertAware && r.status === 404)) return { ok: false, status: r.status, resp: r };
  const row = r.ok ? await r.json() : null;
  const id = (row && row.id) || rowId;
  const m = await overlayRead(env, tableId, row ? [{ ...row, id }] : [], { shape, snapshotAt: at, now: Date.now(), planning, want });
  const mine = m.rows.find((x) => x.id === id);   // never another row (a pending insert is appended)
  if (!mine) return { ok: false, status: 404 };
  const stale = m.stale.includes(id);
  if (stale) console.error(`overlay: ${tableId} row ${id} read stale; Coda's copy kept for its unmerged cells`);
  return { ok: true, row: mine, stale, outage: m.stale.includes('*'), pendingInsert: !row };
}

// One planning row by id (column names, simpleWithArrays) with the overlay merged. A 404 stays
// a 404 (a new event waits for its insert, D2). stale: the guarded routes answer 409. An
// overlay outage (stale ['*']) is not stale here: the row is Coda's copy, the writes that
// follow aren't overlaid (the app waits for the apply, as today), and overlayRead has
// already written its one console line.
export async function readPlanningRow(env, { base, docId, tableId, auth, rowId }) {
  const one = await readRowMerged(env, { base, docId, tableId, auth, rowId, query: 'useColumnNames=true&valueFormat=simpleWithArrays', shape: 'name', planning: { base, docId, auth } });
  if (!one.ok) return { ok: false, status: one.status };
  return { ok: true, values: one.row.values || {}, stale: one.stale, outage: one.outage };
}

// The claim a PUT or DELETE /claims/:id acts on (rich, merged), checked for the caller `m`
// ({personId, canWrite}). -> {row} | {status, error}. A claim Coda doesn't have yet but the
// overlay holds as a pending insert answers 409 CLAIM_STILL_SAVING to its owner or a canWrite
// caller (also when its member can't be named: whose it is can't be told yet); anyone else
// gets the 404 Coda would give. A claim Coda has, with a pending edit, proceeds as today.
export async function readClaimForWrite(env, { base, docId, tableId, auth, claimId }, m) {
  const one = await readRowMerged(env, { base, docId, tableId, auth, rowId: claimId, query: 'useColumnNames=false&valueFormat=rich', shape: 'rich', want: ['people'], insertAware: true });
  if (!one.ok) return { status: 404, error: 'not found' };
  const owner = claimOwnerId(one.row, CLAIM_COLS);
  const mine = (owner && owner === m.personId) || m.canWrite;
  if (one.pendingInsert) return (mine || one.stale) ? { status: 409, error: CLAIM_STILL_SAVING } : { status: 404, error: 'not found' };
  if (!mine) return { status: 403, error: 'not your claim' };
  return { row: one.row };
}

// Should a guarded route (publish, cancel, unpublish, /rows DELETE) answer 409 STILL_SAVING?
// Yes when this row is stale. In an overlay outage, only when the app says it still holds
// unconfirmed overlaid writes for the event (`unconfirmed`): Coda's copy may predate them.
export function mustWait(one, unconfirmed) {
  return one.stale || (one.outage && unconfirmed === true);
}

// The /rows list with the overlay merged into a snapshot taken at `snapshotAt`.
export async function planningList(env, { base, docId, tableId, auth }, items, snapshotAt) {
  const m = await overlayRead(env, tableId, items, { shape: 'name', snapshotAt, now: Date.now(), planning: { base, docId, auth } });
  const rowsStale = m.stale.filter((x) => x !== '*');
  if (rowsStale.length) console.error(`overlay: /rows ${rowsStale.length} row(s) stale (${rowsStale.slice(0, 5).join(', ')}); Coda's copy kept for their unmerged cells`);
  return m.rows;
}
