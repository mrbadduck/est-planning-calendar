// Eventbrite -> plan sync, the I/O half (§5.1–5.2): the webhook route, the hourly
// sweep and the one handler both call. The decisions are pure, in eb-sync.js.
// Worker var EB_SYNC_MODE = off | live gates both entry points (default off).
import {
  ebToFields, matchVenue, importCells, planFlowIn, removedCells, parseEbWebhook, syncDecision,
  sweepBatch, secretMatches, seenCells, sweepCandidates, REMOVED_STATUS,
} from './eb-sync.js';
import { PLANNING_COLS as C } from './coda-columns.js';
import { ebFetch, readAllRows, readEbPending, logPublish, bustEventCaches } from './worker-io.js';
import { rowToListingEvent, ebPendingKey } from './publish.js';
import { venueFromRow } from './venues.js';

const VENUES_TABLE = 'grid-foC40iAOaX';   // EST Venues SRC
const ROW_MARKER_TTL = 3600;              // eb-row:<ebId> -> rowId, written at insert (§5.2 step 3)
const rowMarkerKey = (ebId) => `eb-row:${ebId}`;
export const SWEEP_MAX_EVENTS = 8;        // keeps a run inside the free plan's 50 outbound calls
const SWEEP_CURSOR_KEY = 'eb-sweep-cursor';
const SWEEP_MAX_PAGES = 3;
const SWEEP_BACK_DAYS = 30;

const isLive = (env) => env.EB_SYNC_MODE === 'live';
const jsonRes = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
const cellStr = (v) => (v == null ? '' : Array.isArray(v) ? cellStr(v[0]) : String(v));

function coda(env) {
  const base = env.CODA_API_BASE || 'https://coda.io/apis/v1', docId = env.CODA_DOC_ID;
  const auth = { Authorization: `Bearer ${env.CODA_API_TOKEN}`, 'Content-Type': 'application/json' };
  return { base, docId, auth, rowsUrl: `${base}/docs/${docId}/tables/${env.CODA_TABLE_ID}/rows` };
}
const todayIn = (tz, d = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: tz || 'America/Chicago' }).format(d);

async function kvGet(env, key) {
  const kv = env.CACHE; if (!kv) return null;
  try { return await kv.get(key); } catch (_) { return null; }
}
async function kvPut(env, key, value, opts) {
  const kv = env.CACHE; if (!kv) return;
  try { await kv.put(key, value, opts); } catch (_) {}
}

// A plan push in flight whose row hasn't applied its new Eventbrite id yet: only the
// ebpending marker knows the event. Read on the import path only (KV list is rationed).
async function pendingRowForEb(env, ebId) {
  const kv = env.CACHE; if (!kv || !kv.list) return null;
  try {
    const prefix = ebPendingKey('');
    const { keys } = await kv.list({ prefix });
    for (const { name } of keys || []) {
      const m = await kv.get(name, 'json');
      if (m && String(m.ebId || '') === ebId) return name.slice(prefix.length);
    }
  } catch (_) {}
  return null;
}

// EST Venues SRC, read once per run and shared (ctx.venues).
async function loadVenues(env, c, ctx) {
  if (ctx.venues) return ctx.venues;
  const r = await readAllRows(`${c.base}/docs/${c.docId}/tables/${VENUES_TABLE}/rows`, c.auth, { byId: true });
  if (!r.ok) throw new Error(`could not read Venues (Coda ${r.resp && r.resp.status})`);
  ctx.venues = r.items.map(venueFromRow);
  return ctx.venues;
}

