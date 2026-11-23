// Google Calendar from the Worker, the I/O half (spec §6): one row after a lead-facing
// route succeeds (syncGcal) and the cron sweep (sweepGcal). The rules are pure, in gcal.js.
// Worker var GCAL_MODE = off | shadow | live (default off); GCAL_CALENDAR_ID unset counts as off.
// Neither function throws: every failure ends in a Publish Log record or a console line.
import { onCalendar, inSyncWindow, planGcalRow, gcalModeAction, afterGcalResponse, gcalEventIdFor } from './gcal.js';
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
const HASH_PREFIX = 'gcal-hash:', TOMB_PREFIX = 'gcal-tomb:', SHADOW_PREFIX = 'gcal-shadow:';
// {id, hash, date}: the event, body and date the Worker last wrote; metadata {date} lets one
// KV list find rows whose date moved out of the window.
const hashKey = (rowId) => `${HASH_PREFIX}${rowId}`;
const TOMB_TTL = 900;       // gcal-tomb:<rowId> {at}: a delete the row may not show yet (Coda applies ~28 s late)
const SHADOW_TTL = 86400;   // gcal-shadow:<rowId>: the last op/body shadow mode logged
const ERR_PREFIX = 'gcal-err:', ERR_TTL = 86400;   // gcal-err:<rowId>: the last error logged for the row (action:status)
const LIST_MAX_PAGES = 5;
const VENUES_TABLE = 'grid-foC40iAOaX';         // EST Venues SRC
const GCAL_API = 'https://www.googleapis.com/calendar/v3';
const TARGET = 'gCal';   // the Publish Log Target option
const ACTION = { insert: 'gcal-insert', patch: 'gcal-update', delete: 'gcal-delete' };
const VERB = { insert: 'add', patch: 'update', delete: 'remove' };
// The free plan allows 50 outbound calls per invocation. The sweep reserves the
// worst case up front: readAllRows' 6 row pages, 1 Venues page, 1 Publish Log insert.
const CALL_LIMIT = 50;
const ROW_READ_CALLS = 6;
const OP_WORST = 4;   // update 404 -> insert 409 -> full PUT -> row PUT

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
async function kvGetJson(env, key) {
  const kv = env.CACHE; if (!kv) return null;
  try { return await kv.get(key, 'json'); } catch (err) { warn({ kvGet: key, error: errMsg(err) }); return null; }
}
async function kvPut(env, key, value, opts) {
  const kv = env.CACHE; if (!kv) return;
  try { await kv.put(key, value, opts); } catch (err) { warn({ kvPut: key, error: errMsg(err) }); }
}
const writeState = (env, rowId, st) => kvPut(env, hashKey(rowId), JSON.stringify(st), { metadata: { date: st.date || '' } });
const readTomb = (env, rowId) => kvGetJson(env, `${TOMB_PREFIX}${rowId}`);
// Every key under a prefix (one KV operation per page), with its metadata.
async function kvList(env, prefix) {
  const kv = env.CACHE, out = []; if (!kv || !kv.list) return out;
  try {
    let cursor, pages = 0;
    do {
      const r = await kv.list({ prefix, cursor });
      for (const k of (r && r.keys) || []) out.push({ rowId: k.name.slice(prefix.length), metadata: k.metadata || null });
      cursor = r && !r.list_complete ? r.cursor : null;
    } while (cursor && ++pages < LIST_MAX_PAGES);
  } catch (err) { warn({ kvList: prefix, error: errMsg(err) }); }
  return out;
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

// Carry out one plan in live mode -> {op, ok, status, message}. `date` is the event's date,
// kept with the hash so a date later moved out of the window can still be cleaned up.
// `rowGone`: the planning row was deleted, so a delete writes nothing to it.
async function runOp(g, c, rowId, plan, date, rowGone = false) {
  const env = g.env, storedId = plan.storedId;
  if (plan.op === 'delete') {
    const r = await gfetch(g, 'DELETE', `/${encodeURIComponent(storedId)}`);
    if (!afterGcalResponse('delete', r.status, r.body).ok) return { op: 'delete', ok: false, status: r.status, message: `Could not remove it from Google Calendar: ${googleError(r)}` };
    await kvDelete(env, hashKey(rowId));
    await kvPut(env, `${TOMB_PREFIX}${rowId}`, JSON.stringify({ at: new Date().toISOString() }), { expirationTtl: TOMB_TTL });
    if (rowGone) return { op: 'delete', ok: true, status: r.status, message: r.status === 404 || r.status === 410 ? `Already gone from Google Calendar (${r.status})` : 'Removed from Google Calendar' };
    const w = await setGcalId(g, c, rowId, '');
    if (!w.ok) return { op: 'delete', ok: false, status: w.status, message: `Removed from Google Calendar but could not clear its id on the row (Coda ${w.status})` };
    return { op: 'delete', ok: true, status: r.status, message: r.status === 404 || r.status === 410 ? `Already gone from Google Calendar (${r.status}); id cleared` : 'Removed from Google Calendar' };
  }
  // events.update, the whole body: PATCH can't clear a location or switch timed <-> all-day.
  // status: a trashed (cancelled) event comes back.
  const replace = (id) => gfetch(g, 'PUT', `/${encodeURIComponent(id)}`, { ...plan.body, status: 'confirmed' });
  let missing = 0;
  if (plan.op === 'patch') {
    const r = await replace(storedId);
    const a = afterGcalResponse('patch', r.status, r.body);
    if (a.ok) {
      await writeState(env, rowId, { id: storedId, hash: plan.hash, date });   // no row written: no cache bust
      return { op: 'patch', ok: true, status: r.status, message: 'Updated on Google Calendar' };
    }
    if (!a.reinsert) return { op: 'patch', ok: false, status: r.status, message: `Could not update it on Google Calendar: ${googleError(r)}` };
    missing = r.status;
  }
  // Insert at the row's own id: a second writer (sweep vs a lead route) gets a 409, not a duplicate.
  const det = gcalEventIdFor(rowId);
  let r = await gfetch(g, 'POST', '', { ...plan.body, id: det });
  let a = afterGcalResponse('insert', r.status, r.body), existed = false;
  if (a.exists) {
    existed = true;
    r = await replace(det);
    a = afterGcalResponse('patch', r.status, r.body).ok ? { ok: true, storeId: det } : { ok: false };
  }
  if (!a.ok) return { op: 'insert', ok: false, status: r.status, message: `Could not add it to Google Calendar: ${googleError(r)}` };
  // KV first: if the row write fails (or hasn't applied), the next sync still finds the event.
  await writeState(env, rowId, { id: a.storeId, hash: plan.hash, date });
  const w = await setGcalId(g, c, rowId, a.storeId);
  if (!w.ok) return { op: 'insert', ok: false, status: w.status, message: `Added to Google Calendar (${a.storeId}) but could not save its id to the row (Coda ${w.status}); the Worker remembers it` };
  const how = missing ? `Not on Google Calendar any more (${missing}); added again` : existed ? 'Already on Google Calendar; replaced' : 'Added to Google Calendar';
  return { op: 'insert', ok: true, status: r.status, message: how };
}

// Shadow mode logs an op only the first time it sees it for a row (same op, same body).
async function shadowIsNew(env, rowId, plan) {
  const key = `${SHADOW_PREFIX}${rowId}`, mark = `${plan.op}:${plan.hash || plan.storedId || ''}`;
  let last = null;
  try { last = env.CACHE ? await env.CACHE.get(key) : null; } catch (err) { warn({ kvGet: key, error: errMsg(err) }); }
  if (last === mark) return false;
  await kvPut(env, key, mark, { expirationTtl: SHADOW_TTL });
  return true;
}
// A row's error is logged once a day per action and status (the console gets every one);
// a success clears the mark, so the same error later is logged again.
async function errIsNew(env, rowId, rec) {
  const key = `${ERR_PREFIX}${rowId}`;
  let last = null;
  try { last = env.CACHE ? await env.CACHE.get(key) : null; } catch (err) { warn({ kvGet: key, error: errMsg(err) }); }
  if (rec.ok) { if (last != null) await kvDelete(env, key); return true; }
  warn({ rowId, action: rec.action, status: rec.status, message: rec.message });
  const mark = `${rec.action}:${rec.status}`;
  if (last === mark) return false;
  await kvPut(env, key, mark, { expirationTtl: ERR_TTL });
  return true;
}
const goneNote = (title, rowId) => ` (row deleted: "${title || rowId}")`;
const shadowRec = (ev, plan) => ({ action: 'gcal-shadow', ok: true, status: 0, message: `Would ${VERB[plan.op]} "${ev.title}" (${plan.op === 'patch' ? 'update' : plan.op})` });

/**
 * One row, after a lead-facing route succeeds (run it in ctx.waitUntil). `ev` is the
 * event as the route just wrote it (gcalEventFromRow + changes): Coda applies writes
 * ~28 s later, so a fresh read would return the old row. Without `ev.venueAddress`
 * the venue is read here. Logs its one record. Never throws. `rowGone`: the DELETE
 * route removed the row, so its event goes and nothing is written to the row.
 */
export async function syncGcal(env, rowId, { ev, actorId, rowGone = false } = {}) {
  const mode = gcalMode(env);
  if (mode === 'off') return { op: 'none', ok: true };
  const c = coda(env), logs = [];
  const log = (r) => logs.push({ target: TARGET, via: 'plan', rowId: rowGone ? '' : rowId, actorId, ...r,
    message: rowGone ? r.message + goneNote(ev && ev.title, rowId) : r.message });
  const logResult = async (r) => { if (await errIsNew(env, rowId, r)) log(r); };
  let op = 'none';
  try {
    let e = { ...(ev || {}), rowId };
    if (onCalendar(e) && e.venueAddress === undefined) e = withVenue(e, await loadVenues(c));
    const [st, tomb] = await Promise.all([readState(env, rowId), readTomb(env, rowId)]);
    // A lead acting on the row now is a real decision: it overrides a tombstone.
    const plan = planGcalRow(e, st, { todayIso: todayIn(env.EVENTBRITE_TZ), opts: gcalOpts(env), tomb, reapproved: true });
    op = plan.op;
    const act = gcalModeAction(mode, op);
    if (act === 'skip') return { op, ok: true };
    if (act === 'log-only') { if (await shadowIsNew(env, rowId, plan)) log(shadowRec(e, plan)); return { op, ok: true }; }
    const r = await runOp(googleClient(env), c, rowId, plan, e.date, rowGone);
    await logResult({ action: ACTION[r.op], ok: r.ok, status: r.status, message: r.message });
    return { op: r.op, ok: r.ok };
  } catch (err) {
    await logResult({ action: ACTION[op] || 'gcal-sync', ok: false, status: 0, message: errMsg(err) });
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
  const log = (ev, r) => logs.push({ target: TARGET, via: 'sweep', rowId: ev && !ev.gone ? ev.rowId : '', ...r,
    message: ev && ev.gone ? `${r.message} (row ${ev.rowId} is no longer in plan)` : r.message });
  try {
    const sweepError = (message, status = 0) => log(null, { action: 'gcal-sweep', ok: false, status, message });
    const rr = await readAllRows(c.rowsUrl, c.auth);
    if (!rr.ok) {
      const status = (rr.resp && rr.resp.status) || 0;
      warn({ sweep: 'row read failed', status });
      sweepError(`Could not read the planning rows (Coda ${status}); nothing checked this run`, status);
      return out;
    }
    if (rr.truncated) sweepError(`Planning row read stopped at its page cap (${rr.items.length} rows): rows past it were not checked`);
    const today = todayIn(env.EVENTBRITE_TZ);
    // Rows dated yesterday or later, plus rows whose stored date is (a date moved back or cleared).
    const storedDate = new Map((await kvList(env, HASH_PREFIX)).map((k) => [k.rowId, k.metadata && k.metadata.date]));
    const rows = rr.items.map((r) => ({ ev: gcalEventFromRow(r.id, r.values), updatedAt: r.updatedAt || '' }))
      .filter(({ ev }) => inSyncWindow(ev, today) || inSyncWindow({ date: storedDate.get(ev.rowId) }, today));
    // Backstop for a deleted row: on a full read, an event stored for a row that is gone and
    // dated in the window is removed (the DELETE route normally does it).
    const present = new Set(rr.items.map((r) => r.id));
    const orphanIds = rr.truncated ? [] : [...storedDate].filter(([id, d]) => !present.has(id) && inSyncWindow({ date: d }, today)).map(([id]) => id);
    const orphans = (await Promise.all(orphanIds.map((id) => readState(env, id)))).flatMap((st, i) => (st && st.id
      ? [{ ev: { rowId: orphanIds[i], title: '(deleted row)', date: st.date, gone: true }, plan: { op: 'delete', storedId: st.id } }] : []));
    out.checked = rows.length + orphans.length;
    if (!out.checked) return out;
    const tombed = new Set((await kvList(env, TOMB_PREFIX)).map((k) => k.rowId));
    const readVenues = rows.some(({ ev }) => onCalendar(ev) && ev.venueName && inSyncWindow(ev, today));
    let venues = [];
    if (readVenues) {
      try { venues = await loadVenues(c); } catch (err) { sweepError(`${errMsg(err)}; nothing changed this run`); return out; }
    }
    const [states, tombs] = await Promise.all([
      Promise.all(rows.map(({ ev }) => readState(env, ev.rowId))),
      Promise.all(rows.map(({ ev }) => (tombed.has(ev.rowId) ? readTomb(env, ev.rowId) : null))),
    ]);
    const opts = gcalOpts(env), candidates = [];
    rows.forEach(({ ev, updatedAt }, i) => {
      const tomb = tombs[i];
      const full = onCalendar(ev) && inSyncWindow(ev, today) ? withVenue(ev, venues) : ev;
      // Re-approved: the row changed after the delete (a stale read predates it).
      const reapproved = !!(tomb && updatedAt && tomb.at && updatedAt > tomb.at);
      const plan = planGcalRow(full, states[i], { todayIso: today, opts, tomb, reapproved });
      if (plan.op !== 'none') candidates.push({ ev: full, plan });
    });
    candidates.push(...orphans);

    let cursor = null;
    try { cursor = env.CACHE ? await env.CACHE.get(CURSOR_KEY) : null; } catch (err) { warn({ kvGet: CURSOR_KEY, error: errMsg(err) }); }
    const { batch, nextCursor } = sweepBatch(candidates, cursor, GCAL_SWEEP_MAX);
    const start = (nextCursor == null ? candidates.length : nextCursor) - batch.length;
    const g = googleClient(env);
    g.calls = ROW_READ_CALLS + (readVenues ? 1 : 0) + 1;   // row pages, Venues, the log insert
    let done = 0;
    for (const { ev, plan } of batch) {
      if (mode === 'shadow') { if (await shadowIsNew(env, ev.rowId, plan)) log(ev, shadowRec(ev, plan)); done++; out.ops++; continue; }
      // Worst case for one op (OP_WORST), a 401 retry (2), the token (1).
      const worst = OP_WORST + (g.retried ? 0 : 2) + (g.token ? 0 : 1);
      if (g.calls + worst > CALL_LIMIT) { note({ sweep: 'call budget reached', done }); break; }
      done++; out.ops++;
      try {
        const r = await runOp(g, c, ev.rowId, plan, ev.date, !!ev.gone);
        const rec = { action: ACTION[r.op], ok: r.ok, status: r.status, message: r.message };
        if (await errIsNew(env, ev.rowId, rec)) log(ev, rec);
      } catch (err) {
        const rec = { action: ACTION[plan.op], ok: false, status: 0, message: g.tokenError ? `Google sign-in failed: ${g.tokenError}` : errMsg(err) };
        if (await errIsNew(env, ev.rowId, rec)) log(ev, rec);
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
