import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { syncGcal, sweepGcal, gcalEventFromRow, GCAL_SWEEP_MAX, GCAL_CRON } from '../src/gcal-run.js';
import { gcalEventBody, gcalHash, gcalEventIdFor } from '../src/gcal.js';
import { PLANNING_COLS as C, VENUE_COLS as VC } from '../src/coda-columns.js';

// ── stubs: a KV and a fetch that routes by URL (as eb-sync-run.test.js) ──
function kvStub(init = {}) {
  const m = new Map(Object.entries(init));
  return {
    m, puts: [], deletes: [],
    async get(k, t) { const v = m.get(k); if (v == null) return null; return t === 'json' ? JSON.parse(v) : v; },
    meta: new Map(),
    async put(k, v, o) { m.set(k, v); this.puts.push([k, v, o]); if (o && o.metadata) this.meta.set(k, o.metadata); else this.meta.delete(k); },
    async delete(k) { m.delete(k); this.meta.delete(k); this.deletes.push(k); },
    async list({ prefix }) { return { keys: [...m.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name, metadata: this.meta.get(name) })), list_complete: true }; },
  };
}
const res = (status, body) => new Response(body == null ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
let calls, routes, realFetch;
beforeEach(() => {
  calls = []; routes = []; realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url), method = init.method || 'GET';
    let body; try { body = init.body ? JSON.parse(init.body) : undefined; } catch (_) { body = init.body; }
    calls.push({ url: u, method, body, headers: init.headers || {} });
    for (const [m, re, fn] of routes) if (m === method && re.test(u)) return fn(u, init);
    return res(599, { error: 'unrouted ' + method + ' ' + u });
  };
});
afterEach(() => { globalThis.fetch = realFetch; });
const on = (m, re, fn) => routes.unshift([m, re, typeof fn === 'function' ? fn : () => fn.clone()]);   // later routes win

const FAR = Math.floor(Date.now() / 1000) + 3000;
const env = (o = {}) => ({
  CODA_API_BASE: 'https://coda.test', CODA_DOC_ID: 'D', CODA_TABLE_ID: 'T', CODA_API_TOKEN: 'tok',
  CODA_PUBLISH_LOG_TABLE: 'LOG', EVENTBRITE_TZ: 'America/Chicago', EVENTBRITE_AREA_CITY: 'Nashville', EVENTBRITE_AREA_REGION: 'TN',
  GATHER_BASE: 'https://gather.test', GCAL_MODE: 'live', GCAL_CALENDAR_ID: 'cal@group.calendar.google.com',
  CACHE: kvStub({ 'gcal-token': JSON.stringify({ token: 'gt', exp: FAR }) }), ...o,
});
const OPTS = { tz: 'America/Chicago', gatherBase: 'https://gather.test', area: 'Nashville, TN' };
const dayIso = (n) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(new Date(Date.now() + n * 86400_000));
const GCAL = /googleapis\.com\/calendar\/v3\/calendars\/cal%40group\.calendar\.google\.com\/events/;
const ROW_PUT = /coda\.test\/docs\/D\/tables\/T\/rows\/[^/?]+$/;
const ROWS = /coda\.test\/docs\/D\/tables\/T\/rows\?/;
const VENUES = /tables\/grid-foC40iAOaX\/rows/;
const LOG = /\/tables\/LOG\/rows/;

const values = (o = {}) => ({
  Title: 'Shabbat Dinner', Status: 'Approved', Scheduling: 'Exact', Date: dayIso(10), Start: '18:00', End: '20:00',
  'All day': false, Venue: 'The Hall', 'Venue (other)': '', 'Address visibility': 'Public', 'Public summary': 'Join us.',
  'Publish status': '', 'Eventbrite URL': '', 'gCal Event ID': '', ...o,
});
const venueRows = [{ id: 'v1', values: { [VC.name]: 'The Hall', [VC.address]: '1 Main St, Nashville, TN 37201', [VC.type]: 'Venue' } }];
const ev = (rowId = 'i-1', o = {}, venueAddress = '1 Main St, Nashville, TN 37201') =>
  ({ ...gcalEventFromRow(rowId, values(o)), venueAddress });
const logRecs = () => calls.filter((c) => LOG.test(c.url)).flatMap((c) => c.body.rows).map(({ cells }) => {
  const g = (n) => cells.find((x) => x.column === n).value;
  return { target: g('Target'), action: g('Action'), result: g('Result'), message: g('Message'), status: g('HTTP status'), actor: g('Actor'), row: g('Planning Event') };
});
const googleCalls = () => calls.filter((c) => /googleapis\.com\/calendar/.test(c.url));
const rowPuts = () => calls.filter((c) => c.method === 'PUT' && ROW_PUT.test(c.url));
const okLog = () => on('POST', LOG, res(202, {}));
const okRowPut = () => on('PUT', ROW_PUT, res(202, { requestId: 'r1' }));

