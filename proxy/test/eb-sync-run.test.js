import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { syncEbEvent, runSweep, ebWebhook } from '../src/eb-sync-run.js';
import { PLANNING_COLS as C } from '../src/coda-columns.js';

// ── stubs: a KV and a fetch that routes by URL ──
function kvStub(init = {}) {
  const m = new Map(Object.entries(init));
  return {
    m, puts: [],
    async get(k, t) { const v = m.get(k); if (v == null) return null; return t === 'json' ? JSON.parse(v) : v; },
    async put(k, v, o) { m.set(k, v); this.puts.push([k, v, o]); },
    async delete(k) { m.delete(k); },
    async list({ prefix }) { return { keys: [...m.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })), list_complete: true }; },
  };
}
const res = (status, body) => new Response(body == null ? '' : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
let calls, routes, realFetch;
beforeEach(() => {
  calls = []; routes = []; realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url), method = init.method || 'GET';
    calls.push({ url: u, method, body: init.body ? JSON.parse(init.body) : undefined });
    for (const [m, re, fn] of routes) if (m === method && re.test(u)) return fn(u, init);
    return res(599, { error: 'unrouted ' + method + ' ' + u });
  };
});
afterEach(() => { globalThis.fetch = realFetch; });
const on = (m, re, fn) => routes.push([m, re, typeof fn === 'function' ? fn : () => fn.clone()]);   // a fresh body per call
const env = (o = {}) => ({ CODA_API_BASE: 'https://coda.test', CODA_DOC_ID: 'D', CODA_TABLE_ID: 'T', CODA_API_TOKEN: 'tok',
  CODA_PUBLISH_LOG_TABLE: 'LOG', EVENTBRITE_TOKEN: 'eb', EVENTBRITE_ORG_ID: '42', EVENTBRITE_TZ: 'America/Chicago',
  EB_SYNC_MODE: 'live', EB_WEBHOOK_SECRET: 's3cret', CACHE: kvStub(), ...o });
const ebEvent = (o = {}) => ({ id: '123', organization_id: '42', name: { text: 'Shabbat' }, status: 'live', url: 'https://eb/123',
  start: { local: '2027-03-13T10:00:00' }, end: { local: '2027-03-13T11:00:00' }, capacity: 20, changed: 'ch2',
  online_event: false, venue_id: '', venue: null, ticket_classes: [{ id: 'tc', quantity_total: 20 }], ...o });
