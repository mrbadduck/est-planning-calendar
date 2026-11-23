// Google Calendar from the Worker, the I/O half (spec §6): one row after a lead-facing
// route succeeds (syncGcal) and the cron sweep (sweepGcal). The rules are pure, in gcal.js.
// Worker var GCAL_MODE = off | shadow | live (default off); GCAL_CALENDAR_ID unset counts as off.
// Neither function throws: every failure ends in a Publish Log record or a console line.
import { onCalendar, inSyncWindow, gcalPlan, gcalModeAction, afterGcalResponse } from './gcal.js';
import { googleAccessToken } from './google-auth.js';
import { sweepBatch } from './eb-sync.js';
import { PLANNING_COLS as C } from './coda-columns.js';
import { readAllRows, logPublishMany, bustEventCaches } from './worker-io.js';
import { rowToListingEvent, effectiveAddressVisibility } from './publish.js';
import { venueFromRow } from './venues.js';
import '../../web/venue-address.js';   // globalThis.VenueAddress

export const GCAL_SWEEP_MAX = 15;               // operations per sweep run
export const GCAL_CRON = '3,18,33,48 * * * *';  // its own invocation, never the Eventbrite sweep's
const CURSOR_KEY = 'gcal-sweep-cursor';
const TOKEN_KEY = 'gcal-token';                 // google-auth.js caches the access token here
const hashKey = (rowId) => `gcal-hash:${rowId}`;   // {id, hash}: the event and body the Worker last wrote
const VENUES_TABLE = 'grid-foC40iAOaX';         // EST Venues SRC
const GCAL_API = 'https://www.googleapis.com/calendar/v3';
const TARGET = 'Google Calendar';
const ACTION = { insert: 'gcal-insert', patch: 'gcal-update', delete: 'gcal-delete' };
const VERB = { insert: 'add', patch: 'update', delete: 'remove' };
// The free plan allows 50 outbound calls per invocation. The sweep reserves the
// worst case up front: readAllRows' 6 row pages, 1 Venues page, 1 Publish Log insert.
const CALL_LIMIT = 50;
const ROW_READ_CALLS = 6;

const str = (v) => (v == null ? '' : Array.isArray(v) ? str(v[0]) : typeof v === 'object' ? String(v.url || v.name || '') : String(v));
const warn = (o) => { try { console.error('gcal', JSON.stringify(o)); } catch (_) {} };
const note = (o) => { try { console.log('gcal', JSON.stringify(o)); } catch (_) {} };
const errMsg = (err) => String((err && err.message) || err);

function coda(env) {
  const base = env.CODA_API_BASE || 'https://coda.io/apis/v1', docId = env.CODA_DOC_ID;
  const auth = { Authorization: `Bearer ${env.CODA_API_TOKEN}`, 'Content-Type': 'application/json' };
  return { base, docId, auth, rowsUrl: `${base}/docs/${docId}/tables/${env.CODA_TABLE_ID}/rows` };
}
const todayIn = (tz) => new Intl.DateTimeFormat('en-CA', { timeZone: tz || 'America/Chicago' }).format(new Date());

function gcalMode(env) {
  const m = env.GCAL_MODE === 'live' || env.GCAL_MODE === 'shadow' ? env.GCAL_MODE : 'off';
  if (m !== 'off' && !env.GCAL_CALENDAR_ID) { warn({ mode: m, off: 'GCAL_CALENDAR_ID is not set; Google Calendar sync is off' }); return 'off'; }
  return m;
}
const gcalOpts = (env) => ({
  tz: env.EVENTBRITE_TZ || 'America/Chicago',
  gatherBase: env.GATHER_BASE || 'https://gather.eastsidetribe.org',
  area: `${env.EVENTBRITE_AREA_CITY}, ${env.EVENTBRITE_AREA_REGION}`,
});

/** Name-keyed planning row -> the event gcal.js reads (venueAddress comes from withVenue). */
export function gcalEventFromRow(rowId, V) {
  const v = V || {};
  return {
    ...rowToListingEvent(v), rowId,
    publishStatus: str(v['Publish status']), eventbriteUrl: str(v['Eventbrite URL']), gcalEventId: str(v['gCal Event ID']),
  };
}

