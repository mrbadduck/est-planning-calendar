/**
 * Shared Worker I/O helpers: KV cache bust, Coda row reads, the Eventbrite v3
 * client, the Eventbrite-pending marker and the Publish Log writer. Moved out of
 * worker.js so the sync modules can import them.
 * The write overlay seam (decision 0012): overlayOn, codaWrite + passWrite (a Coda
 * write recorded in the WriteOverlay DO), overlayRead (a read with the overlay merged),
 * overlayStatus (/mutation asks the DO first), planningColMap (the planning table's
 * id <-> name map and column kinds, KV-cached for an hour) and overlayNames (relation
 * display names from the existing KV caches).
 */
import { ebPendingKey, EB_PENDING_TTL, venueRefItem } from './publish.js';
import { slimPeopleRows } from './gather.js';
import { mergeRows, isLive } from './overlay.js';
import { PEOPLE_COLS } from './coda-columns.js';

export async function swrBust(env, key) {
  const kv = env.CACHE; if (!kv) return;
  try { await kv.delete(key); } catch (_) {}
}
export const ROWS_KV_KEY = 'rows-v1';
// Gather's snapshot: {events, slots, claims}, the three tables' raw rich rows. The overlay is
// merged into them before gatherSnapshot groups them (worker.js buildMemberEvents), so the
// snapshot is never the filtered, grouped shape (v1, 'gather-events-v1', is never read).
export const GATHER_KV_KEY = 'gather-snap-v2';
// Anything that changes an event, slot or claim busts both event-derived snapshots, once:
// the bust refreshes the snapshot, the overlay covers the ~28 s until Coda applies the write.
export async function bustEventCaches(env) {
  await Promise.all([swrBust(env, ROWS_KV_KEY), swrBust(env, GATHER_KV_KEY)]);
}

// R19: Eventbrite ids the Worker created but Coda hasn't applied to the row yet
// (resolveEbIds in publish.js). A KV failure here only loses the backstop.
export async function readEbPending(env, rowId) {
  const kv = env.CACHE; if (!kv || !rowId) return null;
  try { return await kv.get(ebPendingKey(rowId), 'json'); } catch (_) { return null; }
}
export async function writeEbPending(env, rowId, marker) {
  const kv = env.CACHE; if (!kv || !rowId) return;
  try { await kv.put(ebPendingKey(rowId), JSON.stringify(marker), { expirationTtl: EB_PENDING_TTL }); } catch (_) {}
}
// A Coda row PUT returns 202 {requestId}: the write applies 13–30 s later (F1).
export async function codaRequestId(r) {
  if (!r || !r.ok) return null;
  try { const j = await r.clone().json(); return (j && j.requestId) || null; } catch (_) { return null; }
}


// Read every page of a table's rows (column names + simpleWithArrays), aggregated.
// Returns { ok:true, items, truncated } or { ok:false, resp } carrying the upstream error.
// truncated: it stopped at its page cap with rows still unread.
export async function readAllRows(rowsUrl, auth, opts = {}) {
  const items = [];
  let pageToken = null, pages = 0;
  do {
    const u = new URL(rowsUrl);
    // rich -> relations come back as { rowId, name } objects (needed for grouping +
    // ownership by id); implies id-keyed. byId -> id-keyed, values still name-strings.
    u.searchParams.set('useColumnNames', (opts.byId || opts.rich) ? 'false' : 'true');
    u.searchParams.set('valueFormat', opts.rich ? 'rich' : 'simpleWithArrays');
    u.searchParams.set('limit', '200');
    if (pageToken) u.searchParams.set('pageToken', pageToken);
    const r = await fetch(u.toString(), { headers: auth });
    if (!r.ok) return { ok: false, resp: r };
    const j = await r.json();
    if (Array.isArray(j.items)) items.push(...j.items);
    pageToken = j.nextPageToken || null;
  } while (pageToken && ++pages < 6);
  return { ok: true, items, truncated: !!pageToken };
}