// ── gcalEventFromRow ──
test('gcalEventFromRow: listing event plus the fields gCal needs', () => {
  const e = gcalEventFromRow('i-1', values({ 'Publish status': 'Published', 'Eventbrite URL': 'https://eb/1', 'gCal Event ID': 'g9', Status: 'Cancelled' }));
  assert.equal(e.rowId, 'i-1');
  assert.equal(e.status, 'cancelled');
  assert.equal(e.publishStatus, 'Published');
  assert.equal(e.eventbriteUrl, 'https://eb/1');
  assert.equal(e.gcalEventId, 'g9');
  assert.equal(e.title, 'Shabbat Dinner');
});

// ── syncGcal: one row, from a lead-facing route ──
test('syncGcal: off mode does nothing at all', async () => {
  const r = await syncGcal(env({ GCAL_MODE: 'off' }), 'i-1', { ev: ev() });
  assert.deepEqual(r, { op: 'none', ok: true });
  assert.equal(calls.length, 0);
});
test('syncGcal: no calendar id behaves as off', async () => {
  const r = await syncGcal(env({ GCAL_CALENDAR_ID: '' }), 'i-1', { ev: ev() });
  assert.deepEqual(r, { op: 'none', ok: true });
  assert.equal(calls.length, 0);
});
test('syncGcal live insert: POST to Google, id on the row, hash in KV, caches busted, one log', async () => {
  const e = env(); e.CACHE.m.set('rows-v1', 'x');
  on('POST', GCAL, res(200, { id: 'g1' })); okRowPut(); okLog();
  const r = await syncGcal(e, 'i-1', { ev: ev(), actorId: 'p-1' });
  assert.deepEqual(r, { op: 'insert', ok: true });
  const g = googleCalls();
  assert.equal(g.length, 1);
  assert.equal(g[0].method, 'POST');
  assert.equal(g[0].headers.Authorization, 'Bearer gt');
  assert.deepEqual(g[0].body, { ...gcalEventBody(ev(), OPTS), id: gcalEventIdFor('i-1') }, 'deterministic id');
  const put = rowPuts();
  assert.equal(put.length, 1);
  assert.match(put[0].url, /rows\/i-1$/);
  assert.deepEqual(put[0].body.row.cells, [{ column: C.gcalEventId, value: 'g1' }]);
  assert.deepEqual(JSON.parse(e.CACHE.m.get('gcal-hash:i-1')), { id: 'g1', hash: gcalHash(gcalEventBody(ev(), OPTS)), date: dayIso(10) });
  assert.deepEqual(e.CACHE.meta.get('gcal-hash:i-1'), { date: dayIso(10) }, 'date in metadata for the stale-date scan');
  assert.equal(e.CACHE.m.has('rows-v1'), false, 'caches busted');
  const logs = logRecs();
  assert.equal(logs.length, 1);
  assert.equal(logs[0].target, 'gCal');
  assert.equal(logs[0].action, 'gcal-insert');
  assert.equal(logs[0].result, 'ok');
  assert.deepEqual(logs[0].actor, ['p-1']);
  assert.deepEqual(logs[0].row, ['i-1']);
});
test('syncGcal live update: full replace with PUT, no row write', async () => {
  const e = env();
  e.CACHE.m.set('gcal-hash:i-1', JSON.stringify({ id: 'g1', hash: 'old' }));
  on('PUT', GCAL, res(200, { id: 'g1' })); okLog();
  const r = await syncGcal(e, 'i-1', { ev: ev('i-1', { 'gCal Event ID': 'g1' }) });
  assert.deepEqual(r, { op: 'patch', ok: true });
  const g = googleCalls();
  assert.equal(g.length, 1);
  assert.equal(g[0].method, 'PUT');
  assert.match(g[0].url, /\/events\/g1$/);
  assert.equal(g[0].body.summary, 'Shabbat Dinner');
  assert.equal(g[0].body.status, 'confirmed', 'a trashed event comes back');
  assert.equal(rowPuts().length, 0);
  assert.equal(JSON.parse(e.CACHE.m.get('gcal-hash:i-1')).hash, gcalHash(gcalEventBody(ev(), OPTS)));
  assert.equal(logRecs()[0].action, 'gcal-update');
});
test('syncGcal: an unchanged event makes no call and no log', async () => {
  const e = env();
  e.CACHE.m.set('gcal-hash:i-1', JSON.stringify({ id: 'g1', hash: gcalHash(gcalEventBody(ev(), OPTS)) }));
  const r = await syncGcal(e, 'i-1', { ev: ev('i-1', { 'gCal Event ID': 'g1' }) });
  assert.deepEqual(r, { op: 'none', ok: true });
  assert.equal(calls.length, 0);
});
test('syncGcal: the KV id covers a row write Coda has not applied yet (no duplicate)', async () => {
  const e = env();
  e.CACHE.m.set('gcal-hash:i-1', JSON.stringify({ id: 'g1', hash: 'old' }));
  on('PUT', GCAL, res(200, { id: 'g1' })); okLog();
  const r = await syncGcal(e, 'i-1', { ev: ev() });   // row still shows no gCal Event ID
  assert.equal(r.op, 'patch');
  assert.equal(googleCalls().filter((c) => c.method === 'POST').length, 0);
});
test('syncGcal: an update that 404s inserts again and stores the new id', async () => {
  const e = env();
  e.CACHE.m.set('gcal-hash:i-1', JSON.stringify({ id: 'g1', hash: 'old' }));
  on('PUT', GCAL, res(404, { error: { message: 'Not Found' } }));
  on('POST', GCAL, res(200, { id: 'g2' })); okRowPut(); okLog();
  const r = await syncGcal(e, 'i-1', { ev: ev('i-1', { 'gCal Event ID': 'g1' }) });
  assert.deepEqual(r, { op: 'insert', ok: true });
  assert.deepEqual(googleCalls().map((c) => c.method), ['PUT', 'POST']);
  assert.deepEqual(rowPuts()[0].body.row.cells, [{ column: C.gcalEventId, value: 'g2' }]);
  assert.equal(JSON.parse(e.CACHE.m.get('gcal-hash:i-1')).id, 'g2');
  const logs = logRecs();
  assert.equal(logs.length, 1);
  assert.equal(logs[0].action, 'gcal-insert');
  assert.match(logs[0].message, /added again/i);
});
test('syncGcal: a cancelled event with an id is deleted and the id cleared', async () => {
  const e = env();
  e.CACHE.m.set('gcal-hash:i-1', JSON.stringify({ id: 'g1', hash: 'h' }));
  on('DELETE', GCAL, () => new Response(null, { status: 204 })); okRowPut(); okLog();
  const r = await syncGcal(e, 'i-1', { ev: ev('i-1', { Status: 'Cancelled', 'gCal Event ID': 'g1' }) });
  assert.deepEqual(r, { op: 'delete', ok: true });
  assert.match(googleCalls()[0].url, /\/events\/g1$/);
  assert.deepEqual(rowPuts()[0].body.row.cells, [{ column: C.gcalEventId, value: '' }]);
  assert.equal(e.CACHE.m.has('gcal-hash:i-1'), false);
  assert.equal(logRecs()[0].action, 'gcal-delete');
});
test('syncGcal: a delete Google answers 410 still clears the id', async () => {
  const e = env();
  on('DELETE', GCAL, res(410, { error: { message: 'Resource has been deleted' } })); okRowPut(); okLog();
  const r = await syncGcal(e, 'i-1', { ev: ev('i-1', { Status: 'Cancelled', 'gCal Event ID': 'g1' }) });
  assert.deepEqual(r, { op: 'delete', ok: true });
  assert.deepEqual(rowPuts()[0].body.row.cells, [{ column: C.gcalEventId, value: '' }]);
  assert.equal(logRecs()[0].result, 'ok');
});
test('syncGcal: a Google error logs it and changes nothing', async () => {
  const e = env();
  on('POST', GCAL, res(403, { error: { message: 'Forbidden' } })); okLog();
  const r = await syncGcal(e, 'i-1', { ev: ev() });
  assert.deepEqual(r, { op: 'insert', ok: false });
  assert.equal(rowPuts().length, 0);
  assert.equal(e.CACHE.m.has('gcal-hash:i-1'), false);
  const l = logRecs()[0];
  assert.equal(l.result, 'error');
  assert.equal(l.status, 403);
  assert.match(l.message, /Forbidden/);
});
test('syncGcal: inserted but the id write failed is logged as an error; the KV id still holds it', async () => {
  const e = env();
  on('POST', GCAL, res(200, { id: 'g1' })); on('PUT', ROW_PUT, res(500, {})); okLog();
  const r = await syncGcal(e, 'i-1', { ev: ev() });
  assert.deepEqual(r, { op: 'insert', ok: false });
  assert.equal(JSON.parse(e.CACHE.m.get('gcal-hash:i-1')).id, 'g1');
  assert.equal(logRecs()[0].result, 'error');
  assert.match(logRecs()[0].message, /could not save/i);
});
test('syncGcal: a 401 clears the cached token once and retries once', async () => {
  const subtle = globalThis.crypto.subtle;
  const pair = await subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign']);
  const pem = `-----BEGIN PRIVATE KEY-----\n${Buffer.from(await subtle.exportKey('pkcs8', pair.privateKey)).toString('base64')}\n-----END PRIVATE KEY-----\n`;
  const e = env({ GOOGLE_SA_KEY: JSON.stringify({ client_email: 'sa@x', private_key: pem }) });
  let n = 0;
  on('POST', GCAL, () => (++n === 1 ? res(401, { error: { message: 'Invalid Credentials' } }) : res(200, { id: 'g1' })));
  on('POST', /oauth2\.googleapis\.com\/token/, res(200, { access_token: 'fresh', expires_in: 3600 }));
  okRowPut(); okLog();
  const r = await syncGcal(e, 'i-1', { ev: ev() });
  assert.deepEqual(r, { op: 'insert', ok: true });
  assert.ok(e.CACHE.deletes.includes('gcal-token'));
  const g = googleCalls();
  assert.equal(g.length, 2);
  assert.equal(g[1].headers.Authorization, 'Bearer fresh');
});
test('syncGcal: a second 401 is not retried again', async () => {
  const e = env();
  on('POST', GCAL, res(401, { error: { message: 'Invalid Credentials' } })); okLog();
  e.CACHE.get = async function (k, t) {   // the token "refresh" hands back the same bad token
    if (k === 'gcal-token') return t === 'json' ? { token: 'gt', exp: FAR } : null;
    const v = this.m.get(k); if (v == null) return null; return t === 'json' ? JSON.parse(v) : v;
  };
  const r = await syncGcal(e, 'i-1', { ev: ev() });
  assert.deepEqual(r, { op: 'insert', ok: false });
  assert.equal(googleCalls().length, 2);
});
test('syncGcal: shadow logs what it would do, with no Google call and no writes', async () => {
  const e = env({ GCAL_MODE: 'shadow' });
  okLog();
  const r = await syncGcal(e, 'i-1', { ev: ev() });
  assert.deepEqual(r, { op: 'insert', ok: true });
  assert.equal(googleCalls().length, 0);
  assert.equal(rowPuts().length, 0);
  assert.deepEqual(e.CACHE.puts.map(([k]) => k), ['gcal-shadow:i-1'], 'only the shadow mark: no hash, no id');
  const l = logRecs();
  assert.equal(l.length, 1);
  assert.equal(l[0].action, 'gcal-shadow');
  assert.match(l[0].message, /insert/);
});
test('syncGcal: reads the venue address itself when the route did not pass one', async () => {
  on('GET', VENUES, res(200, { items: venueRows }));
  on('POST', GCAL, res(200, { id: 'g1' })); okRowPut(); okLog();
  const e = gcalEventFromRow('i-1', values({ 'Publish status': 'Draft' }));
  const r = await syncGcal(env(), 'i-1', { ev: e });
  assert.equal(r.ok, true);
  assert.equal(googleCalls()[0].body.location, '1 Main St, Nashville, TN 37201');
});
test('syncGcal never throws: a network failure is logged', async () => {
  on('POST', GCAL, () => { throw new Error('network down'); }); okLog();
  const r = await syncGcal(env(), 'i-1', { ev: ev() });
  assert.deepEqual(r, { op: 'insert', ok: false });
  assert.match(logRecs()[0].message, /network down/);
});

