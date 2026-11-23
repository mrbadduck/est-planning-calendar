import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  OverlayCore, WriteOverlay,
  APPLY_MARGIN_MS, FAIL_AFTER_MS, SWR_HARD_MS, KEEP_MS, ALARM_EVERY_MS, POLLS_PER_ALARM,
} from '../src/overlay-do.js';

// ── stubs: Map-backed DO storage, a Coda fetch that answers mutationStatus, a clock ──
function storageStub() {
  const m = new Map();
  return {
    m, alarm: null, alarmSets: [],
    async get(k) { return m.has(k) ? structuredClone(m.get(k)) : undefined; },
    async put(k, v) { m.set(k, structuredClone(v)); },
    async delete(k) { return m.delete(k); },
    async list({ prefix = '' } = {}) {
      return new Map([...m.keys()].sort().filter((k) => k.startsWith(prefix)).map((k) => [k, structuredClone(m.get(k))]));
    },
    async setAlarm(t) { this.alarm = t; this.alarmSets.push(t); },
    async getAlarm() { return this.alarm; },
    async deleteAlarm() { this.alarm = null; },
  };
}
const res = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
function codaStub(completed = new Set()) {
  const calls = [];
  const fn = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method || 'GET', headers: init.headers || {} });
    const id = decodeURIComponent(String(url).split('/mutationStatus/')[1] || '');
    return res(200, { completed: completed.has(id) });
  };
  return { fn, calls, completed };
}
const ENV = { CODA_API_BASE: 'https://coda.test', CODA_API_TOKEN: 'tok' };
function setup(t0 = 1_000_000) {
  const clock = { t: t0 };
  const storage = storageStub(), coda = codaStub();
  const core = new OverlayCore(storage, ENV, coda.fn, () => clock.t);
  // The runtime clears the alarm before it calls alarm().
  const runAlarm = async () => { storage.alarm = null; await core.alarm(); };
  return { clock, storage, coda, core, runAlarm };
}
const entry = (o = {}) => ({ tableId: 'grid-P', rowId: 'i-1', key: 'Title', keying: 'name', value: 'Shabbat',
  op: 'set', requestId: 'req-1', writtenAt: 1_000_000, ...o });

test('constants are the plan\'s values', () => {
  assert.equal(APPLY_MARGIN_MS, 30_000); assert.equal(FAIL_AFTER_MS, 120_000);
  assert.equal(SWR_HARD_MS, 300_000); assert.equal(KEEP_MS, 330_000);
  assert.equal(ALARM_EVERY_MS, 5_000); assert.equal(POLLS_PER_ALARM, 10);
});

test('record then read returns the entry as pending; status says pending; alarm set', async () => {
  const { core, storage, clock } = setup();
  assert.deepEqual(await core.record([entry()]), { ok: true });
  const got = await core.read('grid-P');
  assert.equal(got.length, 1);
  assert.equal(got[0].state, 'pending'); assert.equal(got[0].appliedAt, null);
  assert.equal(got[0].value, 'Shabbat'); assert.equal(got[0].keying, 'name');
  assert.ok(storage.m.has('e:grid-P:i-1:Title:1000000'));
  assert.deepEqual(storage.m.get('q:req-1'), { state: 'pending', writtenAt: 1_000_000, appliedAt: null });
  assert.equal(await core.status('req-1'), 'pending');
  assert.equal(storage.alarm, clock.t + ALARM_EVERY_MS);
  assert.deepEqual(await core.read('grid-Other'), []);
});

test('record leaves an alarm that is already sooner than now + 5 s alone', async () => {
  const { core, storage, clock } = setup();
  storage.alarm = clock.t + 1_000;
  await core.record([entry()]);
  assert.equal(storage.alarm, clock.t + 1_000);
});

test('record re-sets an overdue alarm (one that should already have run) to now + 5 s', async () => {
  const { core, storage, clock } = setup();
  storage.alarm = clock.t - 60_000;                   // seen locally: an alarm left in the past never fired again
  await core.record([entry()]);
  assert.equal(storage.alarm, clock.t + ALARM_EVERY_MS);
});

test('record pulls a far-off cleanup alarm forward so a new write is polled in 5 s', async () => {
  const { core, coda, clock, storage, runAlarm } = setup();
  await core.record([entry()]);
  coda.completed.add('req-1');
  clock.t += 6_000;
  await runAlarm();                                   // req-1 applied; alarm re-armed at the deletion time
  assert.equal(await core.status('req-1'), 'applied');
  assert.equal(storage.alarm, clock.t + KEEP_MS);
  await core.record([entry({ requestId: 'req-2', rowId: 'i-2', writtenAt: clock.t })]);
  assert.equal(storage.alarm, clock.t + ALARM_EVERY_MS, 'pulled forward to now + ALARM_EVERY_MS');
  coda.completed.add('req-2');
  clock.t += ALARM_EVERY_MS;
  const before = coda.calls.length;
  await runAlarm();
  assert.ok(coda.calls.slice(before).some((c) => c.url.endsWith('/req-2')), 'the next alarm polls the new write');
  assert.equal(await core.status('req-2'), 'applied');
});