export const EB_BASE = 'https://www.eventbriteapi.com/v3';
export async function ebFetch(env, path, method = 'GET', body, opts = {}) {
  const reqBody = body ? JSON.stringify(body) : undefined;
  const r = await fetch(`${EB_BASE}${path}`, {
    method,
    headers: { Authorization: `Bearer ${env.EVENTBRITE_TOKEN}`, 'Content-Type': 'application/json' },
    body: reqBody,
  });
  const text = await r.text();
  let j = null; try { j = JSON.parse(text); } catch (_) {}
  // Full request/response trace for wrangler tail + Workers Logs. The bearer token
  // is never in `path`/`reqBody`, so this is safe to log verbatim. Response headers
  // included (rate-limit + request-id help when Eventbrite is flaky).
  // opts.quiet logs status only — used for attendee reads, whose bodies carry
  // registrant PII that must never land in logs.
  try {
    console.log('eb', JSON.stringify({
      req: { method, path, body: opts.quiet ? undefined : reqBody },
      res: opts.quiet ? { status: r.status } : { status: r.status, headers: Object.fromEntries(r.headers), body: text },
    }));
  } catch (_) {}
  return { ok: r.ok, status: r.status, body: j, text };
}

// The Publish Log cells for one record. `rec.target` (default 'Eventbrite') fills
// Target. A system action has no `rec.actorId`; its Message is then prefixed
// "[eventbrite] " or "[sweep] " from `rec.via` so the log says who acted.
export function publishLogCells(rec, nowIso) {
  const prefix = rec.actorId ? '' : (rec.via === 'sweep' ? '[sweep] ' : '[eventbrite] ');
  return [
    { column: 'When', value: nowIso },
    { column: 'Planning Event', value: rec.rowId ? [rec.rowId] : [] },
    { column: 'Actor', value: rec.actorId ? [rec.actorId] : [] },
    { column: 'Target', value: rec.target || 'Eventbrite' },
    { column: 'Action', value: rec.action },
    { column: 'Result', value: rec.ok ? 'ok' : 'error' },
    { column: 'Eventbrite ID', value: rec.ebId || '' },
    { column: 'Eventbrite URL', value: rec.ebUrl || '' },
    { column: 'HTTP status', value: rec.status || 0 },
    { column: 'Message', value: prefix + (rec.message || '') },
  ];
}

// Append many records in ONE Publish Log insert (a sync run's whole log: one
// outbound call). Never throws; nothing to log makes no call. A failed write is
// never silent: the console line says how many records were lost.
export async function logPublishMany(env, base, docId, auth, recs) {
  if (!env.CODA_PUBLISH_LOG_TABLE || !recs || !recs.length) return;
  const nowIso = new Date().toISOString();
  const lost = (why) => { try { console.error('publish-log', JSON.stringify({ lost: recs.length, ...why })); } catch (_) {} };
  try {
    const r = await fetch(`${base}/docs/${docId}/tables/${env.CODA_PUBLISH_LOG_TABLE}/rows`,
      { method: 'POST', headers: auth, body: JSON.stringify({ rows: recs.map((rec) => ({ cells: publishLogCells(rec, nowIso) })) }) });
    if (!r.ok) lost({ status: r.status });
  } catch (err) { lost({ error: String((err && err.message) || err) }); }   // logging must never break the sync
}

// Append one row to the Publish Log table. Logging must NEVER throw — a failed
// log write can't be allowed to break (or falsely fail) the publish path.
export async function logPublish(env, base, docId, auth, rec) {
  if (!env.CODA_PUBLISH_LOG_TABLE) return;
  const cells = publishLogCells(rec, new Date().toISOString());
  try {
    await fetch(`${base}/docs/${docId}/tables/${env.CODA_PUBLISH_LOG_TABLE}/rows`,
      { method: 'POST', headers: auth, body: JSON.stringify({ rows: [{ cells }] }) });
  } catch (_) { /* logging must never break the publish path */ }
}


