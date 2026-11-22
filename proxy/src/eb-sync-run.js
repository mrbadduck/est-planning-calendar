// Eventbrite -> plan sync, the I/O half (§5.1–5.2): the webhook route, the
// 15-minute sweep and the one handler both call. The decisions are pure, in eb-sync.js.
// Worker var EB_SYNC_MODE = off | live gates both entry points (default off).
import {
  ebToFields, matchVenue, importCells, planFlowIn, removedCells, parseEbWebhook, syncDecision,
  sweepBatch, secretMatches, seenCells, sweepCandidates, stampPushAt, REMOVED_STATUS, IMPORTING,
} from './eb-sync.js';
import { PLANNING_COLS as C } from './coda-columns.js';
import { ebFetch, readAllRows, readEbPending, logPublishMany, bustEventCaches } from './worker-io.js';
import { rowToListingEvent, ebPendingKey } from './publish.js';
import { venueFromRow } from './venues.js';

const VENUES_TABLE = 'grid-foC40iAOaX';   // EST Venues SRC
// eb-row:<ebId> = IMPORTING once an import is requested (§5.2 step 3). Coda's upsert
// returns no row id, and applies ~28 s later: 10 minutes covers it with room to spare.
const IMPORT_MARKER_TTL = 600;
const rowMarkerKey = (ebId) => `eb-row:${ebId}`;
// Neither the webhook nor the sweep imports an event younger than this: a plan push
// may not have written its Eventbrite id onto its row yet, and the ebpending marker
// can be missed (KV is eventually consistent). A later sweep imports it.
const NEW_EVENT_MS = 10 * 60_000;
export const SWEEP_MAX_EVENTS = 8;        // keeps a run inside the free plan's 50 outbound calls
const SWEEP_CURSOR_KEY = 'eb-sweep-cursor';
const SWEEP_MAX_PAGES = 3;
const SWEEP_BACK_DAYS = 30;

const isLive = (env) => env.EB_SYNC_MODE === 'live';
const jsonRes = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
const cellStr = (v) => (v == null ? '' : Array.isArray(v) ? cellStr(v[0]) : String(v));
const note = (o) => { try { console.log('eb-sync', JSON.stringify(o)); } catch (_) {} };
const warn = (o) => { try { console.error('eb-sync', JSON.stringify(o)); } catch (_) {} };

function coda(env) {
  const base = env.CODA_API_BASE || 'https://coda.io/apis/v1', docId = env.CODA_DOC_ID;
  const auth = { Authorization: `Bearer ${env.CODA_API_TOKEN}`, 'Content-Type': 'application/json' };
  return { base, docId, auth, rowsUrl: `${base}/docs/${docId}/tables/${env.CODA_TABLE_ID}/rows` };
}
const todayIn = (tz, d = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: tz || 'America/Chicago' }).format(d);

async function kvGet(env, key) {
  const kv = env.CACHE; if (!kv) return null;
  try { return await kv.get(key); } catch (err) { warn({ kvGet: key, error: String((err && err.message) || err) }); return null; }
}
async function kvPut(env, key, value, opts) {
  const kv = env.CACHE; if (!kv) return;
  try { await kv.put(key, value, opts); } catch (err) { warn({ kvPut: key, error: String((err && err.message) || err) }); }
}

// A plan push in flight whose row hasn't applied its new Eventbrite id yet: only the
// ebpending marker knows the event. Second guard behind the webhook's new-event rule
// (KV is eventually consistent, so this can miss). Import path only: KV list is rationed.
async function pendingRowForEb(env, ebId) {
  const kv = env.CACHE; if (!kv || !kv.list) return null;
  try {
    const prefix = ebPendingKey('');
    const { keys } = await kv.list({ prefix });
    for (const { name } of keys || []) {
      const m = await kv.get(name, 'json');
      if (m && String(m.ebId || '') === ebId) return name.slice(prefix.length);
    }
  } catch (err) { warn({ ebId, pendingScan: String((err && err.message) || err) }); }
  return null;
}

// EST Venues SRC, read once per run and shared (ctx.venues).
async function loadVenues(c, ctx) {
  if (ctx.venues) return ctx.venues;
  const r = await readAllRows(`${c.base}/docs/${c.docId}/tables/${VENUES_TABLE}/rows`, c.auth, { byId: true });
  if (!r.ok) throw new Error(`could not read Venues (Coda ${r.resp && r.resp.status})`);
  ctx.venues = r.items.map(venueFromRow);
  return ctx.venues;
}