// The one handler: one Eventbrite event id -> import, flow-in, removed, skip or error.
// ctx (sweep only): { body } reuses a listed event; { rows } shares one row read.
// Never throws: every failure ends in a Publish Log row (or a console line).
export async function syncEbEvent(env, ebId, via, ctx = {}) {
  const c = coda(env);
  const log = (rec) => logPublish(env, c.base, c.docId, c.auth, { via, ebId, ...rec });
  try {
    // 1. The event, fetched with our own token (the webhook body is not trusted).
    let body = ctx.body || null, ebStatus = 200;
    if (!body) {
      const r = await ebFetch(env, `/events/${ebId}/?expand=venue,ticket_classes`);
      ebStatus = r.status;
      if (r.ok) body = r.body;
      else if (r.status !== 404) {
        await log({ action: 'error', ok: false, status: r.status, message: `Eventbrite read failed (${r.status})` });
        return { action: 'error' };
      }
    }
    if (body && String(body.organization_id || '') !== String(env.EVENTBRITE_ORG_ID || '')) {
      console.log('eb-sync', JSON.stringify({ ebId, via, ignored: 'other organization' }));
      return { action: 'ignored' };
    }

    // 2. The planning rows holding this id (one id-keyed read; the sweep shares its own).
    let rows = ctx.rows;
    if (!rows) {
      const rr = await readAllRows(c.rowsUrl, c.auth, { byId: true });
      if (!rr.ok) {
        await log({ action: 'error', ok: false, status: rr.resp && rr.resp.status, message: 'Could not read planning rows' });
        return { action: 'error' };
      }
      rows = rr.items;
    }
    const rowsWithId = rows.filter((r) => cellStr(r.values && r.values[C.eventbriteId]) === ebId);

    // 3. Deleted on Eventbrite: mark the row, keep its id.
    if (!body) {
      if (rowsWithId.length !== 1) {
        if (rowsWithId.length > 1) await log({ action: 'error', ok: false, status: ebStatus, message: `Gone from Eventbrite but ${rowsWithId.length} planning rows hold its id; nothing changed` });
        return { action: rowsWithId.length ? 'error' : 'ignored' };
      }
      const row = rowsWithId[0];
      if (cellStr(row.values[C.publishStatus]) === REMOVED_STATUS) return { action: 'unchanged', rowId: row.id };
      const put = await fetch(`${c.rowsUrl}/${encodeURIComponent(row.id)}`, { method: 'PUT', headers: c.auth, body: JSON.stringify({ row: { cells: removedCells() } }) });
      if (put.ok) await bustEventCaches(env);
      await log({ rowId: row.id, action: 'removed', ok: put.ok, status: put.status, message: put.ok ? 'Event deleted on Eventbrite' : `Could not mark the row removed (Coda ${put.status})` });
      return { action: put.ok ? 'removed' : 'error', rowId: row.id };
    }

    const sc = await ebFetch(env, `/events/${ebId}/structured_content/`);
    if (!sc.ok && sc.status !== 404) {   // 404: the event has no description yet
      await log({ action: 'error', ok: false, status: sc.status, message: `Eventbrite description read failed (${sc.status})` });
      return { action: 'error' };
    }
    const fields = ebToFields(body, sc.ok ? sc.body : null);
    if (!fields) return { action: 'ignored' };   // a series parent has no dates of its own

    // 4. Decide.
    const markerRowId = await kvGet(env, rowMarkerKey(ebId));
    let rowId = rowsWithId.length === 1 ? rowsWithId[0].id : (markerRowId || null);
    let pending = rowId ? await readEbPending(env, rowId) : null;
    if (!rowId && !rowsWithId.length) {   // our own push, its id not applied to the row yet?
      const pr = await pendingRowForEb(env, ebId);
      if (pr) { rowId = pr; pending = { ebId }; }
    }
    const decision = syncDecision({ rowsWithId, markerRowId, pending });
    const nowIso = new Date().toISOString();

    if (decision === 'skip') return { action: 'skip', rowId };
    if (decision === 'error') {
      await log({ action: 'error', ok: false, status: 0, message: `${rowsWithId.length} planning rows hold this Eventbrite id; nothing changed` });
      return { action: 'error' };
    }
    const venueMatch = fields.ebVenueId ? matchVenue(fields.ebVenueId, await loadVenues(env, c, ctx)) : matchVenue('', []);

    if (decision === 'import') {
      const r = await fetch(c.rowsUrl, { method: 'POST', headers: c.auth,
        body: JSON.stringify({ rows: [{ cells: importCells(fields, venueMatch, nowIso) }], keyColumns: [C.eventbriteId] }) });
      let j = null; try { j = await r.json(); } catch (_) {}
      const newId = (j && Array.isArray(j.addedRowIds) && j.addedRowIds[0]) || null;
      if (r.ok) await bustEventCaches(env);
      if (!r.ok) {
        await log({ action: 'import', ok: false, status: r.status, ebUrl: fields.url, message: `Import failed (Coda ${r.status})` });
        return { action: 'error' };
      }
      if (!newId) {   // the upsert matched a row we couldn't see: a race; no marker
        await log({ action: 'import', ok: false, status: r.status, ebUrl: fields.url, message: 'Import matched an existing row (race); no marker written' });
        return { action: 'error' };
      }
      await kvPut(env, rowMarkerKey(ebId), newId, { expirationTtl: ROW_MARKER_TTL });
      await log({ rowId: newId, action: 'import', ok: true, status: r.status, ebUrl: fields.url, message: `Imported "${fields.title}"` });
      return { action: 'import', rowId: newId };
    }

    // flow-in: the row, name-keyed (rowToListingEvent's shape).
    const one = await fetch(`${c.rowsUrl}/${encodeURIComponent(rowId)}?useColumnNames=true&valueFormat=simpleWithArrays`, { headers: c.auth });
    if (one.status === 404) {   // a fresh insert Coda hasn't applied yet: the next sweep covers it
      await log({ rowId, action: 'skip', ok: true, status: 404, message: 'Row not visible yet (Coda apply lag); left for the next sweep' });
      return { action: 'skip', rowId };
    }
    if (!one.ok) {
      await log({ rowId, action: 'error', ok: false, status: one.status, message: `Could not read the planning row (Coda ${one.status})` });
      return { action: 'error', rowId };
    }
    const rowEv = rowToListingEvent(((await one.json()) || {}).values || {});
    const plan = planFlowIn(rowEv, fields, venueMatch, nowIso);
    const cells = plan.cells.length ? plan.cells : seenCells(rowEv, fields);
    if (cells.length) {
      const put = await fetch(`${c.rowsUrl}/${encodeURIComponent(rowId)}`, { method: 'PUT', headers: c.auth, body: JSON.stringify({ row: { cells } }) });
      if (!put.ok) {
        await log({ rowId, action: 'flow-in', ok: false, status: put.status, message: `Flow-in write failed (Coda ${put.status})` });
        return { action: 'error', rowId };
      }
      await bustEventCaches(env);
      if (plan.changed.length) await log({ rowId, action: 'flow-in', ok: true, status: put.status, ebUrl: fields.url, message: `Changed on Eventbrite: ${plan.changed.join(', ')}` });
    }
    if (plan.conflicts.length) await log({ rowId, action: 'conflict', ok: true, status: 0, ebUrl: fields.url, message: `Edited in plan and on Eventbrite; plan kept: ${plan.conflicts.join(', ')}` });
    return { action: plan.changed.length ? 'flowin' : 'unchanged', rowId, changed: plan.changed, conflicts: plan.conflicts };
  } catch (err) {
    const msg = String((err && err.message) || err);
    try { console.error('eb-sync', JSON.stringify({ ebId, via, error: msg })); } catch (_) {}
    try { await log({ action: 'exception', ok: false, status: 0, message: msg }); } catch (_) {}
    return { action: 'error' };
  }
}