// --- the write overlay seam (0012) ----------------------------------------------
// KV keys of the caches overlayNames reads; worker.js fills them (/ref, peopleRows).
export const PEOPLE_KV_KEY = 'people-slim-v3';   // v3: + Active Member? (bump on any slim-shape change)
export const VENUES_KV_KEY = 'ref-venues-v2';    // /ref/venues projection (venueRefItem); bump on a shape change
export const refKvKey = (name) => (name === 'venues' ? VENUES_KV_KEY : `ref-${name}-v1`);
// The /ref allowlist: the only tables /ref reads, and the relation targets overlayNames names.
export const REF_TABLES = { programs: 'grid-g87NFbtqN8', people: 'grid-X316Eql8dE', venues: 'grid-foC40iAOaX', 'venue-types': 'grid-idEVRQX7SL' };
// The builders behind the /ref/:name and People slim KV caches (worker.js /ref and peopleRows);
// overlayNames refills a missing cache with the same one. Each throws on a failed read.
// Venues are read by column id and projected (venueRefItem): no addresses in the cache (R12).
// opts.raw (venues): the raw by-id rows, for the serve-time overlay merge (overlay-routes.js
// refVenues); never cached (R12).
export async function fetchRefItems(base, docId, auth, name, opts = {}) {
  const isVenues = name === 'venues';
  const out = await readAllRows(`${base}/docs/${docId}/tables/${REF_TABLES[name]}/rows`, auth, { byId: isVenues });
  if (!out.ok) throw new Error(`ref read failed (${out.resp.status})`);
  return isVenues && !opts.raw ? out.items.map(venueRefItem) : out.items;
}
export async function fetchPeopleSlim(base, docId, auth) {
  const out = await readAllRows(`${base}/docs/${docId}/tables/${REF_TABLES.people}/rows`, auth, { byId: true });   // id-keyed: auth/role resolution must survive People column renames
  if (!out.ok) throw new Error(`people read failed (${out.resp.status})`);
  return slimPeopleRows(out.items, PEOPLE_COLS);
}
const CACHE_OF_TABLE = { [REF_TABLES.people]: 'people', [REF_TABLES.programs]: 'programs', [REF_TABLES.venues]: 'venues', [REF_TABLES['venue-types']]: 'venueTypes' };