// The planning rows holding one Eventbrite id: a Coda query on that column (id-keyed).
async function rowsForEb(c, ebId) {
  const u = new URL(c.rowsUrl);
  u.searchParams.set('useColumnNames', 'false');
  u.searchParams.set('valueFormat', 'simpleWithArrays');
  u.searchParams.set('query', `${C.eventbriteId}:${JSON.stringify(ebId)}`);
  const r = await fetch(u.toString(), { headers: c.auth });
  if (!r.ok) return { ok: false, status: r.status };
  const j = await r.json();
  return { ok: true, items: (j && j.items) || [] };
}

// The one handler: one Eventbrite event id -> import, flow-in, removed, skip or error.
// ctx (sweep only): { body } reuses a listed event, { rows } shares one row read,
// { logs } collects Publish Log records for one insert at the end of the run.
// Without ctx.logs, this call writes its own record(s) in one insert.
// Never throws: every failure ends in a Publish Log record (or a console line).
export async function syncEbEvent(env, ebId, via, ctx = {}) {
  const c = coda(env);
  const own = !Array.isArray(ctx.logs);
  const logs = own ? [] : ctx.logs;
  const log = (rec) => { logs.push({ via, ebId, ...rec }); };
  try {
    return await handle(env, c, ebId, via, ctx, log);
  } catch (err) {
    const msg = String((err && err.message) || err);
    warn({ ebId, via, error: msg });
    log({ action: 'exception', ok: false, status: 0, message: msg });
    return { action: 'error' };
  } finally {
    if (own) await logPublishMany(env, c.base, c.docId, c.auth, logs);
  }
}

