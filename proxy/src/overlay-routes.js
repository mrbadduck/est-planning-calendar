/**
 * The planning routes' glue to the write overlay (decision 0012): every Worker write to the
 * planning table goes through codaWrite, every read of it through overlayRead. Kept out of
 * worker.js so the routes stay short. With OVERLAY_MODE off each helper does exactly what
 * the route did before; only `overlaid: false` is added to the write responses.
 */
import { codaWrite, overlayRead, bustEventCaches } from './worker-io.js';

// The app already shows this text (web/eventbrite.js); the routes never return `stale`.
export const STILL_SAVING = 'Your last update is still being saved. Try again in a few seconds.';

// One planning-table write (op: insert | update | delete). On success it busts the event
// snapshots as before: the bust refreshes the snapshot, the overlay covers the apply gap.
export async function planningWrite(env, { url, method, body, tableId, op, rowId, auth }) {
  const w = await codaWrite(env, { url, method, body, tableId, op, rowId, auth });
  if (w.ok) await bustEventCaches(env);
  return w;
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

// One planning row by id (column names, simpleWithArrays) with the overlay merged, snapshotAt
// stamped before the read. {ok:false, status} when Coda can't read it (a 404 stays a 404: a new
// event waits for its insert, D2) or a pending delete hides it. stale: this row couldn't be
// merged (an untranslatable or calculated column, a missing name): the guarded routes answer
// 409. An overlay outage (stale ['*']) is not stale here: the row is Coda's copy, the writes
// that follow aren't overlaid (the app waits for the apply, as today), and overlayRead has
// already written its one console line.
export async function readPlanningRow(env, { base, docId, tableId, auth, rowId }) {
  const at = Date.now();
  const r = await fetch(`${base}/docs/${docId}/tables/${tableId}/rows/${encodeURIComponent(rowId)}?useColumnNames=true&valueFormat=simpleWithArrays`, { headers: auth });
  if (!r.ok) return { ok: false, status: r.status };
  const row = await r.json();
  const id = (row && row.id) || rowId;
  const m = await overlayRead(env, tableId, [{ ...row, id }], { shape: 'name', snapshotAt: at, now: Date.now(), planning: { base, docId, auth } });
  const mine = m.rows.find((x) => x.id === id);   // never another row (a pending insert is appended)
  if (!mine) return { ok: false, status: 404 };
  const stale = m.stale.includes(id);
  if (stale) console.error(`overlay: planning row ${id} read stale; Coda's copy kept for its unmerged cells`);
  return { ok: true, values: mine.values || {}, stale, outage: m.stale.includes('*') };
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