// The venue's composed address, and the Address visibility the publish route uses (R14:
// blank at a home is Registrants only), so the sweep and the routes build the same body.
// The Venue cell of a name-keyed row is the venue's name (unique, as POST /venues enforces).
function withVenue(ev, venues) {
  const hit = ev.venueName ? venues.find((v) => v.name === String(ev.venueName)) || null : null;
  const venue = ev.venueName ? { name: ev.venueName, type: hit ? hit.type : '', hasAddress: !!hit && globalThis.VenueAddress.hasAddress(hit) } : null;
  return { ...ev, venueAddress: hit ? hit.address : '', addressVisibility: effectiveAddressVisibility(ev.addressVisibility, venue) };
}
async function loadVenues(c) {
  const r = await readAllRows(`${c.base}/docs/${c.docId}/tables/${VENUES_TABLE}/rows`, c.auth, { byId: true });
  if (!r.ok) throw new Error(`Could not read Venues (Coda ${r.resp && r.resp.status})`);
  return r.items.map(venueFromRow);
}

async function readState(env, rowId) {
  const kv = env.CACHE; if (!kv) return null;
  try { return await kv.get(hashKey(rowId), 'json'); } catch (err) { warn({ kvGet: hashKey(rowId), error: errMsg(err) }); return null; }
}
async function kvPut(env, key, value) {
  const kv = env.CACHE; if (!kv) return;
  try { await kv.put(key, value); } catch (err) { warn({ kvPut: key, error: errMsg(err) }); }
}
async function kvDelete(env, key) {
  const kv = env.CACHE; if (!kv) return;
  try { await kv.delete(key); } catch (err) { warn({ kvDelete: key, error: errMsg(err) }); }
}