async function handle(env, c, ebId, via, ctx, log) {
  // 1. The event, fetched with our own token (the webhook body is not trusted).
  let body = ctx.body || null, ebStatus = 200;
  if (!body) {
    const r = await ebFetch(env, `/events/${ebId}/?expand=venue,ticket_classes`);
    ebStatus = r.status;
    if (r.ok) body = r.body;
    else if (r.status !== 404) {
      log({ action: 'error', ok: false, status: r.status, message: `Eventbrite read failed (${r.status})` });
      return { action: 'error' };
    }
  }
  if (body && String(body.organization_id || '') !== String(env.EVENTBRITE_ORG_ID || '')) {
    note({ ebId, via, ignored: 'other organization' });
    return { action: 'ignored' };
  }

  // 2. The planning rows holding this id. The sweep shares its one full read; a
  //    webhook asks Coda for just this id.
  let rows = ctx.rows;
  if (!rows) {
    const rr = await rowsForEb(c, ebId);
    if (!rr.ok) {
      log({ action: 'error', ok: false, status: rr.status, message: `Could not read planning rows (Coda ${rr.status})` });
      return { action: 'error' };
    }
    rows = rr.items;
  }
  const rowsWithId = rows.filter((r) => cellStr(r.values && r.values[C.eventbriteId]) === ebId);

  // 3. Deleted on Eventbrite: mark the row, keep its id.
  if (!body) {
    if (rowsWithId.length !== 1) {
      if (rowsWithId.length > 1) log({ action: 'error', ok: false, status: ebStatus, message: `Gone from Eventbrite but ${rowsWithId.length} planning rows hold its id; nothing changed` });
      return { action: rowsWithId.length ? 'error' : 'ignored' };
    }
    const row = rowsWithId[0];
    if (cellStr(row.values[C.publishStatus]) === REMOVED_STATUS) return { action: 'unchanged', rowId: row.id };
    if (cellStr(row.values[C.status]) === 'Cancelled') {   // C1: plan-owned; the sweep skips it after this
      log({ rowId: row.id, action: 'removed', ok: true, status: ebStatus, message: 'Event deleted on Eventbrite; the row is Cancelled in plan, so nothing changed' });
      return { action: 'unchanged', rowId: row.id };
    }
    const put = await fetch(`${c.rowsUrl}/${encodeURIComponent(row.id)}`, { method: 'PUT', headers: c.auth, body: JSON.stringify({ row: { cells: removedCells() } }) });
    if (put.ok) await bustEventCaches(env);
    log({ rowId: row.id, action: 'removed', ok: put.ok, status: put.status, message: put.ok ? 'Event deleted on Eventbrite' : `Could not mark the row removed (Coda ${put.status})` });
    return { action: put.ok ? 'removed' : 'error', rowId: row.id };
  }

  const sc = await ebFetch(env, `/events/${ebId}/structured_content/`);
  if (!sc.ok && sc.status !== 404) {   // 404: the event has no description yet
    log({ action: 'error', ok: false, status: sc.status, message: `Eventbrite description read failed (${sc.status})` });
    return { action: 'error' };
  }
  const fields = ebToFields(body, sc.ok ? sc.body : null);
  if (!fields) { note({ ebId, via, ignored: 'series parent' }); return { action: 'ignored' }; }

  // 4. Decide.
  const markerRowId = await kvGet(env, rowMarkerKey(ebId));
  let rowId = rowsWithId.length === 1 ? rowsWithId[0].id : (markerRowId && markerRowId !== IMPORTING ? markerRowId : null);
  let pending = rowId ? await readEbPending(env, rowId) : null;
  if (!rowId && !rowsWithId.length && !markerRowId) {   // our own push, its id not applied to the row yet?
    const pr = await pendingRowForEb(env, ebId);
    if (pr) { rowId = pr; pending = { ebId }; }
  }
  const decision = syncDecision({ rowsWithId, markerRowId, pending, noImport: ctx.noImport === true });
  const nowIso = new Date().toISOString();

  if (decision === 'skip') {
    note({ ebId, via, skip: pending ? 'plan push in flight' : (markerRowId === IMPORTING ? 'import still applying' : 'no imports this run (row read truncated)'), rowId });
    return { action: 'skip', rowId };
  }
  if (decision === 'error') {
    log({ action: 'error', ok: false, status: 0, message: `${rowsWithId.length} planning rows hold this Eventbrite id; nothing changed` });
    return { action: 'error' };
  }

  if (decision === 'import') {
    const created = Date.parse(body.created || '');
    if (!(Date.now() - created >= NEW_EVENT_MS)) {   // unknown age counts as new
      note({ ebId, via, skip: 'new event; a later sweep imports it' });   // console only
      return { action: 'skip' };
    }
    const venueMatch = fields.ebVenueId ? matchVenue(fields.ebVenueId, await loadVenues(c, ctx)) : matchVenue('', []);
    const cells = stampPushAt(importCells(fields, venueMatch, nowIso), fields.changed);
    const r = await fetch(c.rowsUrl, { method: 'POST', headers: c.auth,
      body: JSON.stringify({ rows: [{ cells }], keyColumns: [C.eventbriteId] }) });
    if (!r.ok) {
      log({ action: 'import', ok: false, status: r.status, ebUrl: fields.url, message: `Import failed (Coda ${r.status})` });
      return { action: 'error' };
    }
    // With keyColumns set Coda returns no addedRowIds: the row id isn't known until it applies.
    let requestId = ''; try { requestId = ((await r.json()) || {}).requestId || ''; } catch (_) {}
    await kvPut(env, rowMarkerKey(ebId), IMPORTING, { expirationTtl: IMPORT_MARKER_TTL });
    await bustEventCaches(env);
    log({ action: 'import', ok: true, status: r.status, ebUrl: fields.url, message: `Import requested for "${fields.title}" (Coda ${requestId || 'no requestId'})` });
    return { action: 'import' };
  }

  // flow-in: the row, name-keyed (rowToListingEvent's shape).
  const one = await fetch(`${c.rowsUrl}/${encodeURIComponent(rowId)}?useColumnNames=true&valueFormat=simpleWithArrays`, { headers: c.auth });
  if (one.status === 404) {   // a fresh insert Coda hasn't applied yet: the next sweep covers it
    log({ rowId, action: 'skip', ok: true, status: 404, message: 'Row not visible yet (Coda apply lag); left for the next sweep' });
    return { action: 'skip', rowId };
  }
  if (!one.ok) {
    log({ rowId, action: 'error', ok: false, status: one.status, message: `Could not read the planning row (Coda ${one.status})` });
    return { action: 'error', rowId };
  }
  const rowEv = rowToListingEvent(((await one.json()) || {}).values || {});
  const venueMatch = fields.ebVenueId ? matchVenue(fields.ebVenueId, await loadVenues(c, ctx)) : matchVenue('', []);
  const plan = planFlowIn(rowEv, fields, venueMatch, nowIso);
  const base = plan.cells.length ? plan.cells : seenCells(rowEv, fields);
  let putStatus = 0;
  if (base.length) {
    // A conflict keeps Last EB push at where it was, so the publish guard still warns
    // the lead before their next push overwrites Eventbrite's conflicting edit.
    const cells = plan.conflicts.length ? base : stampPushAt(base, fields.changed);
    const put = await fetch(`${c.rowsUrl}/${encodeURIComponent(rowId)}`, { method: 'PUT', headers: c.auth, body: JSON.stringify({ row: { cells } }) });
    putStatus = put.status;
    if (!put.ok) {
      log({ rowId, action: 'flow-in', ok: false, status: put.status, message: `Flow-in write failed (Coda ${put.status})` });
      return { action: 'error', rowId };
    }
    await bustEventCaches(env);
  }
  // One record per event: a conflict rides on its flow-in.
  const kept = plan.conflicts.length ? `Edited in plan and on Eventbrite; plan kept: ${plan.conflicts.join(', ')}` : '';
  if (plan.changed.length) {
    log({ rowId, action: 'flow-in', ok: true, status: putStatus, ebUrl: fields.url,
      message: `Changed on Eventbrite: ${plan.changed.join(', ')}${kept ? `. ${kept}` : ''}` });
  } else if (kept) {
    log({ rowId, action: 'conflict', ok: true, status: putStatus, ebUrl: fields.url, message: kept });
  }
  return { action: plan.changed.length ? 'flowin' : 'unchanged', rowId, changed: plan.changed, conflicts: plan.conflicts };
}

