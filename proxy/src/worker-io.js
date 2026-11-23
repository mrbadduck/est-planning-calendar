/**
 * Shared Worker I/O helpers: KV cache bust, Coda row reads, the Eventbrite v3
 * client, the Eventbrite-pending marker and the Publish Log writer. Moved out of
 * worker.js so the sync modules can import them. Behavior unchanged.
 */
import { ebPendingKey, EB_PENDING_TTL } from './publish.js';

export async function swrBust(env, key) {
  const kv = env.CACHE; if (!kv) return;
  try { await kv.delete(key); } catch (_) {}
}
export const ROWS_KV_KEY = 'rows-v1';
export const GATHER_KV_KEY = 'gather-events-v1';   // gatherSnapshot of upcoming events + slots + claims
// Anything that changes an event, slot or claim busts both event-derived snapshots.
export async function bustEventCaches(env) {
  await Promise.all([swrBust(env, ROWS_KV_KEY), swrBust(env, GATHER_KV_KEY)]);
}
// After a claim or slot write Coda accepts it now but applies it ~28 s later, so a re-read
// in between would refill the snapshot without the write: bust now and again after apply.
export async function bustEventCachesNowAndAfterApply(env, ctx, delayMs = 28_000) {
  await bustEventCaches(env);
  if (ctx) ctx.waitUntil(new Promise((r) => setTimeout(r, delayMs)).then(() => bustEventCaches(env)));
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