// ── sweepGcal: the cron ──
const rowsRes = (items) => on('GET', ROWS, res(200, { items }));
test('sweepGcal: off mode makes no call', async () => {
  const out = await sweepGcal(env({ GCAL_MODE: 'off' }));
  assert.deepEqual(out, { checked: 0, ops: 0 });
  assert.equal(calls.length, 0);
});
test('sweepGcal live: in-window rows only; inserts, deletes, skips unchanged; one log insert', async () => {
  const e = env();
  const same = gcalEventFromRow('i-same', values({ 'gCal Event ID': 'g-same' }));
  e.CACHE.m.set('gcal-hash:i-same', JSON.stringify({ id: 'g-same', hash: gcalHash(gcalEventBody({ ...same, venueAddress: '1 Main St, Nashville, TN 37201' }, OPTS)) }));
  rowsRes([
    { id: 'i-new', values: values() },
    { id: 'i-same', values: values({ 'gCal Event ID': 'g-same' }) },
    { id: 'i-gone', values: values({ Status: 'Cancelled', 'gCal Event ID': 'g-gone' }) },
    { id: 'i-yest', values: values({ Date: dayIso(-1) }) },
    { id: 'i-past', values: values({ Date: dayIso(-5), Status: 'Cancelled', 'gCal Event ID': 'g-past' }) },
    { id: 'i-old', values: values({ Date: dayIso(-30) }) },
    { id: 'i-idea', values: values({ Scheduling: 'Month' }) },
  ]);
  on('GET', VENUES, res(200, { items: venueRows }));
  let k = 0;
  on('POST', GCAL, () => res(200, { id: `g${++k}` }));
  on('DELETE', GCAL, () => new Response(null, { status: 204 }));
  okRowPut(); okLog();
  const out = await sweepGcal(e);
  assert.deepEqual(out, { checked: 5, ops: 3 });
  const g = googleCalls();
  assert.deepEqual(g.map((c) => c.method).sort(), ['DELETE', 'POST', 'POST']);
  assert.ok(!g.some((c) => /g-past/.test(c.url)), 'past rows are never touched');
  assert.equal(googleCalls().filter((c) => c.method === 'POST')[0].body.location, '1 Main St, Nashville, TN 37201');
  assert.equal(calls.filter((c) => LOG.test(c.url)).length, 1, 'one batched log');
  const logs = logRecs();
  assert.equal(logs.length, 3);
  assert.ok(logs.every((l) => l.target === 'gCal' && l.message.startsWith('[sweep] ')));
  assert.equal(calls.filter((c) => /oauth2/.test(c.url)).length, 0, 'cached token');
});
test('sweepGcal: at most GCAL_SWEEP_MAX operations a run, resuming from the cursor', async () => {
  assert.equal(GCAL_SWEEP_MAX, 15);
  const e = env();
  rowsRes(Array.from({ length: 20 }, (_, i) => ({ id: `i-${i}`, values: values() })));
  on('GET', VENUES, res(200, { items: venueRows }));
  let k = 0;
  on('POST', GCAL, () => res(200, { id: `g${++k}` }));
  okRowPut(); okLog();
  let out = await sweepGcal(e);
  assert.equal(out.ops, 15);
  assert.equal(e.CACHE.m.get('gcal-sweep-cursor'), '15');
  // second run: the first 15 are now unchanged (KV id + hash), the last 5 go in
  calls = [];
  out = await sweepGcal(e);
  assert.equal(out.ops, 5);
  assert.equal(googleCalls().length, 5);
});
test('sweepGcal: worst case stays under 50 outbound calls even when every update re-inserts', async () => {
  const e = env();
  const rows = Array.from({ length: 20 }, (_, i) => ({ id: `i-${i}`, values: values({ 'gCal Event ID': `old${i}` }) }));
  // six full pages of planning rows
  let page = 0;
  on('GET', ROWS, () => (++page < 6 ? res(200, { items: page === 1 ? rows : [], nextPageToken: `p${page}` }) : res(200, { items: [] })));
  on('GET', VENUES, res(200, { items: venueRows }));
  on('PUT', GCAL, res(404, { error: { message: 'Not Found' } }));
  let k = 0;
  on('POST', GCAL, () => res(200, { id: `g${++k}` }));
  okRowPut(); okLog();
  const out = await sweepGcal(e);
  assert.ok(calls.length <= 50, `${calls.length} calls`);
  assert.ok(out.ops < 15, 'stopped early to stay in budget');
  assert.equal(e.CACHE.m.get('gcal-sweep-cursor'), String(out.ops));
});
test('sweepGcal shadow: logs every op, no Google call, no hash or row write', async () => {
  const e = env({ GCAL_MODE: 'shadow' });
  rowsRes([{ id: 'i-new', values: values() }, { id: 'i-gone', values: values({ Status: 'Cancelled', 'gCal Event ID': 'g' }) }]);
  on('GET', VENUES, res(200, { items: venueRows }));
  okLog();
  const out = await sweepGcal(e);
  assert.equal(out.ops, 2);
  assert.equal(googleCalls().length, 0);
  assert.equal(rowPuts().length, 0);
  assert.ok(!e.CACHE.puts.some(([k]) => k.startsWith('gcal-hash:')));
  assert.deepEqual(logRecs().map((l) => l.action), ['gcal-shadow', 'gcal-shadow']);
});
test('sweepGcal: a failed row read writes one gcal-sweep error record and never throws', async () => {
  on('GET', ROWS, res(500, {})); okLog();
  const out = await sweepGcal(env());
  assert.deepEqual(out, { checked: 0, ops: 0 });
  assert.equal(googleCalls().length, 0);
  const l = logRecs();
  assert.equal(l.length, 1);
  assert.equal(l[0].action, 'gcal-sweep');
  assert.equal(l[0].result, 'error');
  assert.match(l[0].message, /500/);
});
test('sweepGcal: a failed Venues read writes one gcal-sweep error record', async () => {
  rowsRes([{ id: 'i-1', values: values() }]);
  on('GET', VENUES, res(503, {})); okLog();
  const out = await sweepGcal(env());
  assert.equal(out.ops, 0);
  assert.equal(googleCalls().length, 0);
  const l = logRecs();
  assert.equal(l.length, 1);
  assert.equal(l[0].action, 'gcal-sweep');
  assert.match(l[0].message, /Venues/);
});
test('sweepGcal: a token failure stops the run with one error record', async () => {
  const e = env({ CACHE: kvStub() });   // no cached token, no key
  rowsRes([{ id: 'i-1', values: values() }, { id: 'i-2', values: values() }]);
  on('GET', VENUES, res(200, { items: venueRows }));
  okLog();
  const out = await sweepGcal(e);
  assert.equal(out.ops, 0);
  assert.equal(googleCalls().length, 0);
  const logs = logRecs();
  assert.equal(logs.length, 1);
  assert.equal(logs[0].result, 'error');
  assert.match(logs[0].message, /GOOGLE_SA_KEY/);
});

