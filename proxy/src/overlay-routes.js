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
// event waits for its insert, D2) or a pending delete hides it. stale: the row (or the whole
// overlay read) couldn't be merged; the caller decides (publish/cancel/unpublish answer 409).
export async function readPlanningRow(env, { base, docId, tableId, auth, rowId }) {
  const at = Date.now();
  const r = await fetch(`${base}/docs/${docId}/tables/${tableId}/rows/${encodeURIComponent(rowId)}?useColumnNames=true&valueFormat=simpleWithArrays`, { headers: auth });
  if (!r.ok) return { ok: false, status: r.status };
  const row = await r.json();
  const id = (row && row.id) || rowId;
  const m = await overlayRead(env, tableId, [{ ...row, id }], { shape: 'name', snapshotAt: at, now: Date.now(), planning: { base, docId, auth } });
  const stale = m.stale.includes('*') || m.stale.includes(id);
  if (stale && !m.stale.includes('*')) console.error(`overlay: planning row ${id} read stale; Coda's copy kept for its unmerged cells`);
  if (!m.rows.length) return { ok: false, status: 404 };
  return { ok: true, row: m.rows[0], values: m.rows[0].values || {}, stale };
}

// The /rows list with the overlay merged into a snapshot taken at `snapshotAt`.
export async function planningList(env, { base, docId, tableId, auth }, items, snapshotAt) {
  const m = await overlayRead(env, tableId, items, { shape: 'name', snapshotAt, now: Date.now(), planning: { base, docId, auth } });
  const rowsStale = m.stale.filter((x) => x !== '*');
  if (rowsStale.length) console.error(`overlay: /rows ${rowsStale.length} row(s) stale (${rowsStale.slice(0, 5).join(', ')}); Coda's copy kept for their unmerged cells`);
  return m.rows;
}