const logs = () => calls.filter((c) => /\/tables\/LOG\/rows/.test(c.url)).map((c) => {
  const cells = c.body.rows[0].cells; const g = (n) => cells.find((x) => x.column === n).value;
  return { action: g('Action'), result: g('Result'), message: g('Message') };
});
const sc = () => on('GET', /\/events\/\d+\/structured_content\//, res(200, { modules: [] }));
const noRows = () => on('GET', /coda\.test\/docs\/D\/tables\/T\/rows\?/, res(200, { items: [] }));

test('import: upserts on the Eventbrite id, writes eb-row marker, logs import', async () => {
  const e = env();
  on('GET', /\/events\/123\/\?expand/, res(200, ebEvent())); sc(); noRows();
  on('POST', /tables\/T\/rows$/, res(202, { requestId: 'q', addedRowIds: ['i-new'] }));
  on('POST', /tables\/LOG\/rows/, res(202, {}));
  const out = await syncEbEvent(e, '123', 'eventbrite');
  assert.equal(out.action, 'import'); assert.equal(out.rowId, 'i-new');
  const ins = calls.find((c) => c.method === 'POST' && /tables\/T\/rows$/.test(c.url));
  assert.deepEqual(ins.body.keyColumns, [C.eventbriteId]);
  assert.equal(ins.body.rows[0].cells.find((c) => c.column === C.eventbriteId).value, '123');
  assert.deepEqual(e.CACHE.puts.find(([k]) => k === 'eb-row:123').slice(1), ['i-new', { expirationTtl: 3600 }]);
  assert.equal(logs()[0].action, 'import'); assert.ok(logs()[0].message.startsWith('[eventbrite] '));
});
test('import race: empty addedRowIds writes no marker and logs it', async () => {
  const e = env();
  on('GET', /\/events\/123\/\?expand/, res(200, ebEvent())); sc(); noRows();
  on('POST', /tables\/T\/rows$/, res(202, { requestId: 'q', addedRowIds: [] }));
  on('POST', /tables\/LOG\/rows/, res(202, {}));
  const out = await syncEbEvent(e, '123', 'sweep');
  assert.equal(out.action, 'error');
  assert.equal(e.CACHE.m.has('eb-row:123'), false);
  assert.equal(logs()[0].result, 'error'); assert.ok(logs()[0].message.startsWith('[sweep] '));
});
test('marker set, row not applied yet (404): skip, never import twice', async () => {
  const e = env({ CACHE: kvStub({ 'eb-row:123': 'i-new' }) });
  on('GET', /\/events\/123\/\?expand/, res(200, ebEvent())); sc(); noRows();
  on('GET', /tables\/T\/rows\/i-new\?/, res(404, { message: 'not found' }));
  on('POST', /tables\/LOG\/rows/, res(202, {}));
  const out = await syncEbEvent(e, '123', 'eventbrite');
  assert.equal(out.action, 'skip');
  assert.equal(calls.filter((c) => c.method === 'POST' && /tables\/T\/rows$/.test(c.url)).length, 0);
  assert.equal(logs()[0].action, 'skip');
});
test('a plan push in flight for the row: skip, no write', async () => {
  const e = env({ CACHE: kvStub({ 'ebpending:i-1': JSON.stringify({ ebId: '123' }) }) });
  on('GET', /\/events\/123\/\?expand/, res(200, ebEvent())); sc();
  on('GET', /tables\/T\/rows\?/, res(200, { items: [{ id: 'i-1', values: { [C.eventbriteId]: '123' } }] }));
  const out = await syncEbEvent(e, '123', 'eventbrite');
  assert.equal(out.action, 'skip');
  assert.equal(calls.filter((c) => c.method !== 'GET').length, 0);
});
test('our own fresh push (row not applied, pending marker names the event): skip, no import', async () => {
  const e = env({ CACHE: kvStub({ 'ebpending:i-9': JSON.stringify({ ebId: '123' }) }) });
  on('GET', /\/events\/123\/\?expand/, res(200, ebEvent())); sc(); noRows();
  const out = await syncEbEvent(e, '123', 'eventbrite');
  assert.equal(out.action, 'skip'); assert.equal(out.rowId, 'i-9');
  assert.equal(calls.filter((c) => c.method !== 'GET').length, 0);
});
test('another organization\'s event is dropped without touching Coda', async () => {
  const e = env();
  on('GET', /\/events\/123\/\?expand/, res(200, ebEvent({ organization_id: '999' })));
  const out = await syncEbEvent(e, '123', 'eventbrite');
  assert.equal(out.action, 'ignored');
  assert.equal(calls.filter((c) => /coda\.test/.test(c.url)).length, 0);
});
test('two rows with the id: error logged, nothing written', async () => {
  const e = env();
  on('GET', /\/events\/123\/\?expand/, res(200, ebEvent())); sc();
  on('GET', /tables\/T\/rows\?/, res(200, { items: [{ id: 'a', values: { [C.eventbriteId]: '123' } }, { id: 'b', values: { [C.eventbriteId]: 123 } }] }));
  on('POST', /tables\/LOG\/rows/, res(202, {}));
  const out = await syncEbEvent(e, '123', 'eventbrite');
  assert.equal(out.action, 'error');
  assert.equal(calls.filter((c) => c.method === 'PUT').length, 0);
  assert.equal(logs()[0].result, 'error');
});
test('flow-in: PUTs the changed cells on the row, busts caches, logs flow-in', async () => {
  const kv = kvStub({ 'rows-v1': '{}', 'gather-events-v1': '{}' });
  const e = env({ CACHE: kv });
  const pushed = { title: 'Shabbat', date: '2027-03-13', start: '10:00', end: '11:00', capacity: 20, publicSummary: '', publicDescription: '',
    venueName: '', addressVisibility: '', ticketClassId: 'tc', ebChanged: 'ch1', ebVenueId: '', ebStatus: 'live' };
  on('GET', /\/events\/123\/\?expand/, res(200, ebEvent({ start: { local: '2027-03-13T18:00:00' } }))); sc();
  on('GET', /tables\/T\/rows\?/, res(200, { items: [{ id: 'i-1', values: { [C.eventbriteId]: '123' } }] }));
  on('GET', /tables\/T\/rows\/i-1\?useColumnNames=true&valueFormat=simpleWithArrays/, res(200, { id: 'i-1', values: {
    Title: 'Shabbat', Date: '2027-03-13', Start: '10:00', End: '11:00', Capacity: 20, 'Eventbrite Event ID': '123',
    'Last EB pushed values': JSON.stringify(pushed) } }));
  on('PUT', /tables\/T\/rows\/i-1$/, res(202, { requestId: 'q' }));
  on('POST', /tables\/LOG\/rows/, res(202, {}));
  const out = await syncEbEvent(e, '123', 'eventbrite');
  assert.equal(out.action, 'flowin'); assert.deepEqual(out.changed, ['start']);
  const put = calls.find((c) => c.method === 'PUT');
  assert.equal(put.body.row.cells.find((c) => c.column === C.start).value, '18:00');
  assert.equal(kv.m.has('rows-v1'), false); assert.equal(kv.m.has('gather-events-v1'), false);
  assert.equal(logs()[0].action, 'flow-in');
});
test('Eventbrite 404: row marked Removed from Eventbrite, logged removed', async () => {
  const e = env();
  on('GET', /\/events\/123\/\?expand/, res(404, { error: 'NOT_FOUND' }));
  on('GET', /tables\/T\/rows\?/, res(200, { items: [{ id: 'i-1', values: { [C.eventbriteId]: '123', [C.publishStatus]: 'Published' } }] }));
  on('PUT', /tables\/T\/rows\/i-1$/, res(202, { requestId: 'q' }));
  on('POST', /tables\/LOG\/rows/, res(202, {}));
  const out = await syncEbEvent(e, '123', 'sweep');
  assert.equal(out.action, 'removed');
  const cells = calls.find((c) => c.method === 'PUT').body.row.cells;
  assert.equal(cells.find((c) => c.column === C.publishStatus).value, 'Removed from Eventbrite');
  assert.equal(cells.find((c) => c.column === C.published).value, false);
  assert.equal(logs()[0].action, 'removed');
});
test('syncEbEvent never throws', async () => {
  globalThis.fetch = async () => { throw new Error('boom'); };
  const out = await syncEbEvent(env(), '123', 'eventbrite');
  assert.equal(out.action, 'error');
});

// ── webhook route ──
const req = (body) => new Request('https://w/webhooks/eventbrite/x', { method: 'POST', body: JSON.stringify(body) });
const ctxStub = () => { const p = []; return { p, waitUntil: (x) => p.push(x) }; };
test('webhook: wrong secret is a 404 and does nothing', async () => {
  const ctx = ctxStub();
  const r = await ebWebhook(req({ api_url: 'https://www.eventbriteapi.com/v3/events/123/' }), env(), ctx, 'nope');
  assert.equal(r.status, 404); assert.equal(ctx.p.length, 0);
  const r2 = await ebWebhook(req({}), env({ EB_WEBHOOK_SECRET: undefined }), ctx, '');
  assert.equal(r2.status, 404);
});
test('webhook: off mode answers 200 mode off and does nothing', async () => {
  const ctx = ctxStub();
  const r = await ebWebhook(req({ api_url: 'https://www.eventbriteapi.com/v3/events/123/' }), env({ EB_SYNC_MODE: 'off' }), ctx, 's3cret');
  assert.equal(r.status, 200); assert.deepEqual(await r.json(), { ok: true, mode: 'off' });
  assert.equal(ctx.p.length, 0); assert.equal(calls.length, 0);
});
test('webhook: live mode answers 200 at once and syncs in waitUntil', async () => {
  const ctx = ctxStub();
  on('GET', /\/events\/123\/\?expand/, res(200, ebEvent({ organization_id: '999' })));
  const r = await ebWebhook(req({ api_url: 'https://www.eventbriteapi.com/v3/events/123/' }), env(), ctx, 's3cret');
  assert.equal(r.status, 200); assert.equal(ctx.p.length, 1);
  assert.equal((await ctx.p[0]).action, 'ignored');
  const r2 = await ebWebhook(req({ api_url: 'https://elsewhere/v3/events/1/' }), env(), ctxStub(), 's3cret');
  assert.equal(r2.status, 200); assert.equal((await r2.json()).ignored, true);
});

// ── sweep ──
test('sweep: off mode does nothing', async () => {
  const out = await runSweep(env({ EB_SYNC_MODE: 'off' }));
  assert.equal(out.seen, 0); assert.equal(calls.length, 0);
});
test('sweep: stops paging past 30 days back, caps at 8 and stores the cursor', async () => {
  const e = env();
  const evs = Array.from({ length: 10 }, (_, i) => ebEvent({ id: String(100 + i), changed: 'x', start: { local: '2027-01-0' + (i % 9 + 1) + 'T10:00:00' } }));
  evs.push(ebEvent({ id: '999', start: { local: '2020-01-01T10:00:00' } }));   // too old: stops the listing
  on('GET', /\/organizations\/42\/events\/\?order_by=start_desc&expand=venue,ticket_classes/, res(200, { events: evs, pagination: { has_more_items: true, continuation: 'more' } }));
  on('GET', /tables\/T\/rows\?/, res(200, { items: [] }));
  sc();
  let n = 0;
  on('POST', /tables\/T\/rows$/, () => res(202, { addedRowIds: ['i-' + (n++)] }));
  on('POST', /tables\/LOG\/rows/, res(202, {}));
  const out = await runSweep(e);
  assert.equal(out.seen, 10); assert.equal(out.imported, 8);
  assert.equal(calls.filter((c) => /organizations\/42\/events/.test(c.url)).length, 1, 'no second page once past the window');
  assert.equal(calls.filter((c) => /\/events\/\d+\/\?expand/.test(c.url)).length, 0, 'listed bodies are reused');
  assert.equal(e.CACHE.m.get('eb-sweep-cursor'), '8');
});