// ── the cron picks the sweep ──
test('scheduled: the gCal cron runs only the gCal sweep; the Eventbrite cron only the Eventbrite sweep', async () => {
  const { default: worker } = await import('../src/worker.js');
  const waits = [];
  const ctx = { waitUntil: (p) => waits.push(p) };
  const e = env({ GCAL_MODE: 'shadow', EB_SYNC_MODE: 'live', EVENTBRITE_TOKEN: 'eb', EVENTBRITE_ORG_ID: '42' });
  rowsRes([]); okLog();
  on('GET', /eventbriteapi\.com/, res(200, { events: [], pagination: {} }));
  await worker.scheduled({ cron: GCAL_CRON }, e, ctx);
  await Promise.all(waits);
  assert.equal(calls.filter((c) => /eventbriteapi/.test(c.url)).length, 0);
  assert.ok(calls.some((c) => ROWS.test(c.url)));
  calls = []; waits.length = 0;
  await worker.scheduled({ cron: '*/15 * * * *' }, env({ GCAL_MODE: 'live', EB_SYNC_MODE: 'live', EVENTBRITE_TOKEN: 'eb', EVENTBRITE_ORG_ID: '42' }), ctx);
  await Promise.all(waits);
  assert.ok(calls.some((c) => /eventbriteapi/.test(c.url)));
  assert.equal(googleCalls().length, 0);
});

