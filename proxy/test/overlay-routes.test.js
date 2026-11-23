import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PEOPLE_COLS } from '../src/coda-columns.js';
import { PEOPLE_KV_KEY, ROWS_KV_KEY, REF_TABLES, codaWrite } from '../src/worker-io.js';
import { WriteOverlay } from '../src/overlay-do.js';

// A real RS256 Firebase token, verified against a stubbed JWKS, so the route's own
// canWrite gate runs unchanged.
const PROJ = 'est-test';
const keys = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
const jwk = { ...(await crypto.subtle.exportKey('jwk', keys.publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
const b64 = (s) => Buffer.from(s).toString('base64url');
async function token(email) {
  const head = b64(JSON.stringify({ alg: 'RS256', kid: 'k1' }));
  const body = b64(JSON.stringify({ iss: `https://securetoken.google.com/${PROJ}`, aud: PROJ, sub: email, email, email_verified: true, exp: Math.floor(Date.now() / 1000) + 3600 }));
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', keys.privateKey, new TextEncoder().encode(`${head}.${body}`));
  return `${head}.${body}.${Buffer.from(sig).toString('base64url')}`;
}
const person = (id, email, status) => ({ id, values: { [PEOPLE_COLS.fullName]: id, [PEOPLE_COLS.allEmails]: [email], [PEOPLE_COLS.leadershipStatus]: status } });
const kv = () => {
  const m = new Map([[PEOPLE_KV_KEY, JSON.stringify({ at: Date.now(), data: [person('i-lead', 'lead@x.org', ['Program Lead']), person('i-mem', 'mem@x.org', [])] })]]);
  return { m, get: async (k, t) => (m.has(k) ? (t === 'json' ? JSON.parse(m.get(k)) : m.get(k)) : null), put: async (k, v) => { m.set(k, v); }, delete: async (k) => { m.delete(k); } };
};
const doStub = (state) => {
  const calls = [];
  const obj = { fetch: async (u, init) => { calls.push({ path: new URL(u).pathname, body: JSON.parse(init.body) }); return new Response(JSON.stringify({ state }), { status: 200 }); } };
  return { calls, ns: { idFromName: (n) => n, get: () => obj } };
};
const env = (o = {}) => ({ CODA_DOC_ID: 'D', CODA_TABLE_ID: 'grid-plan', CODA_API_TOKEN: 't', FIREBASE_PROJECT_ID: PROJ, CACHE: kv(), ...o });

let coda = [];
let codaRoute = null;   // (url, init) -> Response | undefined: a test's stubbed Coda
const realFetch = globalThis.fetch;
globalThis.fetch = async (u, init = {}) => {
  u = String(u);
  if (u.includes('/jwk/securetoken')) return new Response(JSON.stringify({ keys: [jwk] }), { status: 200 });
  coda.push(u);
  if (codaRoute) { const r = await codaRoute(u, init); if (r) return r; }
  if (u.includes('/mutationStatus/')) return new Response(JSON.stringify({ completed: true }), { status: 200 });
  return new Response('{}', { status: 404 });
};
process.on('exit', () => { globalThis.fetch = realFetch; });
const { default: worker } = await import('../src/worker.js');
const get = async (e, email, id = 'mut-1') => {
  const r = await worker.fetch(new Request(`https://w/mutation/${id}`, { headers: { Authorization: `Bearer ${await token(email)}` } }), e, { waitUntil() {} });
  return { status: r.status, body: await r.json() };
};

test('/mutation asks the overlay first: pending, applied, failed answer with no Coda call', async () => {
  for (const [state, want] of [['pending', { completed: false }], ['applied', { completed: true }], ['failed', { completed: false, failed: true }]]) {
    coda = [];
    const d = doStub(state);
    const out = await get(env({ OVERLAY_MODE: 'live', OVERLAY: d.ns }), 'lead@x.org');
    assert.equal(out.status, 200); assert.deepEqual(out.body, want, state);
    assert.deepEqual(d.calls.map((c) => [c.path, c.body.requestId]), [['/status', 'mut-1']]);
    assert.equal(coda.length, 0, `${state}: no Coda call`);
  }
});

test('/mutation: a DO miss makes exactly one Coda call; overlay off never asks the DO', async () => {
  coda = [];
  let d = doStub(null);
  let out = await get(env({ OVERLAY_MODE: 'live', OVERLAY: d.ns }), 'lead@x.org');
  assert.deepEqual(out.body, { completed: true });
  assert.equal(coda.length, 1); assert.match(coda[0], /\/mutationStatus\/mut-1$/);
  coda = []; d = doStub('applied');
  out = await get(env({ OVERLAY_MODE: 'off', OVERLAY: d.ns }), 'lead@x.org');
  assert.deepEqual(out.body, { completed: true });
  assert.equal(d.calls.length, 0); assert.equal(coda.length, 1);
});

test('/mutation keeps its canWrite gate: a member without a write role gets 403 and no DO call', async () => {
  coda = [];
  const d = doStub('applied');
  const out = await get(env({ OVERLAY_MODE: 'live', OVERLAY: d.ns }), 'mem@x.org');
  assert.equal(out.status, 403);
  assert.equal(d.calls.length, 0); assert.equal(coda.length, 0);
});

// ── Task 4: the planning routes read their own writes ─────────────────────────────
const res = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const COLS = [
  { id: 'c-title', name: 'Title', format: { type: 'text' } },
  { id: 'c-status', name: 'Status', format: { type: 'select' } },
  { id: 'c-edited', name: 'Edited by', format: { type: 'lookup', table: { id: REF_TABLES.people } } },
  { id: 'c-created', name: 'Created by', format: { type: 'lookup', table: { id: REF_TABLES.people } } },
];
// A stubbed Coda planning table that never applies anything: reads keep the old values.
function planningCoda({ columnsStatus = 200 } = {}) {
  const rows = new Map([['i-row', { id: 'i-row', values: { Title: 'Old', Status: 'Proposed' } }]]);
  const writes = [];
  let n = 0;
  const route = async (u, init) => {
    const m = init.method || 'GET';
    if (/\/tables\/grid-plan\/columns/.test(u)) return columnsStatus === 200 ? res(200, { items: COLS }) : res(columnsStatus, {});
    const one = /\/tables\/grid-plan\/rows\/([^/?]+)/.exec(u);
    if (one && m === 'GET') { const r = rows.get(decodeURIComponent(one[1])); return r ? res(200, r) : res(404, { message: 'nope' }); }
    if (one) { writes.push({ m, u, body: init.body }); return res(202, { requestId: `req-${++n}`, id: decodeURIComponent(one[1]) }); }
    if (/\/tables\/grid-plan\/rows/.test(u) && m === 'POST') { writes.push({ m, u, body: init.body }); return res(202, { requestId: `req-${++n}`, addedRowIds: ['i-new'] }); }
    if (/\/tables\/grid-plan\/rows/.test(u)) return res(200, { items: [...rows.values()] });
    return undefined;
  };
  return { rows, writes, route };
}
// The real WriteOverlay on Map storage, behind a namespace stub that logs paths and can fail them.
function overlayDO() {
  const m = new Map();
  const storage = {
    async get(k) { return m.has(k) ? structuredClone(m.get(k)) : undefined; },
    async put(k, v) { m.set(k, structuredClone(v)); },
    async delete(k) { return m.delete(k); },
    async list({ prefix = '' } = {}) { return new Map([...m.keys()].sort().filter((k) => k.startsWith(prefix)).map((k) => [k, structuredClone(m.get(k))])); },
    alarm: null, async setAlarm(t) { this.alarm = t; }, async getAlarm() { return this.alarm; },
  };
  const obj = new WriteOverlay({ storage }, {});
  const calls = [], fail = new Set();
  const stub = { fetch: async (u, init) => {
    const path = new URL(u).pathname; calls.push(path);
    if (fail.has(path)) return new Response('{"error":"boom"}', { status: 500 });
    return obj.fetch(new Request(u, init));
  } };
  return { calls, fail, core: obj.core, ns: { idFromName: (n) => n, get: () => stub } };
}
const realNow = Date.now;
let skew = 0;
Date.now = () => realNow() + skew;
const ctxs = () => { const p = []; return { p, waitUntil: (x) => { p.push(x); } }; };
async function call(e, method, path, { email = 'lead@x.org', body } = {}) {
  const ctx = ctxs();
  const headers = { Authorization: `Bearer ${await token(email)}` };
  const r = await worker.fetch(new Request(`https://w${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), e, ctx);
  const text = await r.text();
  await Promise.allSettled(ctx.p);
  let j = null; try { j = JSON.parse(text); } catch (_) {}
  return { status: r.status, body: j, text };
}
const live = (o = {}) => { const d = overlayDO(); return { d, e: env({ ALLOW_WRITES: 'true', OVERLAY_MODE: 'live', OVERLAY: d.ns, ...o }) }; };
const titleOf = (out, id = 'i-row') => (out.body.items.find((x) => x.id === id) || {}).values?.Title;
const put = (e, title = 'New') => call(e, 'PUT', '/rows/i-row', { body: { row: { cells: [{ column: 'Title', value: title }] } } });

test('/rows GET after a recorded PUT returns the new value while Coda still has the old one', async () => {
  skew = 0; const c = planningCoda(); codaRoute = c.route;
  const { e } = live();
  const w = await put(e);
  assert.equal(w.status, 202);
  const out = await call(e, 'GET', '/rows');
  assert.equal(out.status, 200);
  assert.equal(titleOf(out), 'New');
  assert.equal('stale' in out.body, false, 'stale is never returned to the app');
  codaRoute = null;
});

test('/rows: a snapshot stamped before appliedAt, served 4 min later, still has the write; a later one does not', async () => {
  skew = 0; const c = planningCoda(); codaRoute = c.route;
  const { d, e } = live();
  const t0 = Date.now();
  await put(e);
  const q = await d.core.storage.get('q:req-1');
  await d.core.setState('req-1', q, 'applied', t0 + 28_000);
  const oldRows = [{ id: 'i-row', values: { Title: 'Old', Status: 'Proposed' } }];
  await e.CACHE.put(ROWS_KV_KEY, JSON.stringify({ at: t0 + 20_000, data: oldRows }));
  skew = 240_000;
  let out = await call(e, 'GET', '/rows');
  assert.equal(titleOf(out), 'New');
  await e.CACHE.put(ROWS_KV_KEY, JSON.stringify({ at: t0 + 60_000, data: oldRows }));   // past appliedAt + margin: Coda's copy wins
  out = await call(e, 'GET', '/rows');
  assert.equal(titleOf(out), 'Old');
  skew = 0; codaRoute = null;
});

test('/rows PUT answers overlaid:true; with the DO failing it answers overlaid:false and still busts', async () => {
  skew = 0; const c = planningCoda(); codaRoute = c.route;
  let { d, e } = live();
  await e.CACHE.put(ROWS_KV_KEY, JSON.stringify({ at: Date.now(), data: [] }));
  let w = await put(e);
  assert.equal(w.status, 202); assert.equal(w.body.overlaid, true); assert.equal(w.body.requestId, 'req-1');
  assert.equal(await e.CACHE.get(ROWS_KV_KEY), null, 'busted');
  ({ d, e } = live()); d.fail.add('/record');
  w = await put(e);
  assert.equal(w.status, 202); assert.equal(w.body.overlaid, false); assert.equal(w.body.requestId, 'req-2');
  codaRoute = null;
});

test('/rows POST answers addedRowIds, requestId and overlaid; the new row reads back at once', async () => {
  skew = 0; const c = planningCoda(); codaRoute = c.route;
  const { e } = live();
  const w = await call(e, 'POST', '/rows', { body: { rows: [{ cells: [{ column: 'Title', value: 'Fresh' }] }] } });
  assert.equal(w.status, 202);
  assert.deepEqual(w.body, { requestId: 'req-1', addedRowIds: ['i-new'], overlaid: true });
  const out = await call(e, 'GET', '/rows');
  assert.equal(titleOf(out, 'i-new'), 'Fresh');
  codaRoute = null;
});

test('/rows DELETE reads the row through the overlay and answers overlaid', async () => {
  skew = 0; const c = planningCoda(); codaRoute = c.route;
  const { d, e } = live();
  const w = await call(e, 'DELETE', '/rows/i-row');
  assert.equal(w.status, 202); assert.equal(w.body.overlaid, true);
  assert.deepEqual(d.calls, ['/read', '/record']);
  const out = await call(e, 'GET', '/rows');
  assert.equal(out.body.items.some((x) => x.id === 'i-row'), false, 'the pending delete hides the row');
  assert.equal((await call(e, 'DELETE', '/rows/missing')).status, 404, 'a Coda 404 stays a 404');
  codaRoute = null;
});

const pendingStatus = async (d, value = 'Approved') => d.core.record([{ tableId: 'grid-plan', rowId: 'i-row', key: 'Status', keying: 'name', value, op: 'set', requestId: 'req-x', writtenAt: Date.now() }]);
const EB = { EVENTBRITE_TOKEN: 'eb', EVENTBRITE_ORG_ID: 'org' };

test('publish reads a pending Status Approved from the overlay although Coda says Proposed', async () => {
  skew = 0; const c = planningCoda(); codaRoute = c.route;
  const { d, e } = live(EB);
  await pendingStatus(d);
  const out = await call(e, 'POST', '/publish/eventbrite', { body: { rowId: 'i-row' } });
  assert.equal(out.status, 409);   // other readiness checks still fail
  assert.equal(out.body.checks.some((x) => x.key === 'approved'), false, 'approval came from the overlay');
  codaRoute = null;
});

const pendingCell = async (d, key, value, rowId = 'i-row', op = 'set', requestId = 'req-y') =>
  d.core.record([{ tableId: 'grid-plan', rowId, key, keying: 'name', value, op, requestId, writtenAt: Date.now() }]);

test('publish, cancel, unpublish and DELETE answer 409 "still being saved" when the row itself is stale', async () => {
  skew = 0; const c = planningCoda(); codaRoute = c.route;
  for (const [method, path] of [['POST', '/publish/eventbrite'], ['POST', '/cancel/eventbrite'], ['POST', '/unpublish/eventbrite'], ['DELETE', '/rows/i-row']]) {
    const { d, e } = live(EB);
    await pendingCell(d, 'Mystery', 'x');   // a column /columns doesn't know: this row is stale
    const out = await call(e, method, path, { body: method === 'POST' ? { rowId: 'i-row' } : undefined });
    assert.equal(out.status, 409, path);
    assert.deepEqual(out.body, { error: 'Your last update is still being saved. Try again in a few seconds.' }, path);
    assert.equal(c.writes.length, 0, `${path}: nothing written`);
  }
  codaRoute = null;
});

test('an overlay outage (stale [*]) does not block: publish proceeds on Coda\'s copy, cancel and DELETE write unoverlaid', async () => {
  skew = 0; const c = planningCoda(); codaRoute = c.route;
  let { d, e } = live(EB);
  await pendingStatus(d);
  d.fail.add('/read');
  const pub = await call(e, 'POST', '/publish/eventbrite', { body: { rowId: 'i-row' } });
  assert.equal(pub.status, 409);
  assert.equal(pub.body.checks.some((x) => x.key === 'approved'), true, "Coda's copy (Proposed), not the overlay's");
  const can = await call(e, 'POST', '/cancel/eventbrite', { body: { rowId: 'i-row' } });
  assert.equal(can.status, 200); assert.equal(can.body.overlaid, true, 'the read failed, the record did not');
  d.fail.add('/record');
  const del = await call(e, 'DELETE', '/rows/i-row');
  assert.equal(del.status, 202); assert.equal(del.body.overlaid, false);
  codaRoute = null;
});

test('an overlay outage plus `unconfirmed` answers 409 "still being saved" on publish, cancel, unpublish and DELETE', async () => {
  skew = 0; const c = planningCoda(); codaRoute = c.route;
  for (const [method, path] of [['POST', '/publish/eventbrite'], ['POST', '/cancel/eventbrite'], ['POST', '/unpublish/eventbrite'], ['DELETE', '/rows/i-row?unconfirmed=1']]) {
    const { d, e } = live(EB);
    d.fail.add('/read');   // stale ['*']
    const out = await call(e, method, path, { body: method === 'POST' ? { rowId: 'i-row', unconfirmed: true } : undefined });
    assert.equal(out.status, 409, path);
    assert.deepEqual(out.body, { error: 'Your last update is still being saved. Try again in a few seconds.' }, path);
  }
  assert.equal(c.writes.length, 0, 'nothing written');
  const { d, e } = live(EB);   // the flag alone, overlay up and the row clean: no refusal
  const can = await call(e, 'POST', '/cancel/eventbrite', { body: { rowId: 'i-row', unconfirmed: true } });
  assert.equal(can.status, 200);
  assert.deepEqual(d.calls.slice(0, 1), ['/read']);
  codaRoute = null;
});

test('a row read never borrows another row: a pending delete plus a pending insert is a 404', async () => {
  skew = 0; const c = planningCoda(); codaRoute = c.route;
  const { d, e } = live(EB);
  await d.core.record([{ tableId: 'grid-plan', rowId: 'i-row', key: '', keying: 'id', value: null, op: 'delete', requestId: 'req-d', writtenAt: Date.now() }]);
  await pendingCell(d, 'Title', 'Someone else', 'i-new', 'insert', 'req-i');
  for (const [method, path] of [['POST', '/publish/eventbrite'], ['POST', '/cancel/eventbrite'], ['DELETE', '/rows/i-row'], ['GET', '/eventbrite/status?rowId=i-row']]) {
    const out = await call(e, method, path, { body: method === 'POST' ? { rowId: 'i-row' } : undefined });
    assert.equal(out.status, 404, path); assert.equal(out.body.error, 'row not found', path);
  }
  assert.equal(c.writes.length, 0);
  codaRoute = null;
});

test('cancel writes through the overlay and reports overlaid only when every row write was', async () => {
  skew = 0; const c = planningCoda(); codaRoute = c.route;
  let { d, e } = live();
  let out = await call(e, 'POST', '/cancel/eventbrite', { email: 'lead@x.org', body: { rowId: 'i-row' } });
  assert.equal(out.status, 200);
  assert.deepEqual(out.body, { ok: true, publishStatus: '', eventbrite: 'none', requestId: 'req-1', overlaid: true });
  ({ d, e } = live()); d.fail.add('/record');
  out = await call(e, 'POST', '/cancel/eventbrite', { body: { rowId: 'i-row' } });
  assert.equal(out.body.overlaid, false);
  codaRoute = null;
});

test('OVERLAY_MODE=off: the routes answer as at base (only overlaid:false added) and never call the DO', async () => {
  skew = 0; const c = planningCoda(); codaRoute = c.route;
  const d = overlayDO();
  const e = env({ ALLOW_WRITES: 'true', OVERLAY_MODE: 'off', OVERLAY: d.ns, ...EB });
  let w = await put(e);
  assert.equal(w.status, 202); assert.deepEqual(w.body, { requestId: 'req-1', id: 'i-row', overlaid: false });
  w = await call(e, 'POST', '/rows', { body: { rows: [{ cells: [{ column: 'Title', value: 'Fresh' }] }] } });
  assert.deepEqual(w.body, { requestId: 'req-2', addedRowIds: ['i-new'], overlaid: false });
  const out = await call(e, 'GET', '/rows');
  assert.deepEqual(out.body, { items: [{ id: 'i-row', values: { Title: 'Old', Status: 'Proposed' } }] });
  const pub = await call(e, 'POST', '/publish/eventbrite', { body: { rowId: 'i-row' } });
  assert.equal(pub.status, 409); assert.equal(pub.body.checks.some((x) => x.key === 'approved'), true);
  const can = await call(e, 'POST', '/cancel/eventbrite', { body: { rowId: 'i-row' } });
  assert.deepEqual(can.body, { ok: true, publishStatus: '', eventbrite: 'none', requestId: 'req-3', overlaid: false });
  const del = await call(e, 'DELETE', '/rows/i-row');
  assert.deepEqual(del.body, { requestId: 'req-4', id: 'i-row', overlaid: false });
  assert.equal(d.calls.length, 0, 'no DO call');
  assert.equal(c.writes.some((x) => /\/columns/.test(x.u)), false);
  codaRoute = null;
});

test('/rows?fresh=1 stamps the refilled snapshot before the Coda read', async () => {
  skew = 0; const c = planningCoda();
  codaRoute = async (u, init) => { if (/\/rows\?/.test(u)) skew += 10_000; return c.route(u, init); };   // the read takes 10 s
  const e = env();
  const before = Date.now();
  await call(e, 'GET', '/rows?fresh=1');
  const hit = JSON.parse(await e.CACHE.get(ROWS_KV_KEY));
  assert.ok(hit.at >= before && hit.at < before + 10_000, `at ${hit.at - before} ms after the start`);
  skew = 0; codaRoute = null;
});

test('the notes column map failing on /rows is logged, not swallowed', async () => {
  skew = 0; const c = planningCoda({ columnsStatus: 500 }); codaRoute = c.route;
  const errs = []; const orig = console.error; console.error = (...a) => errs.push(a.join(' '));
  try {
    const out = await call(env({ CODA_NOTES_COL_ID: 'c-notes' }), 'GET', '/rows');
    assert.equal(out.status, 200);
  } finally { console.error = orig; }
  assert.ok(errs.some((x) => /notes/i.test(x) && /columns read failed \(500\)/.test(x)), errs.join('\n'));
  codaRoute = null;
});

test('codaWrite names an addedRowIds count mismatch', async () => {
  codaRoute = async () => res(202, { requestId: 'req-m', addedRowIds: ['only-one'] });
  const errs = []; const orig = console.error; console.error = (...a) => errs.push(a.join(' '));
  let out;
  try {
    out = await codaWrite({ OVERLAY_MODE: 'live', OVERLAY: overlayDO().ns }, { url: 'https://coda/x/rows', method: 'POST', body: { rows: [{ cells: [] }, { cells: [] }] }, tableId: 'grid-plan', op: 'insert', auth: {} });
  } finally { console.error = orig; }
  assert.equal(out.overlaid, false);
  assert.ok(errs.some((x) => /addedRowIds count mismatch/.test(x)), errs.join('\n'));
  codaRoute = null;
});

// ── Task 7 (PR B): gather, slots, claims, the roster and venues read their own writes ─────
const io = await import('../src/worker-io.js');
const { PLANNING_COLS: PC, SLOT_COLS: SC, CLAIM_COLS: CC, VENUE_COLS: VC } = await import('../src/coda-columns.js');
const GT = { CODA_SLOTS_TABLE: 'grid-slots', CODA_CLAIMS_TABLE: 'grid-claims' };
const VEN = REF_TABLES.venues;
const fenced = (s) => '```' + s + '```';
// A stubbed Coda with the planning, slots, claims and venues tables, rich and by id; never applies.
function gatherCoda() {
  const t = {
    'grid-plan': new Map([
      ['i-prop', { id: 'i-prop', values: { [PC.title]: fenced('Proposed one'), [PC.status]: fenced('Proposed'), [PC.date]: '2099-01-01T00:00:00.000-06:00', [PC.published]: false } }],
      ['i-pub', { id: 'i-pub', values: { [PC.title]: fenced('Potluck'), [PC.status]: fenced('Approved'), [PC.date]: '2099-02-01T00:00:00.000-06:00', [PC.published]: true } }],
    ]),
    'grid-slots': new Map([['i-slot', { id: 'i-slot', values: { [SC.event]: [{ rowId: 'i-pub', name: 'Potluck' }], [SC.label]: fenced('Mains'), [SC.kind]: fenced('Potluck') } }]]),
    'grid-claims': new Map([['i-old', { id: 'i-old', values: { [CC.slot]: [{ rowId: 'i-slot', name: 'Mains' }], [CC.member]: [{ rowId: 'i-mem', name: 'i-mem' }], [CC.qty]: 1 } }]]),
    [VEN]: new Map([['i-v', { id: 'i-v', name: 'Hall', values: { [VC.name]: 'Hall', [VC.type]: 'Hall' } }]]),
    [REF_TABLES['venue-types']]: new Map([['i-type', { id: 'i-type', name: 'Hall', values: {} }]]),
  };
  const PCOLS = [{ id: PC.status, name: 'Status', format: { type: 'select' } }, { id: PC.title, name: 'Title', format: { type: 'text' } }];
  const writes = [];
  let n = 0;
  const route = async (u, init) => {
    const m = init.method || 'GET';
    if (/\/tables\/grid-plan\/columns/.test(u)) return res(200, { items: PCOLS });
    const hit = /\/tables\/([^/]+)\/rows(?:\/([^/?]+))?/.exec(u);
    if (!hit || !t[hit[1]]) return undefined;
    const rows = t[hit[1]], id = hit[2] && decodeURIComponent(hit[2]);
    if (m === 'GET' && id) { const r = rows.get(id); return r ? res(200, r) : res(404, { message: 'nope' }); }
    if (m === 'GET') return res(200, { items: [...rows.values()] });
    writes.push({ m, table: hit[1], id, body: init.body && JSON.parse(init.body) });
    if (m === 'POST') return res(202, { requestId: `req-${++n}`, addedRowIds: [`i-new${n}`] });
    if (id && !rows.has(id)) return res(404, { message: 'nope' });
    return res(202, { requestId: `req-${++n}`, id });
  };
  return { t, writes, route };
}
const gLive = (o = {}) => live({ ...GT, ...o });
const slotOf = (ev, id = 'i-slot') => (ev.slots || []).find((s) => s.id === id);

test('gather: the KV key is gather-snap-v2; an old gather-events-v1 value is never read', async () => {
  skew = 0; const c = gatherCoda(); codaRoute = c.route;
  assert.equal(io.GATHER_KV_KEY, 'gather-snap-v2');
  const { e } = gLive();
  const gets = []; const get0 = e.CACHE.get; e.CACHE.get = async (k, ty) => { gets.push(k); return get0(k, ty); };
  await e.CACHE.put('gather-events-v1', JSON.stringify({ at: Date.now(), data: { events: [{ id: 'i-ghost', values: {} }], slotsByEvent: {}, claimsBySlot: {} } }));
  const out = await call(e, 'GET', '/events', { email: 'mem@x.org' });
  assert.equal(out.status, 200);
  assert.deepEqual(out.body.items.map((x) => x.id), ['i-pub']);
  assert.equal(gets.includes('gather-events-v1'), false);
  const snap = JSON.parse(await e.CACHE.get('gather-snap-v2'));
  assert.deepEqual(Object.keys(snap.data).sort(), ['claims', 'events', 'slots'], 'raw rows, not the grouped snapshot');
  codaRoute = null;
});

test('gather: an event Approved only in the overlay appears in the list', async () => {
  skew = 0; const c = gatherCoda(); codaRoute = c.route;
  const { d, e } = gLive();
  let out = await call(e, 'GET', '/events', { email: 'lead@x.org' });
  assert.deepEqual(out.body.items.map((x) => x.id), ['i-pub'], 'Proposed: not listed yet (snapshot now cached)');
  await d.core.record([{ tableId: 'grid-plan', rowId: 'i-prop', key: 'Status', keying: 'name', value: 'Approved', op: 'set', requestId: 'req-a', writtenAt: Date.now() }]);
  out = await call(e, 'GET', '/events', { email: 'lead@x.org' });
  assert.deepEqual(out.body.items.map((x) => x.id).sort(), ['i-prop', 'i-pub']);
  codaRoute = null;
});

test('gather: a claim inserted only in the overlay appears under its slot; My sign-ups and the roster count it', async () => {
  skew = 0; const c = gatherCoda(); codaRoute = c.route;
  const { e } = gLive({ EVENTBRITE_TOKEN: 'eb' });
  const w = await call(e, 'POST', '/claims', { email: 'mem@x.org', body: { slot: 'i-slot', qty: 2 } });
  assert.equal(w.status, 200); assert.deepEqual(w.body, { ok: true, id: 'i-new1', overlaid: true });
  const ev = await call(e, 'GET', '/events/i-pub', { email: 'mem@x.org' });
  assert.deepEqual(slotOf(ev.body).claims.map((x) => x.claimId).filter(Boolean).sort(), ['i-new1', 'i-old']);
  const my = await call(e, 'GET', '/me/claims', { email: 'mem@x.org' });
  assert.deepEqual(my.body.items.map((x) => x.claimId).sort(), ['i-new1', 'i-old']);
  assert.equal(my.body.items.find((x) => x.claimId === 'i-new1').qty, 2);
  const ro = await call(e, 'GET', '/roster/i-pub', { email: 'lead@x.org' });
  assert.equal(ro.status, 200);
  assert.equal(ro.body.rows[0].claims.length, 2, 'the roster counts the pending claim');
  const sl = await call(e, 'GET', '/slots?event=i-pub', { email: 'lead@x.org' });
  assert.deepEqual(sl.body.items[0].claims.map((x) => x.id).sort(), ['i-new1', 'i-old']);
  codaRoute = null;
});

test('gather: a slot inserted only in the overlay appears under its event', async () => {
  skew = 0; const c = gatherCoda(); codaRoute = c.route;
  const { e } = gLive();
  const w = await call(e, 'POST', '/slots', { body: { event: 'i-pub', label: 'Drinks', kind: 'Potluck' } });
  assert.deepEqual(w.body, { ok: true, id: 'i-new1', overlaid: true });
  const ev = await call(e, 'GET', '/events/i-pub', { email: 'mem@x.org' });
  assert.ok(slotOf(ev.body, 'i-new1'), JSON.stringify(ev.body.slots));
  assert.equal(slotOf(ev.body, 'i-new1').label, 'Drinks');
  const put1 = await call(e, 'PUT', '/slots/i-slot', { body: { label: 'Big mains' } });
  assert.equal(put1.body.overlaid, true);
  const del = await call(e, 'DELETE', '/slots/i-slot');
  assert.equal(del.body.overlaid, true);
  codaRoute = null;
});

const STILL_SAVING_CLAIM = 'Your sign-up is still being saved. Try again in a few seconds.';
test('/claims/:id on the caller\'s pending insert answers 409; on a claim Coda has, it proceeds', async () => {
  skew = 0; const c = gatherCoda(); codaRoute = c.route;
  const { e } = gLive();
  await call(e, 'POST', '/claims', { email: 'mem@x.org', body: { slot: 'i-slot' } });
  for (const method of ['DELETE', 'PUT']) {
    const out = await call(e, method, '/claims/i-new1', { email: 'mem@x.org', body: method === 'PUT' ? { qty: 3 } : undefined });
    assert.equal(out.status, 409, method); assert.deepEqual(out.body, { error: STILL_SAVING_CLAIM }, method);
  }
  const lead = await call(e, 'DELETE', '/claims/i-new1', { email: 'lead@x.org' });
  assert.equal(lead.status, 409, 'a canWrite caller too');
  assert.equal(c.writes.filter((x) => x.table === 'grid-claims' && x.m !== 'POST').length, 0, 'nothing sent to Coda');
  const ok = await call(e, 'DELETE', '/claims/i-old', { email: 'mem@x.org' });
  assert.equal(ok.status, 202); assert.equal(ok.body.overlaid, true);
  assert.equal((await call(e, 'DELETE', '/claims/i-nope', { email: 'mem@x.org' })).status, 404);
  codaRoute = null;
});

test('a claim write busts the event caches once, with no delayed second bust', async () => {
  skew = 0; const c = gatherCoda(); codaRoute = c.route;
  assert.equal('bustEventCachesNowAndAfterApply' in io, false);
  const { e } = gLive();
  const gone = []; const del0 = e.CACHE.delete; e.CACHE.delete = async (k) => { gone.push(k); return del0(k); };
  const long = []; const st0 = globalThis.setTimeout;
  globalThis.setTimeout = (fn, ms, ...a) => { if (ms >= 20_000) long.push(ms); return st0(fn, ms, ...a); };
  try { await call(e, 'POST', '/claims', { email: 'mem@x.org', body: { slot: 'i-slot' } }); }
  finally { globalThis.setTimeout = st0; }
  assert.equal(gone.filter((k) => k === io.GATHER_KV_KEY).length, 1);
  assert.deepEqual(long, []);
  codaRoute = null;
});

test('/venues PUT answers overlaid:true and /ref/venues shows the new address before Coda applies it', async () => {
  skew = 0; const c = gatherCoda(); codaRoute = c.route;
  const { e } = gLive();
  let ref = await call(e, 'GET', '/ref/venues?fresh=1');
  assert.equal(ref.body.items.find((x) => x.id === 'i-v').hasAddress, false);
  const w = await call(e, 'PUT', '/venues/i-v', { body: { street: '1 Main St', city: 'Nashville', state: 'TN', zip: '37206' } });
  assert.equal(w.status, 200); assert.equal(w.body.overlaid, true); assert.equal(w.body.requestId, 'req-1');
  ref = await call(e, 'GET', '/ref/venues');
  assert.equal(ref.body.items.find((x) => x.id === 'i-v').hasAddress, true);
  const one = await call(e, 'GET', '/venues/i-v');
  assert.equal(one.body.street, '1 Main St');
  const addr = { street: '2 Side St', city: 'Nashville', state: 'TN', zip: '37206' };
  const add = await call(e, 'POST', '/venues', { body: { name: 'Annex', typeId: 'i-type', ...addr } });
  assert.equal(add.status, 200); assert.equal(add.body.overlaid, true); assert.equal(add.body.requestId, 'req-2');
  const again = await call(e, 'POST', '/venues', { body: { name: 'annex', typeId: 'i-type', ...addr } });
  assert.equal(again.status, 409, 'the duplicate check sees the venue Coda has not applied yet');
  assert.equal(again.body.error, 'A venue called Annex already exists');
  codaRoute = null;
});

test('PR B with OVERLAY_MODE=off: writes answer overlaid:false and the DO is never called', async () => {
  skew = 0; const c = gatherCoda(); codaRoute = c.route;
  const d = overlayDO();
  const e = env({ ALLOW_WRITES: 'true', OVERLAY_MODE: 'off', OVERLAY: d.ns, ...GT });
  const w = await call(e, 'POST', '/claims', { email: 'mem@x.org', body: { slot: 'i-slot' } });
  assert.deepEqual(w.body, { ok: true, id: 'i-new1', overlaid: false });
  const ev = await call(e, 'GET', '/events/i-pub', { email: 'mem@x.org' });
  assert.deepEqual(slotOf(ev.body).claims.map((x) => x.claimId).filter(Boolean), ['i-old']);
  assert.equal((await call(e, 'DELETE', '/claims/i-new1', { email: 'mem@x.org' })).status, 404, 'as today: Coda has no such claim');
  const v = await call(e, 'PUT', '/venues/i-v', { body: { street: '1 Main St', city: 'Nashville', state: 'TN', zip: '37206' } });
  assert.equal(v.body.overlaid, false);
  assert.equal(d.calls.length, 0);
  codaRoute = null;
});