export const overlayOn = (env) => env.OVERLAY_MODE === 'live' && !!env.OVERLAY;
const errText = (e) => String((e && e.message) || e);
// One call to the single global WriteOverlay; throws on a non-2xx.
async function overlayCall(env, path, payload) {
  const obj = env.OVERLAY.get(env.OVERLAY.idFromName('overlay'));
  const r = await obj.fetch(`https://overlay${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  if (!r.ok) throw new Error(`${path} answered ${r.status}`);
  return r.json();
}
const keyingOf = (key) => (/^c-/.test(key) ? 'id' : 'name');

// Entries for one accepted write, cells as written. null when they can't be built.
function writeEntries({ body, tableId, op, rowId }, requestId, addedRowIds, writtenAt) {
  const base = { tableId, requestId, writtenAt };
  const cellEntries = (cells, id, entryOp) => (cells || []).map((c) =>
    ({ ...base, rowId: id, key: c.column, keying: keyingOf(c.column), value: c.value, op: entryOp }));
  if (op === 'delete') return rowId ? [{ ...base, rowId, key: '', keying: 'id', value: null, op: 'delete' }] : null;
  if (op === 'update') return rowId && body && body.row ? cellEntries(body.row.cells, rowId, 'set') : null;
  if (op === 'insert') {
    const rows = (body && body.rows) || [];
    if (!rows.length || rows.length !== addedRowIds.length) return null;
    return rows.flatMap((r, i) => cellEntries(r.cells, addedRowIds[i], 'insert'));
  }
  return null;
}

// Send one Coda write exactly as the call site did, then (overlay on, 2xx) record it.
// overlaid: false when the overlay is off, the write is an upsert (keyColumns: which row
// it lands on is unknown), Coda gave no requestId, or the record call failed; the app
// then waits for the apply as before. Never throws on an overlay failure.
export async function codaWrite(env, { url, method, body, tableId, op, rowId, auth }) {
  const init = body === undefined ? { method, headers: auth } : { method, headers: auth, body: JSON.stringify(body) };
  const resp = await fetch(url, init);
  let j = null;
  if (resp.ok) { try { j = await resp.clone().json(); } catch (_) {} }
  const requestId = (j && j.requestId) || null;
  const addedRowIds = (j && Array.isArray(j.addedRowIds)) ? j.addedRowIds : [];
  const out = { ok: resp.ok, status: resp.status, resp, requestId, addedRowIds, overlaid: false };
  if (!resp.ok || !overlayOn(env) || (body && body.keyColumns)) return out;
  const entries = requestId ? writeEntries({ body, tableId, op, rowId }, requestId, addedRowIds, Date.now()) : null;
  if (!entries || !entries.length) {
    const rows = op === 'insert' && body && Array.isArray(body.rows) ? body.rows : null;
    const why = !requestId ? 'no requestId' : (rows && rows.length && rows.length !== addedRowIds.length ? 'addedRowIds count mismatch' : 'no entries');
    console.error(`overlay: ${op} on ${tableId} not overlaid (${why})`);
    return out;
  }
  try { await overlayCall(env, '/record', { entries }); out.overlaid = true; }
  catch (e) { console.error(`overlay: record ${requestId} failed (${errText(e)}); not overlaid`); }
  return out;
}

// Coda's body with `overlaid` added (an insert keeps addedRowIds + requestId).
export async function passWrite(result, cors) {
  const text = await result.resp.text();
  let j = null; try { j = JSON.parse(text); } catch (_) {}
  const out = j && typeof j === 'object' && !Array.isArray(j) ? JSON.stringify({ ...j, overlaid: result.overlaid }) : text;
  return new Response(out, { status: result.status, headers: { 'Content-Type': 'application/json', ...cors } });
}

// The DO's state for a requestId, or null (overlay off, no record, or the call failed).
export async function overlayStatus(env, requestId) {
  if (!overlayOn(env)) return null;
  try { return (await overlayCall(env, '/status', { requestId })).state || null; }
  catch (e) { console.error(`overlay: status ${requestId} failed (${errText(e)}); asking Coda`); return null; }
}

// Column kind for the merge (overlay.js fromColKinds): pass-through scalars are 'text';
// a relation names its target's cache; anything else (formula, a relation elsewhere,
// an unknown type) is 'calculated', which the merge reads as stale, never as raw.
const SCALAR_TYPES = new Set(['text', 'number', 'checkbox', 'select', 'link', 'email', 'canvas', 'percent', 'currency', 'slider', 'scale']);
function colKind(c) {
  const f = c.format || {};
  if (c.calculated) return 'calculated';
  if (f.type === 'lookup' || f.type === 'relation') {
    const cache = CACHE_OF_TABLE[f.table && f.table.id];
    return cache ? `relation:${cache}` : 'calculated';
  }
  if (f.type === 'time') return 'time';
  if (f.type === 'date' || f.type === 'dateTime') return 'date';
  return SCALAR_TYPES.has(f.type) ? 'text' : 'calculated';
}
export const PLANNING_COLS_KV_KEY = 'planning-cols-v1';
const COL_MAP_MS = 3600_000;
// The planning table's {idToName, nameToId, colKinds}: one /columns?limit=200 call at most
// hourly (KV); counted in the budget of every route that can reach it. Throws on a failed read.
export async function planningColMap(env, base, docId, tableId, auth) {
  const kv = env.CACHE;
  let hit = null;
  if (kv) { try { hit = await kv.get(PLANNING_COLS_KV_KEY, 'json'); } catch (_) {} }
  if (hit && hit.data && hit.tableId === tableId && Date.now() - hit.at < COL_MAP_MS) return hit.data;
  const at = Date.now();
  const r = await fetch(`${base}/docs/${docId}/tables/${tableId}/columns?limit=200`, { headers: auth });
  if (!r.ok) throw new Error(`columns read failed (${r.status})`);
  const data = { idToName: {}, nameToId: {}, colKinds: {} };
  for (const c of (await r.json()).items || []) {
    if (!c || !c.id) continue;
    data.idToName[c.id] = c.name; data.nameToId[c.name] = c.id; data.colKinds[c.id] = colKind(c);
  }
  if (kv) { try { await kv.put(PLANNING_COLS_KV_KEY, JSON.stringify({ at, tableId, data })); } catch (_) {} }
  return data;
}

// Relation display names from the caches the Worker already keeps (KV). With `refill`
// ({base, docId, auth}, planning reads) a missing cache (e.g. VENUES_KV_KEY just busted by a
// venue write) is rebuilt with its route's own builder and put back in KV, stamped before the
// read. Budget: at most one Coda read per missing cache per request (programs, venues, venue
// types 1 page each; People up to 6, though auth has normally just filled it), and only when a
// live entry needs merging. A cache still missing gives an empty map: its relation cells read
// as stale (logged once), as before.
// `want` (labels: people, programs, venues, venueTypes) reads only those caches; default all.
export async function overlayNames(env, refill, want) {
  const read = async (key) => { try { const h = env.CACHE && await env.CACHE.get(key, 'json'); return h && Array.isArray(h.data) ? h.data : null; } catch (_) { return null; } };
  const fill = async (key, label, build) => {
    if (want && !want.includes(label)) return [];
    const hit = await read(key);
    if (hit || !refill) return hit;
    try {
      const at = Date.now(), data = await build();
      if (env.CACHE) { try { await env.CACHE.put(key, JSON.stringify({ at, data })); } catch (_) {} }
      return data;
    } catch (e) { console.error(`overlay: refilling the ${label} names cache failed (${errText(e)})`); return null; }
  };
  const r = refill || {};
  const [people, programs, venues, venueTypes] = await Promise.all([
    fill(PEOPLE_KV_KEY, 'people', () => fetchPeopleSlim(r.base, r.docId, r.auth)),
    fill(refKvKey('programs'), 'programs', () => fetchRefItems(r.base, r.docId, r.auth, 'programs')),
    fill(VENUES_KV_KEY, 'venues', () => fetchRefItems(r.base, r.docId, r.auth, 'venues')),
    fill(refKvKey('venue-types'), 'venueTypes', () => fetchRefItems(r.base, r.docId, r.auth, 'venue-types')),
  ]);
  const missing = [];
  const byName = (items, label, nameOf) => {
    if (!items) { missing.push(label); return {}; }
    return Object.fromEntries(items.filter((x) => x && x.id).map((x) => [x.id, nameOf(x)]));
  };
  const out = {
    people: byName(people, 'people', (p) => (p.values && p.values[PEOPLE_COLS.fullName]) || ''),
    programs: byName(programs, 'programs', (x) => x.name || ''),
    venues: byName(venues, 'venues', (x) => x.name || ''),
    venueTypes: byName(venueTypes, 'venueTypes', (x) => x.name || ''),
  };
  if (missing.length) console.error(`overlay: no KV names for ${missing.join(', ')}; their relation cells read as stale`);
  return out;
}

// Rows with the overlay merged (overlay.js mergeRows). Off: rows unchanged. A failed DO
// call (or column map, for planning) leaves rows unchanged with stale ['*'] and one line.
// opts.planning = {base, docId, auth} on planning reads: colMap + colKinds come from
// planningColMap, fetched only when a live entry needs merging.
// opts.want: the names caches this table's relations need (overlayNames), when known.
export async function overlayRead(env, tableId, rows, { shape, snapshotAt, now, colMap, colKinds, names, planning, want } = {}) {
  if (!overlayOn(env)) return { rows, stale: [] };
  let entries;
  try { entries = (await overlayCall(env, '/read', { tableId })).entries || []; }
  catch (e) { console.error(`overlay: read ${tableId} failed (${errText(e)}); rows unmerged`); return { rows, stale: ['*'] }; }
  if (!entries.some((e) => isLive(e, { snapshotAt, now }))) return { rows, stale: [] };
  if (planning && !colMap) {
    try { const m = await planningColMap(env, planning.base, planning.docId, tableId, planning.auth); colMap = m; colKinds = colKinds || m.colKinds; }
    catch (e) { console.error(`overlay: column map for ${tableId} failed (${errText(e)}); rows unmerged`); return { rows, stale: ['*'] }; }
  }
  return mergeRows(rows, entries, { shape, snapshotAt, now, colMap, colKinds, names: names || await overlayNames(env, planning, want), tableId });
}

// Does the overlay hold a live entry for `tableId` against a snapshot taken at `snapshotAt`?
// false when off; an overlay failure logs and answers false (the caller serves Coda's copy).
export async function overlayHasLive(env, tableId, snapshotAt) {
  if (!overlayOn(env)) return false;
  try {
    const entries = (await overlayCall(env, '/read', { tableId })).entries || [];
    const now = Date.now();
    return entries.some((e) => e.tableId === tableId && isLive(e, { snapshotAt, now }));
  } catch (e) { console.error(`overlay: read ${tableId} failed (${errText(e)}); Coda's copy served`); return false; }
}

// A list read (snapshot taken at `snapshotAt`) with the overlay merged; rows that couldn't be
// merged keep Coda's copy for those cells and get one console line (overlayRead logs outages).
// opts: shape ('rich' | 'id' | 'name'), planning ({base, docId, auth}: the planning table), want.
export async function mergedRows(env, tableId, items, snapshotAt, opts = {}) {
  return (await mergedRead(env, tableId, items, snapshotAt, opts)).rows;
}
// mergedRows plus the merge's pendingInserts (overlay.js): rows added from inserts Coda
// hasn't applied yet.
export async function mergedRead(env, tableId, items, snapshotAt, opts = {}) {
  const m = await overlayRead(env, tableId, items || [], { ...opts, snapshotAt, now: Date.now() });
  const rowsStale = m.stale.filter((x) => x !== '*');
  if (rowsStale.length) console.error(`overlay: ${tableId} ${rowsStale.length} row(s) stale (${rowsStale.slice(0, 5).join(', ')}); Coda's copy kept for their unmerged cells`);
  return { rows: m.rows, pendingInserts: m.pendingInserts || [] };
}