// ── fix round 1 ──
test('syncGcal: an insert answered 409 replaces the event at the deterministic id and stores it', async () => {
  const e = env();
  const det = gcalEventIdFor('i-1');
  on('POST', GCAL, res(409, { error: { message: 'The requested identifier already exists.' } }));
  on('PUT', GCAL, res(200, { id: det })); okRowPut(); okLog();
  const r = await syncGcal(e, 'i-1', { ev: ev() });
  assert.deepEqual(r, { op: 'insert', ok: true });
  const g = googleCalls();
  assert.deepEqual(g.map((c) => c.method), ['POST', 'PUT']);
  assert.match(g[1].url, new RegExp(`/events/${det}$`));
  assert.equal(g[1].body.status, 'confirmed');
  assert.deepEqual(rowPuts()[0].body.row.cells, [{ column: C.gcalEventId, value: det }]);
  assert.equal(JSON.parse(e.CACHE.m.get('gcal-hash:i-1')).id, det);
  assert.equal(logRecs().length, 1);
});
test('syncGcal: re-inserting after a 404 uses the deterministic id (409 -> PUT restores it)', async () => {
  const e = env();
  const det = gcalEventIdFor('i-1');
  e.CACHE.m.set('gcal-hash:i-1', JSON.stringify({ id: det, hash: 'old', date: dayIso(10) }));
  let puts = 0;
  on('PUT', GCAL, () => (++puts === 1 ? res(404, {}) : res(200, { id: det })));
  on('POST', GCAL, res(409, {})); okRowPut(); okLog();
  const r = await syncGcal(e, 'i-1', { ev: ev() });
  assert.deepEqual(r, { op: 'insert', ok: true });
  const g = googleCalls();
  assert.deepEqual(g.map((c) => c.method), ['PUT', 'POST', 'PUT']);
  assert.equal(g[1].body.id, det);
});
test('syncGcal: a successful delete leaves a 15-minute tombstone', async () => {
  const e = env();
  on('DELETE', GCAL, () => new Response(null, { status: 204 })); okRowPut(); okLog();
  await syncGcal(e, 'i-1', { ev: ev('i-1', { Status: 'Cancelled', 'gCal Event ID': 'g1' }) });
  const tomb = e.CACHE.puts.find(([k]) => k === 'gcal-tomb:i-1');
  assert.ok(tomb, 'tombstone written');
  assert.equal(tomb[2].expirationTtl, 900);
});
test('sweepGcal: a tombstoned row Coda still shows as approved is left alone', async () => {
  const e = env();
  e.CACHE.m.set('gcal-tomb:i-1', JSON.stringify({ at: new Date(Date.now() - 60_000).toISOString() }));
  rowsRes([{ id: 'i-1', updatedAt: new Date(Date.now() - 600_000).toISOString(), values: values({ 'gCal Event ID': 'g1' }) }]);
  on('GET', VENUES, res(200, { items: venueRows })); okLog();
  const out = await sweepGcal(e);
  assert.equal(out.ops, 0);
  assert.equal(googleCalls().length, 0);
  assert.equal(logRecs().length, 0);
});
test('sweepGcal: a row changed after its tombstone (re-approved) goes back on', async () => {
  const e = env();
  e.CACHE.m.set('gcal-tomb:i-1', JSON.stringify({ at: new Date(Date.now() - 600_000).toISOString() }));
  rowsRes([{ id: 'i-1', updatedAt: new Date(Date.now() - 60_000).toISOString(), values: values({ 'gCal Event ID': 'g1' }) }]);
  on('GET', VENUES, res(200, { items: venueRows }));
  on('POST', GCAL, res(200, { id: gcalEventIdFor('i-1') })); okRowPut(); okLog();
  const out = await sweepGcal(e);
  assert.equal(out.ops, 1);
  assert.equal(googleCalls()[0].method, 'POST');
  assert.equal(googleCalls()[0].body.id, gcalEventIdFor('i-1'));
});
test('sweepGcal: a date moved back or cleared deletes the event; history is never touched', async () => {
  const e = env();
  const put = (id, date) => e.CACHE.put(`gcal-hash:${id}`, JSON.stringify({ id: `g-${id}`, hash: 'h', date }), { metadata: { date } });
  await put('i-moved', dayIso(5)); await put('i-cleared', dayIso(0)); await put('i-hist', dayIso(-20));
  e.CACHE.puts.length = 0;
  rowsRes([
    { id: 'i-moved', values: values({ Date: dayIso(-10), 'gCal Event ID': 'g-i-moved' }) },
    { id: 'i-cleared', values: values({ Date: '', 'gCal Event ID': 'g-i-cleared' }) },
    { id: 'i-hist', values: values({ Date: dayIso(-20), 'gCal Event ID': 'g-i-hist' }) },
  ]);
  on('DELETE', GCAL, () => new Response(null, { status: 204 })); okRowPut(); okLog();
  const out = await sweepGcal(e);
  assert.equal(out.ops, 2);
  const urls = googleCalls().map((c) => `${c.method} ${c.url.split('/events/')[1]}`).sort();
  assert.deepEqual(urls, ['DELETE g-i-cleared', 'DELETE g-i-moved']);
  assert.deepEqual(logRecs().map((l) => l.action), ['gcal-delete', 'gcal-delete']);
});
test('sweepGcal shadow: an op already logged for the same body is not logged again', async () => {
  const e = env({ GCAL_MODE: 'shadow' });
  rowsRes([{ id: 'i-new', values: values() }]);
  on('GET', VENUES, res(200, { items: venueRows })); okLog();
  await sweepGcal(e);
  assert.equal(logRecs().length, 1);
  const mark = e.CACHE.puts.find(([k]) => k === 'gcal-shadow:i-new');
  assert.equal(mark[2].expirationTtl, 86400);
  calls = [];
  await sweepGcal(e);
  assert.equal(logRecs().length, 0, 'same op, same body: quiet');
  calls = []; routes = [];
  rowsRes([{ id: 'i-new', values: values({ Title: 'Renamed' }) }]);
  on('GET', VENUES, res(200, { items: venueRows })); okLog();
  await sweepGcal(e);
  assert.equal(logRecs().length, 1, 'a new body logs again');
});
test('scheduled: an unknown cron runs neither sweep', async () => {
  const { default: worker } = await import('../src/worker.js');
  const waits = [];
  const ctx = { waitUntil: (p) => waits.push(p) };
  await worker.scheduled({ cron: '0 * * * *' }, env({ GCAL_MODE: 'live', EB_SYNC_MODE: 'live', EVENTBRITE_TOKEN: 'eb', EVENTBRITE_ORG_ID: '42' }), ctx);
  await Promise.all(waits);
  assert.equal(calls.length, 0);
});