// One Google client per run: the token is fetched once; a 401 clears the cached token
// and retries once per run. `calls` counts outbound calls for the sweep's budget.
const googleClient = (env) => ({ env, token: null, retried: false, tokenError: null, calls: 0 });
async function gfetch(g, method, path, body) {
  for (;;) {
    if (!g.token) {
      g.calls++;   // a cached token makes no call; count it anyway
      try { g.token = await googleAccessToken(g.env); } catch (err) { g.tokenError = errMsg(err); throw err; }
    }
    g.calls++;
    const r = await fetch(`${GCAL_API}/calendars/${encodeURIComponent(g.env.GCAL_CALENDAR_ID)}/events${path}`, {
      method, headers: { Authorization: `Bearer ${g.token}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (r.status === 401 && !g.retried) { g.retried = true; g.token = null; await kvDelete(g.env, TOKEN_KEY); continue; }
    let j = null; try { j = await r.json(); } catch (_) { /* 204, or not JSON */ }
    return { status: r.status, body: j };
  }
}
const googleError = (r) => String((r.body && r.body.error && (r.body.error.message || r.body.error)) || `HTTP ${r.status}`);

async function setGcalId(g, c, rowId, value) {
  g.calls++;
  const r = await fetch(`${c.rowsUrl}/${encodeURIComponent(rowId)}`, {
    method: 'PUT', headers: c.auth, body: JSON.stringify({ row: { cells: [{ column: C.gcalEventId, value }] } }),
  });
  if (r.ok) await bustEventCaches(g.env);
  return r;
}

// Carry out one plan in live mode -> {op, ok, status, message}.
async function runOp(g, c, rowId, plan, storedId) {
  const env = g.env;
  if (plan.op === 'delete') {
    const r = await gfetch(g, 'DELETE', `/${encodeURIComponent(storedId)}`);
    if (!afterGcalResponse('delete', r.status, r.body).ok) return { op: 'delete', ok: false, status: r.status, message: `Could not remove it from Google Calendar: ${googleError(r)}` };
    await kvDelete(env, hashKey(rowId));
    const w = await setGcalId(g, c, rowId, '');
    if (!w.ok) return { op: 'delete', ok: false, status: w.status, message: `Removed from Google Calendar but could not clear its id on the row (Coda ${w.status})` };
    return { op: 'delete', ok: true, status: r.status, message: r.status === 404 || r.status === 410 ? `Already gone from Google Calendar (${r.status}); id cleared` : 'Removed from Google Calendar' };
  }
  let missing = 0;
  if (plan.op === 'patch') {
    // events.update, the whole body: PATCH can't clear a location or switch timed <-> all-day.
    // status: a trashed event (cancelled in Google) comes back.
    const r = await gfetch(g, 'PUT', `/${encodeURIComponent(storedId)}`, { ...plan.body, status: 'confirmed' });
    const a = afterGcalResponse('patch', r.status, r.body);
    if (a.ok) {
      await kvPut(env, hashKey(rowId), JSON.stringify({ id: storedId, hash: plan.hash }));
      await bustEventCaches(env);
      return { op: 'patch', ok: true, status: r.status, message: 'Updated on Google Calendar' };
    }
    if (!a.reinsert) return { op: 'patch', ok: false, status: r.status, message: `Could not update it on Google Calendar: ${googleError(r)}` };
    missing = r.status;
  }
  const r = await gfetch(g, 'POST', '', plan.body);
  const a = afterGcalResponse('insert', r.status, r.body);
  if (!a.ok) return { op: 'insert', ok: false, status: r.status, message: `Could not add it to Google Calendar: ${googleError(r)}` };
  // KV first: if the row write fails (or hasn't applied), the next sync still finds the event.
  await kvPut(env, hashKey(rowId), JSON.stringify({ id: a.storeId, hash: plan.hash }));
  const w = await setGcalId(g, c, rowId, a.storeId);
  if (!w.ok) return { op: 'insert', ok: false, status: w.status, message: `Added to Google Calendar (${a.storeId}) but could not save its id to the row (Coda ${w.status}); the Worker remembers it` };
  return { op: 'insert', ok: true, status: r.status, message: missing ? `Not on Google Calendar any more (${missing}); added again` : 'Added to Google Calendar' };
}

const shadowRec = (ev, plan) => ({ action: 'gcal-shadow', ok: true, status: 0, message: `Would ${VERB[plan.op]} "${ev.title}" (${plan.op === 'patch' ? 'update' : plan.op})` });

/**
 * One row, after a lead-facing route succeeds (run it in ctx.waitUntil). `ev` is the
 * event as the route just wrote it (gcalEventFromRow + changes): Coda applies writes
 * ~28 s later, so a fresh read would return the old row. Without `ev.venueAddress`
 * the venue is read here. Logs its one record. Never throws.
 */
export async function syncGcal(env, rowId, { ev, actorId } = {}) {
  const mode = gcalMode(env);
  if (mode === 'off') return { op: 'none', ok: true };
  const c = coda(env), logs = [];
  const log = (r) => logs.push({ target: TARGET, via: 'plan', rowId, actorId, ...r });
  let op = 'none';
  try {
    let e = { ...(ev || {}), rowId };
    if (onCalendar(e) && e.venueAddress === undefined) e = withVenue(e, await loadVenues(c));
    const st = await readState(env, rowId);
    const storedId = (st && st.id) || e.gcalEventId || '';
    const plan = gcalPlan(e, storedId, st && st.hash, gcalOpts(env));
    op = plan.op;
    const act = gcalModeAction(mode, op);
    if (act === 'skip') return { op, ok: true };
    if (act === 'log-only') { log(shadowRec(e, plan)); return { op, ok: true }; }
    const r = await runOp(googleClient(env), c, rowId, plan, storedId);
    log({ action: ACTION[r.op], ok: r.ok, status: r.status, message: r.message });
    return { op: r.op, ok: r.ok };
  } catch (err) {
    warn({ rowId, error: errMsg(err) });
    log({ action: ACTION[op] || 'gcal-sync', ok: false, status: 0, message: errMsg(err) });
    return { op, ok: false };
  } finally {
    await logPublishMany(env, c.base, c.docId, c.auth, logs);
  }
}

/**
 * The cron (GCAL_CRON). Every row dated yesterday or later (inSyncWindow) whose calendar
 * event needs an insert, update or delete; past rows are never touched. At most
 * GCAL_SWEEP_MAX operations a run, fewer when the call budget runs short, resuming
 * from KV gcal-sweep-cursor. One Publish Log insert for the run. Never throws.
 */
export async function sweepGcal(env) {
  const out = { checked: 0, ops: 0 };
  const mode = gcalMode(env);
  if (mode === 'off') return out;
  const c = coda(env), logs = [];
  const log = (ev, r) => logs.push({ target: TARGET, via: 'sweep', rowId: ev && ev.rowId, ...r });
  try {
    const rr = await readAllRows(c.rowsUrl, c.auth);
    if (!rr.ok) { warn({ sweep: 'row read failed', status: rr.resp && rr.resp.status }); return out; }
    if (rr.truncated) log(null, { action: 'gcal-sweep', ok: false, status: 0, message: `Planning row read stopped at its page cap (${rr.items.length} rows): rows past it were not checked` });
    const today = todayIn(env.EVENTBRITE_TZ);
    const inWindow = rr.items.map((r) => gcalEventFromRow(r.id, r.values)).filter((e) => inSyncWindow(e, today));
    out.checked = inWindow.length;
    if (!inWindow.length) return out;
    const readVenues = inWindow.some((e) => onCalendar(e) && e.venueName);
    const venues = readVenues ? await loadVenues(c) : [];
    const states = await Promise.all(inWindow.map((e) => readState(env, e.rowId)));
    const opts = gcalOpts(env), candidates = [];
    inWindow.forEach((e, i) => {
      const st = states[i], storedId = (st && st.id) || e.gcalEventId || '';
      const full = onCalendar(e) ? withVenue(e, venues) : e;
      const plan = gcalPlan(full, storedId, st && st.hash, opts);
      if (plan.op !== 'none') candidates.push({ ev: full, plan, storedId });
    });

    let cursor = null;
    try { cursor = env.CACHE ? await env.CACHE.get(CURSOR_KEY) : null; } catch (err) { warn({ kvGet: CURSOR_KEY, error: errMsg(err) }); }
    const { batch, nextCursor } = sweepBatch(candidates, cursor, GCAL_SWEEP_MAX);
    const start = (nextCursor == null ? candidates.length : nextCursor) - batch.length;
    const g = googleClient(env);
    g.calls = ROW_READ_CALLS + (readVenues ? 1 : 0) + 1;   // row pages, Venues, the log insert
    let done = 0;
    for (const { ev, plan, storedId } of batch) {
      if (mode === 'shadow') { log(ev, shadowRec(ev, plan)); done++; out.ops++; continue; }
      // Worst case for one op: update 404 -> insert -> row PUT (3), a 401 retry (2), the token (1).
      const worst = 3 + (g.retried ? 0 : 2) + (g.token ? 0 : 1);
      if (g.calls + worst > CALL_LIMIT) { note({ sweep: 'call budget reached', done }); break; }
      done++; out.ops++;
      try {
        const r = await runOp(g, c, ev.rowId, plan, storedId);
        log(ev, { action: ACTION[r.op], ok: r.ok, status: r.status, message: r.message });
      } catch (err) {
        log(ev, { action: ACTION[plan.op], ok: false, status: 0, message: g.tokenError ? `Google sign-in failed: ${g.tokenError}` : errMsg(err) });
        if (g.tokenError) { out.ops--; done--; break; }   // nothing can reach Google this run
      }
    }
    const next = done === batch.length ? nextCursor : start + done;
    if (next == null) await kvDelete(env, CURSOR_KEY);
    else await kvPut(env, CURSOR_KEY, String(next));
    note({ sweep: out, mode, candidates: candidates.length, batch: batch.length, next });
  } catch (err) {
    warn({ sweep: 'exception', error: errMsg(err) });
  } finally {
    await logPublishMany(env, c.base, c.docId, c.auth, logs);
  }
  return out;
}