test('an insert is one entry per cell; a delete has key ""; read returns them all', async () => {
  const { core } = setup();
  await core.record([
    entry({ op: 'insert', key: 'c-a', keying: 'id', rowId: 'tmp', requestId: 'r-ins' }),
    entry({ op: 'insert', key: 'c-b', keying: 'id', rowId: 'tmp', requestId: 'r-ins', value: 2 }),
    entry({ op: 'delete', key: '', value: null, rowId: 'i-9', requestId: 'r-del' }),
  ]);
  const got = await core.read('grid-P');
  assert.equal(got.length, 3);
  assert.deepEqual(got.map((e) => e.op).sort(), ['delete', 'insert', 'insert']);
  assert.equal(await core.status('r-ins'), 'pending'); assert.equal(await core.status('r-del'), 'pending');
});

test('status of an unknown requestId is null', async () => {
  const { core } = setup();
  assert.equal(await core.status('nope'), null);
});

test('alarm: completed makes every entry of that requestId applied at now', async () => {
  const { core, coda, clock, runAlarm } = setup();
  await core.record([entry(), entry({ key: 'Date', value: '2026-12-01' }), entry({ requestId: 'req-2', rowId: 'i-2' })]);
  coda.completed.add('req-1');
  clock.t += 6_000;
  await runAlarm();
  assert.equal(coda.calls.length, 2);
  assert.equal(coda.calls[0].url, 'https://coda.test/mutationStatus/req-1');
  assert.equal(coda.calls[0].headers.Authorization, 'Bearer tok');
  const got = await core.read('grid-P');
  for (const e of got.filter((x) => x.requestId === 'req-1')) { assert.equal(e.state, 'applied'); assert.equal(e.appliedAt, clock.t); }
  assert.equal(got.find((x) => x.requestId === 'req-2').state, 'pending');
  assert.equal(await core.status('req-1'), 'applied');
  assert.equal(await core.status('req-2'), 'pending');
});

test('alarm: 121 s old and not completed is failed and is not polled again', async () => {
  const { core, coda, clock, runAlarm } = setup();
  await core.record([entry()]);
  clock.t += 121_000;
  await runAlarm();
  assert.equal(coda.calls.length, 1);
  assert.equal(await core.status('req-1'), 'failed');
  assert.equal((await core.read('grid-P'))[0].state, 'failed');
  clock.t += 5_000;
  await runAlarm();
  assert.equal(coda.calls.length, 1, 'a failed requestId is not polled again');
});

test('alarm: a mutationStatus fetch that throws leaves it pending, with a console line', async () => {
  const { core, clock, storage } = setup();
  const errs = []; const realErr = console.error; console.error = (...a) => errs.push(a.join(' '));
  try {
    const c = new OverlayCore(storage, ENV, async () => { throw new Error('down'); }, () => clock.t);
    await c.record([entry()]);
    clock.t += 6_000;
    storage.alarm = null; await c.alarm();
    assert.equal(await c.status('req-1'), 'pending');
    assert.ok(errs.some((l) => l.includes('req-1') && l.includes('down')), 'logs the failure');
  } finally { console.error = realErr; }
  void core;
});

test('alarm: a non-200 mutationStatus leaves it pending, with a console line', async () => {
  const { clock, storage } = setup();
  const errs = []; const realErr = console.error; console.error = (...a) => errs.push(a.join(' '));
  try {
    const c = new OverlayCore(storage, ENV, async () => res(400, { message: 'bad id' }), () => clock.t);
    await c.record([entry()]);
    clock.t += 6_000;
    storage.alarm = null; await c.alarm();
    assert.equal(await c.status('req-1'), 'pending');
    assert.ok(errs.some((l) => l.includes('req-1') && l.includes('400')));
  } finally { console.error = realErr; }
});