// ── final fix wave (Phase B) ──
test('syncGcal rowGone: a deleted approved row with a stored id -> one Google DELETE, no row write, KV cleared, tombstone, log without the row', async () => {
  const e = env();
  e.CACHE.m.set('gcal-hash:i-1', JSON.stringify({ id: 'g1', hash: 'h', date: dayIso(10) }));
  on('DELETE', GCAL, () => new Response(null, { status: 204 })); okLog();
  // as the DELETE /rows/:rowId route passes it
  const r = await syncGcal(e, 'i-1', { actorId: 'p-1', ev: { ...gcalEventFromRow('i-1', values({ 'gCal Event ID': 'g1' })), status: 'deleted' }, rowGone: true });
  assert.deepEqual(r, { op: 'delete', ok: true });
  const g = googleCalls();
  assert.equal(g.length, 1);
  assert.equal(g[0].method, 'DELETE');
  assert.match(g[0].url, /\/events\/g1$/);
  assert.equal(rowPuts().length, 0, 'the row is gone: no Coda row write');
  assert.equal(e.CACHE.m.has('gcal-hash:i-1'), false);
  assert.ok(e.CACHE.m.has('gcal-tomb:i-1'));
  const l = logRecs();
  assert.equal(l.length, 1);
  assert.equal(l[0].action, 'gcal-delete');
  assert.equal(l[0].result, 'ok');
  assert.deepEqual(l[0].row, [], 'no Planning Event link to a deleted row');
  assert.match(l[0].message, /Shabbat Dinner/);
});
test('sweepGcal backstop: a stored event whose row is gone (full read) is deleted, without a row write', async () => {
  const e = env();
  const put = (id, date) => e.CACHE.put(`gcal-hash:${id}`, JSON.stringify({ id: `g-${id}`, hash: 'h', date }), { metadata: { date } });
  await put('i-gone', dayIso(3)); await put('i-hist', dayIso(-20));
  rowsRes([]);
  on('DELETE', GCAL, () => new Response(null, { status: 204 })); okLog();
  const out = await sweepGcal(e);
  assert.equal(out.ops, 1);
  assert.deepEqual(googleCalls().map((c) => `${c.method} ${c.url.split('/events/')[1]}`), ['DELETE g-i-gone']);
  assert.equal(rowPuts().length, 0);
  assert.equal(e.CACHE.m.has('gcal-hash:i-gone'), false);
  assert.ok(e.CACHE.m.has('gcal-hash:i-hist'), 'history is never touched');
  const l = logRecs();
  assert.equal(l.length, 1);
  assert.equal(l[0].action, 'gcal-delete');
  assert.deepEqual(l[0].row, []);
});
test('sweepGcal backstop: nothing is deleted when the planning read was truncated', async () => {
  const e = env();
  await e.CACHE.put('gcal-hash:i-gone', JSON.stringify({ id: 'g-gone', hash: 'h', date: dayIso(3) }), { metadata: { date: dayIso(3) } });
  on('GET', ROWS, res(200, { items: [], nextPageToken: 'more' }));
  okLog();
  await sweepGcal(e);
  assert.equal(googleCalls().length, 0);
  assert.ok(e.CACHE.m.has('gcal-hash:i-gone'));
});
test('sweepGcal backstop: orphan deletes count against GCAL_SWEEP_MAX', async () => {
  const e = env();
  for (let i = 0; i < 20; i++) await e.CACHE.put(`gcal-hash:o-${i}`, JSON.stringify({ id: `g${i}`, hash: 'h', date: dayIso(3) }), { metadata: { date: dayIso(3) } });
  rowsRes([]);
  on('DELETE', GCAL, () => new Response(null, { status: 204 })); okLog();
  const out = await sweepGcal(e);
  assert.equal(out.ops, 15);
  assert.equal(googleCalls().length, 15);
});
test('syncGcal: an update does not bust the event caches (no planning row written)', async () => {
  const e = env(); e.CACHE.m.set('rows-v1', 'x');
  e.CACHE.m.set('gcal-hash:i-1', JSON.stringify({ id: 'g1', hash: 'old' }));
  on('PUT', GCAL, res(200, { id: 'g1' })); okLog();
  const r = await syncGcal(e, 'i-1', { ev: ev('i-1', { 'gCal Event ID': 'g1' }) });
  assert.deepEqual(r, { op: 'patch', ok: true });
  assert.equal(e.CACHE.m.get('rows-v1'), 'x');
});
test('syncGcal: the same error for a row is logged once a day; the console gets every one', async () => {
  const e = env(), errs = [], realErr = console.error;
  console.error = (...a) => errs.push(a.join(' '));
  try {
    on('POST', GCAL, res(403, { error: { message: 'Forbidden' } })); okLog();
    await syncGcal(e, 'i-1', { ev: ev() });
    assert.equal(logRecs().length, 1);
    const mark = e.CACHE.puts.find(([k]) => k === 'gcal-err:i-1');
    assert.ok(mark, 'error mark written');
    assert.equal(mark[2].expirationTtl, 86400);
    const before = errs.length;
    calls = [];
    await syncGcal(e, 'i-1', { ev: ev() });
    assert.equal(logRecs().length, 0, 'same row, op and status: quiet');
    assert.ok(errs.length > before && /Forbidden/.test(errs.slice(before).join('\n')), 'console still gets it');
    calls = []; routes = [];
    on('POST', GCAL, res(500, { error: { message: 'Backend Error' } })); okLog();
    await syncGcal(e, 'i-1', { ev: ev() });
    assert.equal(logRecs().length, 1, 'a different status logs again');
    // a success clears the mark, so the same error later is logged again
    calls = []; routes = [];
    on('POST', GCAL, res(200, { id: 'g1' })); okRowPut(); okLog();
    await syncGcal(e, 'i-1', { ev: ev() });
    assert.equal(e.CACHE.m.has('gcal-err:i-1'), false);
  } finally { console.error = realErr; }
});
test('sweepGcal: a repeated error for a row is logged once', async () => {
  const e = env();
  rowsRes([{ id: 'i-1', values: values() }]);
  on('GET', VENUES, res(200, { items: venueRows }));
  on('POST', GCAL, res(403, { error: { message: 'Forbidden' } })); okLog();
  await sweepGcal(e);
  assert.equal(logRecs().length, 1);
  calls = [];
  await sweepGcal(e);
  assert.equal(logRecs().length, 0);
});
test('wrangler.toml lists both crons the Worker answers', async () => {
  const fs = await import('node:fs');
  const toml = fs.readFileSync(new URL('../wrangler.toml', import.meta.url), 'utf8');
  const crons = JSON.parse((toml.match(/^crons\s*=\s*(\[.*\])/m) || [])[1] || '[]');
  const src = fs.readFileSync(new URL('../src/worker.js', import.meta.url), 'utf8');
  const EB_SWEEP_CRON = (src.match(/const EB_SWEEP_CRON = '([^']+)'/) || [])[1];
  assert.ok(EB_SWEEP_CRON, 'EB_SWEEP_CRON found in worker.js');
  assert.ok(crons.includes(EB_SWEEP_CRON), `EB_SWEEP_CRON ${EB_SWEEP_CRON} in ${crons}`);
  assert.ok(crons.includes(GCAL_CRON), `GCAL_CRON ${GCAL_CRON} in ${crons}`);
});