// POST /webhooks/eventbrite/:secret. A wrong secret is a 404, so the route can't be
// probed. Answers 200 at once; the sync runs in ctx.waitUntil.
export async function ebWebhook(request, env, ctx, secret) {
  if (!secretMatches(secret, env.EB_WEBHOOK_SECRET)) return new Response('Not found', { status: 404 });
  if (!isLive(env)) return jsonRes({ ok: true, mode: 'off' });
  let body = null; try { body = JSON.parse((await request.text()) || '{}'); } catch (_) {}
  const ebId = parseEbWebhook(body);
  if (!ebId) return jsonRes({ ok: true, ignored: true });
  ctx.waitUntil(syncEbEvent(env, ebId, 'eventbrite'));
  return jsonRes({ ok: true });
}

// The hourly sweep (cron). Lists EST's events newest-start first, stopping once
// start is more than 30 days back; hands each event that needs work to the handler,
// at most SWEEP_MAX_EVENTS per run, resuming from KV eb-sweep-cursor next hour.
export async function runSweep(env) {
  const out = { seen: 0, imported: 0, flowedIn: 0 };
  if (!isLive(env)) return out;
  try {
    const c = coda(env), tz = env.EVENTBRITE_TZ || 'America/Chicago';
    const today = todayIn(tz);
    const cutoff = todayIn(tz, new Date(Date.now() - SWEEP_BACK_DAYS * 86400_000));
    const listed = [];
    let continuation = null, pages = 0, done = false;
    do {
      const q = continuation ? `&continuation=${encodeURIComponent(continuation)}` : '';
      const r = await ebFetch(env, `/organizations/${env.EVENTBRITE_ORG_ID}/events/?order_by=start_desc&expand=venue,ticket_classes${q}`, 'GET', undefined, { quiet: true });
      if (!r.ok) { console.error('eb-sweep', JSON.stringify({ listing: r.status })); return out; }
      for (const ev of (r.body && r.body.events) || []) {
        if (String((ev.start && ev.start.local) || '').slice(0, 10) < cutoff) { done = true; break; }
        listed.push(ev);
      }
      const p = (r.body && r.body.pagination) || {};
      continuation = p.has_more_items ? p.continuation : null;
    } while (!done && continuation && ++pages < SWEEP_MAX_PAGES);
    out.seen = listed.length;

    const rr = await readAllRows(c.rowsUrl, c.auth, { byId: true });
    if (!rr.ok) { console.error('eb-sweep', JSON.stringify({ rows: rr.resp && rr.resp.status })); return out; }
    const candidates = sweepCandidates({ listed, rows: rr.items, today });
    const { batch, nextCursor } = sweepBatch(candidates, await kvGet(env, SWEEP_CURSOR_KEY), SWEEP_MAX_EVENTS);
    const shared = { rows: rr.items };
    for (const cand of batch) {
      shared.body = cand.body;   // same object each time, so the Venues read is shared too
      const res = await syncEbEvent(env, cand.ebId, 'sweep', shared);
      if (res.action === 'import') out.imported++;
      if (res.action === 'flowin') out.flowedIn++;
    }
    if (nextCursor == null) { try { if (env.CACHE) await env.CACHE.delete(SWEEP_CURSOR_KEY); } catch (_) {} }
    else await kvPut(env, SWEEP_CURSOR_KEY, String(nextCursor));
    console.log('eb-sweep', JSON.stringify({ ...out, candidates: candidates.length, batch: batch.length, nextCursor }));
  } catch (err) {
    try { console.error('eb-sweep', JSON.stringify({ error: String((err && err.message) || err) })); } catch (_) {}
  }
  return out;
}