test('alarm: with 12 pending requestIds one alarm polls exactly 10, oldest first', async () => {
  const { core, coda, clock, runAlarm } = setup();
  for (let i = 0; i < 12; i++) await core.record([entry({ requestId: 'r' + i, rowId: 'i-' + i, writtenAt: 1_000_000 - (12 - i) * 100 })]);
  clock.t += 1_000;
  await runAlarm();
  assert.equal(coda.calls.length, 10);
  assert.deepEqual(coda.calls.map((c) => c.url.split('/').pop()), ['r0', 'r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'r7', 'r8', 'r9']);
});

test('alarm: an applied entry is gone after appliedAt + KEEP_MS; a failed one after writtenAt + KEEP_MS', async () => {
  const { core, coda, clock, storage, runAlarm } = setup();
  await core.record([entry({ requestId: 'ok' }), entry({ requestId: 'bad', rowId: 'i-2' })]);
  coda.completed.add('ok');
  clock.t += 121_000;                       // ok -> applied at t0+121s; bad -> failed (written t0)
  await runAlarm();
  assert.equal(await core.status('ok'), 'applied'); assert.equal(await core.status('bad'), 'failed');
  const appliedAt = clock.t;
  clock.t = 1_000_000 + KEEP_MS;            // bad is due; ok is not
  await runAlarm();
  assert.equal(await core.status('bad'), null);
  assert.deepEqual((await core.read('grid-P')).map((e) => e.requestId), ['ok']);
  clock.t = appliedAt + KEEP_MS - 1;
  await runAlarm();
  assert.equal(await core.status('ok'), 'applied');
  clock.t = appliedAt + KEEP_MS;
  await runAlarm();
  assert.equal(await core.status('ok'), null);
  assert.deepEqual(await core.read('grid-P'), []);
  assert.equal(storage.m.size, 0);
});

test('alarm: re-arms in 5 s while pending, at the earliest deletion once none pending, nothing once empty', async () => {
  const { core, coda, clock, storage, runAlarm } = setup();
  await core.record([entry()]);
  clock.t += 6_000;
  await runAlarm();
  assert.equal(storage.alarm, clock.t + ALARM_EVERY_MS, 'pending -> 5 s');
  coda.completed.add('req-1');
  clock.t += 5_000;
  await runAlarm();
  const appliedAt = clock.t;
  assert.equal(storage.alarm, appliedAt + KEEP_MS, 'none pending -> earliest deletion');
  clock.t = appliedAt + KEEP_MS;
  await runAlarm();
  assert.equal(storage.m.size, 0);
  assert.equal(storage.alarm, null, 'empty -> no alarm');
});

test('alarm: makes no KV call and no Publish Log POST', async () => {
  const { core, coda, clock, storage } = setup();
  const kvCalls = [];
  const kv = new Proxy({}, { get: (_, p) => (...a) => { kvCalls.push([p, ...a]); return null; } });
  const c = new OverlayCore(storage, { ...ENV, CACHE: kv, CODA_PUBLISH_LOG_TABLE: 'grid-LOG', CODA_DOC_ID: 'D' }, coda.fn, () => clock.t);
  await c.record([entry()]);
  coda.completed.add('req-1');
  clock.t += 6_000;
  storage.alarm = null; await c.alarm();
  assert.equal(await c.status('req-1'), 'applied');
  assert.deepEqual(kvCalls, []);
  assert.ok(coda.calls.length > 0);
  assert.ok(coda.calls.every((x) => x.method === 'GET' && x.url.includes('/mutationStatus/')));
  void core;
});

test('WriteOverlay.fetch routes /record, /read and /status, and answers 404 otherwise', async () => {
  const storage = storageStub();
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('no network in tests'); };
  try {
    const dobj = new WriteOverlay({ storage }, ENV);
    const post = (path, body) => dobj.fetch(new Request('https://overlay' + path, { method: 'POST', body: JSON.stringify(body) }));
    let r = await post('/record', { entries: [entry({ writtenAt: Date.now() })] });
    assert.equal(r.status, 200); assert.deepEqual(await r.json(), { ok: true });
    r = await post('/read', { tableId: 'grid-P' });
    assert.equal(r.status, 200);
    const { entries } = await r.json();
    assert.equal(entries.length, 1); assert.equal(entries[0].state, 'pending');
    r = await post('/status', { requestId: 'req-1' });
    assert.deepEqual(await r.json(), { state: 'pending' });
    r = await post('/status', { requestId: 'zzz' });
    assert.deepEqual(await r.json(), { state: null });
    r = await post('/nope', {});
    assert.equal(r.status, 404);
    r = await dobj.fetch(new Request('https://overlay/read', { method: 'GET' }));
    assert.equal(r.status, 404);
  } finally { globalThis.fetch = realFetch; }
});

test('WriteOverlay.fetch answers 400 on a body that is not JSON or has no entries array', async () => {
  const errs = []; const realErr = console.error; console.error = (...a) => errs.push(a.join(' '));
  try {
    const dobj = new WriteOverlay({ storage: storageStub() }, ENV);
    let r = await dobj.fetch(new Request('https://overlay/record', { method: 'POST', body: 'not json' }));
    assert.equal(r.status, 400);
    r = await dobj.fetch(new Request('https://overlay/record', { method: 'POST', body: JSON.stringify({ entries: 'x' }) }));
    assert.equal(r.status, 400);
    assert.ok(errs.length >= 2, 'each refusal logs a line');
  } finally { console.error = realErr; }
});

test('worker.js still imports under node and exports WriteOverlay', async () => {
  const mod = await import('../src/worker.js');
  assert.equal(mod.WriteOverlay, WriteOverlay);
  assert.equal(typeof mod.default.fetch, 'function');
});

test('record refuses the whole batch when any entry is malformed, and arms no alarm', async () => {
  const bad = [
    { writtenAt: 'soon' }, { writtenAt: NaN }, { writtenAt: undefined }, { tableId: '' }, { rowId: 7 },
    { requestId: '' }, { key: undefined }, { op: 'upsert' }, { keying: 'label' },
  ];
  for (const b of bad) {
    const { core, storage } = setup();
    const out = await core.record([entry(), entry({ rowId: 'i-2', ...b })]);
    assert.equal(out.ok, false, JSON.stringify(b)); assert.match(out.error, /^entry 1: /);
    assert.equal(storage.m.size, 0, 'nothing stored'); assert.equal(storage.alarm, null, 'no alarm');
  }
  const { core } = setup();
  assert.equal((await core.record([null])).ok, false);
  assert.equal((await core.record('x')).ok, false);
});

test('WriteOverlay /record answers 400 with a console line on a malformed entry and arms no alarm', async () => {
  const errs = []; const realErr = console.error; console.error = (...a) => errs.push(a.join(' '));
  try {
    const storage = storageStub();
    const dobj = new WriteOverlay({ storage }, ENV);
    const r = await dobj.fetch(new Request('https://overlay/record', { method: 'POST', body: JSON.stringify({ entries: [entry({ writtenAt: 'x' })] }) }));
    assert.equal(r.status, 400);
    assert.match((await r.json()).error, /writtenAt/);
    assert.equal(storage.m.size, 0); assert.equal(storage.alarm, null);
    assert.ok(errs.some((l) => l.includes('/record refused')));
  } finally { console.error = realErr; }
});

test('WriteOverlay /read and /status without their field answer 400', async () => {
  const errs = []; const realErr = console.error; console.error = (...a) => errs.push(a.join(' '));
  try {
    const dobj = new WriteOverlay({ storage: storageStub() }, ENV);
    const post = (path, body) => dobj.fetch(new Request('https://overlay' + path, { method: 'POST', body: JSON.stringify(body) }));
    for (const [p, b] of [['/read', {}], ['/read', { tableId: '' }], ['/status', {}], ['/status', { requestId: 5 }], ['/read', null]])
      assert.equal((await post(p, b)).status, 400, p + ' ' + JSON.stringify(b));
    assert.equal(errs.length, 5);
  } finally { console.error = realErr; }
});

test('entries recorded for an applied or failed requestId inherit its state and age out', async () => {
  const { core, coda, clock, storage, runAlarm } = setup();
  await core.record([entry({ requestId: 'ok' }), entry({ requestId: 'bad', rowId: 'i-2' })]);
  coda.completed.add('ok');
  clock.t += 121_000;
  await runAlarm();
  const appliedAt = clock.t;
  await core.record([entry({ requestId: 'ok', key: 'Date', writtenAt: clock.t }), entry({ requestId: 'bad', rowId: 'i-2', key: 'Date', writtenAt: clock.t })]);
  const late = await core.read('grid-P');
  assert.deepEqual(late.find((e) => e.requestId === 'ok' && e.key === 'Date').state, 'applied');
  assert.equal(late.find((e) => e.requestId === 'ok' && e.key === 'Date').appliedAt, appliedAt);
  assert.equal(late.find((e) => e.requestId === 'bad' && e.key === 'Date').state, 'failed');
  clock.t += 6_000;
  await runAlarm();
  assert.notEqual(storage.alarm, clock.t + ALARM_EVERY_MS, 'nothing pending, so no 5 s re-arm');
  clock.t = appliedAt + KEEP_MS + 1;
  await runAlarm();
  assert.equal(storage.m.size, 0); assert.equal(storage.alarm, null);
});

test('cleanup ages out a stray pending entry whose q: record is not pending or is gone', async () => {
  const { core, clock, storage, runAlarm } = setup();
  storage.m.set('q:done', { state: 'failed', writtenAt: 1_000_000, appliedAt: null });
  storage.m.set('e:grid-P:i-1:Title:1000000', { ...entry({ requestId: 'done' }), state: 'pending', appliedAt: null });
  storage.m.set('e:grid-P:i-3:Title:1000000', { ...entry({ requestId: 'orphan', rowId: 'i-3' }), state: 'pending', appliedAt: null });
  await runAlarm();
  assert.equal(storage.alarm, 1_000_000 + KEEP_MS, 'stray entries count as resolved: armed at their deletion');
  clock.t = 1_000_000 + KEEP_MS;
  await runAlarm();
  assert.equal(storage.m.size, 0); assert.equal(storage.alarm, null);
  void core;
});