// POST /webhooks/eventbrite/:secret (rawSecret is the undecoded path segment). A wrong
// or malformed secret is a 404, so the route can't be probed. Answers 200 at once;
// the sync runs in ctx.waitUntil.
export async function ebWebhook(request, env, ctx, rawSecret) {
  let secret; try { secret = decodeURIComponent(rawSecret || ''); } catch (_) { secret = null; }
  if (secret == null || !secretMatches(secret, env.EB_WEBHOOK_SECRET)) return new Response('Not found', { status: 404 });
  if (!isLive(env)) return jsonRes({ ok: true, mode: 'off' });
  let body = null; try { body = JSON.parse((await request.text()) || '{}'); } catch (_) {}
  const ebId = parseEbWebhook(body);
  if (!ebId) return jsonRes({ ok: true, ignored: true });
  ctx.waitUntil(syncEbEvent(env, ebId, 'eventbrite'));
  return jsonRes({ ok: true });
}

// The sweep (cron, every 15 minutes). Lists EST's events (every status) newest-start
// first, stopping once start is more than 30 days back; hands each event that needs
// work to the handler, at most SWEEP_MAX_EVENTS per run, resuming from KV
// eb-sweep-cursor next run. All Publish Log records go in one insert at the end.
export async function runSweep(env) {
  const out = { seen: 0, imported: 0, flowedIn: 0 };
  if (!isLive(env)) return out;
  const c = coda(env), logs = [];
  try {
    const tz = env.EVENTBRITE_TZ || 'America/Chicago';
    const today = todayIn(tz);
    const cutoff = todayIn(tz, new Date(Date.now() - SWEEP_BACK_DAYS * 86400_000));
    const listed = [];
    let continuation = null, pages = 0, done = false;
    do {
      const q = continuation ? `&continuation=${encodeURIComponent(continuation)}` : '';
      const r = await ebFetch(env, `/organizations/${env.EVENTBRITE_ORG_ID}/events/?order_by=start_desc&expand=venue,ticket_classes&status=all${q}`, 'GET', undefined, { quiet: true });
      if (!r.ok) { warn({ sweep: 'listing failed', status: r.status }); return out; }
      for (const ev of (r.body && r.body.events) || []) {
        if (String((ev.start && ev.start.local) || '').slice(0, 10) < cutoff) { done = true; break; }
        listed.push(ev);
      }
      const p = (r.body && r.body.pagination) || {};
      continuation = p.has_more_items ? p.continuation : null;
    } while (!done && continuation && ++pages < SWEEP_MAX_PAGES);
    out.seen = listed.length;

    const rr = await readAllRows(c.rowsUrl, c.auth, { byId: true });
    if (!rr.ok) { warn({ sweep: 'row read failed', status: rr.resp && rr.resp.status }); return out; }
    if (rr.truncated) {   // M4: rows past the cap look unlinked, so importing could duplicate them
      const message = `Planning row read stopped at its page cap (${rr.items.length} rows): no imports this run; changes to rows it read still flow in`;
      warn({ sweep: message });
      logs.push({ via: 'sweep', action: 'skip', ok: false, status: 0, message });
    }
    const candidates = sweepCandidates({ listed, rows: rr.items, today });
    const { batch, nextCursor } = sweepBatch(candidates, await kvGet(env, SWEEP_CURSOR_KEY), SWEEP_MAX_EVENTS);
    const shared = { rows: rr.items, logs, noImport: !!rr.truncated };   // one object: the Venues read and the log are shared too
    for (const cand of batch) {
      shared.body = cand.body;
      const res = await syncEbEvent(env, cand.ebId, 'sweep', shared);
      if (res.action === 'import') out.imported++;
      if (res.action === 'flowin') out.flowedIn++;
    }
    if (nextCursor == null) { try { if (env.CACHE) await env.CACHE.delete(SWEEP_CURSOR_KEY); } catch (err) { warn({ kvDelete: SWEEP_CURSOR_KEY, error: String((err && err.message) || err) }); } }
    else await kvPut(env, SWEEP_CURSOR_KEY, String(nextCursor));
    note({ sweep: out, candidates: candidates.length, batch: batch.length, nextCursor });
  } catch (err) {
    warn({ sweep: 'exception', error: String((err && err.message) || err) });
  } finally {
    await logPublishMany(env, c.base, c.docId, c.auth, logs);
  }
  return out;
}
