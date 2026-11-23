import { test } from 'node:test';
import assert from 'node:assert/strict';
import { publishLogCells, logPublishMany, readAllRows, bustEventCaches, bustEventCachesNowAndAfterApply, ROWS_KV_KEY, GATHER_KV_KEY } from '../src/worker-io.js';

const cell = (cells, col) => cells.find((c) => c.column === col).value;

test('publishLogCells: defaults Target to Eventbrite and prefixes system actions', () => {
  const cells = publishLogCells({ action: 'import', ok: true, ebId: '1', via: 'eventbrite' }, '2026-11-19T00:00:00Z');
  assert.equal(cell(cells, 'Target'), 'Eventbrite');
  assert.equal(cell(cells, 'Action'), 'import');
  assert.equal(cell(cells, 'Result'), 'ok');
  assert.equal(cell(cells, 'When'), '2026-11-19T00:00:00Z');
  assert.ok(cell(cells, 'Message').startsWith('[eventbrite] '));
  assert.deepEqual(cell(cells, 'Actor'), []);
});
test('publishLogCells: rec.target fills Target; sweep prefix; actor keeps plain message', () => {
  const g = publishLogCells({ action: 'create', ok: false, target: 'gCal', via: 'sweep' }, 'now');
  assert.equal(cell(g, 'Target'), 'gCal');
  assert.equal(cell(g, 'Result'), 'error');
  assert.ok(cell(g, 'Message').startsWith('[sweep] '));
  const a = publishLogCells({ action: 'publish', ok: true, actorId: 'i-1', rowId: 'r-1', message: 'hi' }, 'now');
  assert.equal(cell(a, 'Message'), 'hi');
  assert.deepEqual(cell(a, 'Actor'), ['i-1']);
  assert.deepEqual(cell(a, 'Planning Event'), ['r-1']);
});

test('bustEventCaches deletes the rows and gather snapshots', async () => {
  const gone = [];
  await bustEventCaches({ CACHE: { delete: async (k) => { gone.push(k); } } });
  assert.deepEqual(gone.sort(), [GATHER_KV_KEY, ROWS_KV_KEY].sort());
  await bustEventCaches({});   // no binding: no throw
});

test('bustEventCachesNowAndAfterApply busts both keys now and again after the delay', async () => {
  const gone = []; const pending = [];
  const env = { CACHE: { delete: async (k) => { gone.push(k); } } };
  await bustEventCachesNowAndAfterApply(env, { waitUntil: (p) => pending.push(p) }, 0);
  assert.equal(gone.length, 2);   // immediate bust
  await Promise.all(pending);
  assert.deepEqual(gone.slice().sort(), [GATHER_KV_KEY, GATHER_KV_KEY, ROWS_KV_KEY, ROWS_KV_KEY].sort());
  assert.equal(pending.length, 1);
});

test('logPublishMany: every record in one Publish Log insert; nothing to log, no call', async () => {
  const real = globalThis.fetch, calls = [];
  globalThis.fetch = async (u, init) => { calls.push({ u, body: JSON.parse(init.body) }); return new Response('{}', { status: 202 }); };
  try {
    const env = { CODA_PUBLISH_LOG_TABLE: 'LOG' };
    await logPublishMany(env, 'https://c', 'D', {}, [{ action: 'import', ok: true, via: 'sweep' }, { action: 'removed', ok: true, via: 'sweep' }]);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].u, 'https://c/docs/D/tables/LOG/rows');
    assert.equal(calls[0].body.rows.length, 2);
    assert.equal(cell(calls[0].body.rows[1].cells, 'Action'), 'removed');
    await logPublishMany(env, 'https://c', 'D', {}, []);
    assert.equal(calls.length, 1);
    globalThis.fetch = async () => { throw new Error('down'); };
    await logPublishMany(env, 'https://c', 'D', {}, [{ action: 'x', ok: true }]);   // never throws
  } finally { globalThis.fetch = real; }
});
test('readAllRows: truncated when it stops at its page cap', async () => {
  const real = globalThis.fetch; let n = 0;
  globalThis.fetch = async () => { n++; return new Response(JSON.stringify({ items: [{ id: 'r' + n }], nextPageToken: 'more' }), { status: 200 }); };
  try {
    const out = await readAllRows('https://c/rows', {});
    assert.equal(out.ok, true); assert.equal(out.truncated, true); assert.equal(out.items.length, 6);
    globalThis.fetch = async () => new Response(JSON.stringify({ items: [{ id: 'a' }] }), { status: 200 });
    assert.equal((await readAllRows('https://c/rows', {})).truncated, false);
  } finally { globalThis.fetch = real; }
});

test('logPublishMany: a failed log write is never silent (throw or non-2xx) and never throws', async () => {
  const real = globalThis.fetch, realErr = console.error, errs = [];
  console.error = (...a) => errs.push(a.join(' '));
  try {
    const env = { CODA_PUBLISH_LOG_TABLE: 'LOG' };
    globalThis.fetch = async () => { throw new Error('down'); };
    await logPublishMany(env, 'https://c', 'D', {}, [{ action: 'a', ok: true }, { action: 'b', ok: true }]);
    globalThis.fetch = async () => new Response('nope', { status: 429 });
    await logPublishMany(env, 'https://c', 'D', {}, [{ action: 'a', ok: true }, { action: 'b', ok: true }, { action: 'c', ok: true }]);
    assert.equal(errs.length, 2);
    assert.match(errs[0], /down/); assert.match(errs[0], /2/);
    assert.match(errs[1], /429/); assert.match(errs[1], /3/);
  } finally { globalThis.fetch = real; console.error = realErr; }
});

// ── the write overlay seam (Task 3) ──
import {
  overlayOn, codaWrite, passWrite, overlayRead, overlayStatus, planningColMap, overlayNames,
  PLANNING_COLS_KV_KEY, PEOPLE_KV_KEY, VENUES_KV_KEY, refKvKey,
} from '../src/worker-io.js';
import { PLANNING_COLS, PEOPLE_COLS } from '../src/coda-columns.js';

const kvStub = (init = {}) => {
  const m = new Map(Object.entries(init).map(([k, v]) => [k, JSON.stringify(v)]));
  return { m, get: async (k, t) => (m.has(k) ? (t === 'json' ? JSON.parse(m.get(k)) : m.get(k)) : null), put: async (k, v) => { m.set(k, v); }, delete: async (k) => { m.delete(k); } };
};
// A DO namespace stub: every call lands in `calls`; `answer(path, body)` returns the reply.
const doStub = (answer) => {
  const calls = [];
  const obj = { fetch: async (u, init) => {
    const path = new URL(u).pathname, body = JSON.parse(init.body);
    calls.push({ path, body });
    return answer(path, body);
  } };
  return { calls, ns: { idFromName: (n) => `id:${n}`, get: () => obj } };
};
const ok = (b) => new Response(JSON.stringify(b), { status: 200 });
const withFetch = async (fn, body) => {
  const real = globalThis.fetch, calls = [];
  globalThis.fetch = async (u, init = {}) => { calls.push({ u: String(u), init }); return fn(String(u), init); };
  try { return await body(calls); } finally { globalThis.fetch = real; }
};
const quiet = async (body) => {
  const real = console.error, errs = []; console.error = (...a) => errs.push(a.join(' '));
  try { return await body(errs); } finally { console.error = real; }
};

test('overlayOn: live mode and a binding', () => {
  assert.equal(overlayOn({ OVERLAY_MODE: 'live', OVERLAY: {} }), true);
  assert.equal(overlayOn({ OVERLAY_MODE: 'off', OVERLAY: {} }), false);
  assert.equal(overlayOn({ OVERLAY: {} }), false);
  assert.equal(overlayOn({ OVERLAY_MODE: 'live' }), false);
});

test('codaWrite update: one Entry per cell, key as written with its keying; overlaid', async () => {
  const d = doStub(() => ok({ ok: true }));
  const env = { OVERLAY_MODE: 'live', OVERLAY: d.ns };
  const body = { row: { cells: [{ column: 'Title', value: 'New' }, { column: PLANNING_COLS.status, value: 'Approved' }] } };
  await withFetch(() => new Response(JSON.stringify({ requestId: 'mut-1', id: 'i-1' }), { status: 202 }), async (calls) => {
    const out = await codaWrite(env, { url: 'https://c/rows/i-1', method: 'PUT', body, tableId: 'grid-plan', op: 'update', rowId: 'i-1', auth: { A: 'b' } });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].init.method, 'PUT');
    assert.deepEqual(calls[0].init.headers, { A: 'b' });
    assert.deepEqual(JSON.parse(calls[0].init.body), body);
    assert.equal(out.ok, true); assert.equal(out.status, 202); assert.equal(out.requestId, 'mut-1'); assert.equal(out.overlaid, true);
    assert.equal(d.calls.length, 1); assert.equal(d.calls[0].path, '/record');
    const es = d.calls[0].body.entries;
    assert.equal(es.length, 2);
    assert.deepEqual(es.map((e) => [e.key, e.keying, e.value, e.op, e.rowId, e.tableId, e.requestId]),
      [['Title', 'name', 'New', 'set', 'i-1', 'grid-plan', 'mut-1'], [PLANNING_COLS.status, 'id', 'Approved', 'set', 'i-1', 'grid-plan', 'mut-1']]);
    assert.ok(es.every((e) => Number.isFinite(e.writtenAt)));
    const res = await passWrite(out, { 'X-C': '1' });
    assert.equal(res.status, 202);
    assert.deepEqual(await res.json(), { requestId: 'mut-1', id: 'i-1', overlaid: true });
  });
});

test('codaWrite with the overlay off or unset: no DO call, overlaid false', async () => {
  for (const mode of [undefined, 'off']) {
    const d = doStub(() => ok({ ok: true }));
    await withFetch(() => new Response(JSON.stringify({ requestId: 'mut-1' }), { status: 202 }), async () => {
      const out = await codaWrite({ OVERLAY_MODE: mode, OVERLAY: d.ns }, { url: 'https://c/rows/i-1', method: 'PUT', body: { row: { cells: [{ column: 'Title', value: 'x' }] } }, tableId: 'T', op: 'update', rowId: 'i-1', auth: {} });
      assert.equal(out.overlaid, false); assert.equal(out.ok, true); assert.equal(out.requestId, 'mut-1');
      assert.equal(d.calls.length, 0);
    });
  }
});

test('codaWrite: a record call that throws or answers non-2xx gives overlaid false, Coda result intact, one console line', async () => {
  for (const answer of [() => { throw new Error('do down'); }, () => new Response('{"error":"x"}', { status: 400 })]) {
    const d = doStub(answer);
    await quiet(async (errs) => {
      await withFetch(() => new Response(JSON.stringify({ requestId: 'mut-9', id: 'i-1' }), { status: 202 }), async () => {
        const out = await codaWrite({ OVERLAY_MODE: 'live', OVERLAY: d.ns }, { url: 'https://c/rows/i-1', method: 'PUT', body: { row: { cells: [{ column: 'Title', value: 'x' }] } }, tableId: 'T', op: 'update', rowId: 'i-1', auth: {} });
        assert.equal(out.overlaid, false); assert.equal(out.ok, true); assert.equal(out.status, 202); assert.equal(out.requestId, 'mut-9');
        assert.deepEqual(await (await passWrite(out, {})).json(), { requestId: 'mut-9', id: 'i-1', overlaid: false });
      });
      assert.equal(errs.length, 1); assert.match(errs[0], /overlay/); assert.match(errs[0], /mut-9/);
    });
  }
});

test('codaWrite: no requestId from Coda is not overlaid (one line); a Coda error is passed through without a DO call', async () => {
  const d = doStub(() => ok({ ok: true }));
  const env = { OVERLAY_MODE: 'live', OVERLAY: d.ns };
  const args = { url: 'https://c/rows/i-1', method: 'PUT', body: { row: { cells: [{ column: 'Title', value: 'x' }] } }, tableId: 'T', op: 'update', rowId: 'i-1', auth: {} };
  await quiet(async (errs) => {
    await withFetch(() => new Response('{}', { status: 202 }), async () => {
      assert.equal((await codaWrite(env, args)).overlaid, false);
    });
    assert.equal(errs.length, 1);
  });
  await withFetch(() => new Response('{"message":"nope"}', { status: 429 }), async () => {
    const out = await codaWrite(env, args);
    assert.equal(out.ok, false); assert.equal(out.status, 429); assert.equal(out.overlaid, false);
    const res = await passWrite(out, {});
    assert.equal(res.status, 429);
  });
  assert.equal(d.calls.length, 0);
});

test('codaWrite: an upsert (keyColumns) is never overlaid', async () => {
  const d = doStub(() => ok({ ok: true }));
  await withFetch(() => new Response(JSON.stringify({ requestId: 'mut-1', addedRowIds: [] }), { status: 202 }), async () => {
    const out = await codaWrite({ OVERLAY_MODE: 'live', OVERLAY: d.ns }, { url: 'https://c/rows', method: 'POST', body: { rows: [{ cells: [{ column: 'Title', value: 'x' }] }], keyColumns: ['Title'] }, tableId: 'T', op: 'insert', auth: {} });
    assert.equal(out.overlaid, false);
  });
  assert.equal(d.calls.length, 0);
});

test('codaWrite insert: cells recorded under addedRowIds[i]; delete records one delete entry', async () => {
  const d = doStub(() => ok({ ok: true }));
  const env = { OVERLAY_MODE: 'live', OVERLAY: d.ns };
  await withFetch(() => new Response(JSON.stringify({ requestId: 'mut-2', addedRowIds: ['i-new'] }), { status: 202 }), async () => {
    const out = await codaWrite(env, { url: 'https://c/rows', method: 'POST', body: { rows: [{ cells: [{ column: 'Title', value: 'Fresh' }, { column: 'Leads', value: ['i-p1'] }] }] }, tableId: 'T', op: 'insert', auth: {} });
    assert.equal(out.overlaid, true); assert.deepEqual(out.addedRowIds, ['i-new']);
    assert.deepEqual(await (await passWrite(out, {})).json(), { requestId: 'mut-2', addedRowIds: ['i-new'], overlaid: true });
  });
  const es = d.calls[0].body.entries;
  assert.deepEqual(es.map((e) => [e.rowId, e.key, e.op]), [['i-new', 'Title', 'insert'], ['i-new', 'Leads', 'insert']]);
  await withFetch(() => new Response(JSON.stringify({ requestId: 'mut-3' }), { status: 202 }), async (calls) => {
    const out = await codaWrite(env, { url: 'https://c/rows/i-1', method: 'DELETE', tableId: 'T', op: 'delete', rowId: 'i-1', auth: { A: 'b' } });
    assert.equal(calls[0].init.body, undefined);
    assert.equal(out.overlaid, true);
  });
  const del = d.calls[1].body.entries;
  assert.equal(del.length, 1); assert.equal(del[0].op, 'delete'); assert.equal(del[0].rowId, 'i-1'); assert.equal(typeof del[0].key, 'string');
});

const NOW = 1_800_000_000_000;
const entry = (o) => ({ tableId: 'T', rowId: 'i-1', key: SLOT_TITLE, keying: 'id', value: 'New', op: 'set', requestId: 'm', writtenAt: NOW - 1000, state: 'pending', appliedAt: null, ...o });
const SLOT_TITLE = 'c-slottitle';

test('overlayRead: off returns rows unchanged; on merges; a throwing overlay gives stale [*] and one line', async () => {
  const rows = [{ id: 'i-1', values: { [SLOT_TITLE]: 'Old' } }];
  let out = await overlayRead({}, 'T', rows, { shape: 'id', snapshotAt: NOW, now: NOW });
  assert.deepEqual(out, { rows, stale: [] });
  const d = doStub(() => ok({ entries: [entry()] }));
  out = await overlayRead({ OVERLAY_MODE: 'live', OVERLAY: d.ns }, 'T', rows, { shape: 'id', snapshotAt: NOW, now: NOW, names: {} });
  assert.equal(out.rows[0].values[SLOT_TITLE], 'New'); assert.deepEqual(out.stale, []);
  assert.deepEqual(d.calls.map((c) => [c.path, c.body.tableId]), [['/read', 'T']]);
  const bad = doStub(() => { throw new Error('down'); });
  await quiet(async (errs) => {
    out = await overlayRead({ OVERLAY_MODE: 'live', OVERLAY: bad.ns }, 'T', rows, { shape: 'id', snapshotAt: NOW, now: NOW });
    assert.equal(out.rows, rows); assert.deepEqual(out.stale, ['*']);
    assert.equal(errs.length, 1);
  });
});

const COLUMNS = [
  { id: PLANNING_COLS.title, name: 'Title', format: { type: 'text' } },
  { id: PLANNING_COLS.capacity, name: 'Capacity', format: { type: 'number' } },
  { id: PLANNING_COLS.allDay, name: 'All day', format: { type: 'checkbox' } },
  { id: PLANNING_COLS.status, name: 'Status', format: { type: 'select' } },
  { id: PLANNING_COLS.start, name: 'Start', format: { type: 'time' } },
  { id: PLANNING_COLS.date, name: 'Date', format: { type: 'date' } },
  { id: PLANNING_COLS.leads, name: 'Leads', format: { type: 'lookup', table: { id: 'grid-X316Eql8dE' } } },
  { id: PLANNING_COLS.programs, name: 'Program(s)', format: { type: 'lookup', table: { id: 'grid-g87NFbtqN8' } } },
  { id: PLANNING_COLS.venue, name: 'Venue', format: { type: 'lookup', table: { id: 'grid-foC40iAOaX' } } },
  { id: PLANNING_COLS.venueType, name: 'Venue Type', format: { type: 'lookup', table: { id: 'grid-idEVRQX7SL' } } },
  { id: PLANNING_COLS.legacyRow, name: 'Legacy', format: { type: 'lookup', table: { id: 'grid-other' } } },
  { id: 'c-formula', name: 'Formula', calculated: true, format: { type: 'text' } },
  { id: 'c-btn', name: 'Do it', format: { type: 'button' } },
];
const colsResp = () => new Response(JSON.stringify({ items: COLUMNS }), { status: 200 });

test('planningColMap: one /columns call, serves KV for an hour, then refreshes; kinds per column', async () => {
  const env = { CACHE: kvStub() };
  await withFetch(colsResp, async (calls) => {
    const real = Date.now;
    try {
      Date.now = () => NOW;
      const m = await planningColMap(env, 'https://c', 'D', 'grid-plan', { A: 'b' });
      assert.equal(calls.length, 1);
      assert.equal(calls[0].u, 'https://c/docs/D/tables/grid-plan/columns?limit=200');
      assert.equal(m.idToName[PLANNING_COLS.title], 'Title'); assert.equal(m.nameToId['Capacity'], PLANNING_COLS.capacity);
      assert.deepEqual(
        [PLANNING_COLS.title, PLANNING_COLS.capacity, PLANNING_COLS.allDay, PLANNING_COLS.status, PLANNING_COLS.start, PLANNING_COLS.date,
          PLANNING_COLS.leads, PLANNING_COLS.programs, PLANNING_COLS.venue, PLANNING_COLS.venueType, PLANNING_COLS.legacyRow, 'c-formula', 'c-btn'].map((id) => m.colKinds[id]),
        ['text', 'text', 'text', 'text', 'time', 'date', 'relation:people', 'relation:programs', 'relation:venues', 'relation:venueTypes', 'calculated', 'calculated', 'calculated']);
      assert.ok(env.CACHE.m.has(PLANNING_COLS_KV_KEY));
      Date.now = () => NOW + 3599_000;
      await planningColMap(env, 'https://c', 'D', 'grid-plan', {});
      assert.equal(calls.length, 1, 'served from KV within the hour');
      Date.now = () => NOW + 3601_000;
      await planningColMap(env, 'https://c', 'D', 'grid-plan', {});
      assert.equal(calls.length, 2, 'refreshed after an hour');
    } finally { Date.now = real; }
  });
});

test('overlayNames: id -> name from the existing KV caches (People slim, /ref programs, venues, venue types)', async () => {
  const env = { CACHE: kvStub({
    [PEOPLE_KV_KEY]: { at: 1, data: [{ id: 'i-p1', values: { [PEOPLE_COLS.fullName]: 'Leah Cohen' } }] },
    [refKvKey('programs')]: { at: 1, data: [{ id: 'i-g1', name: 'Shabbat', values: {} }] },
    [VENUES_KV_KEY]: { at: 1, data: [{ id: 'i-v1', name: 'Community Hall', values: {} }] },
    [refKvKey('venue-types')]: { at: 1, data: [{ id: 'i-t1', name: 'Partner', values: {} }] },
  }) };
  assert.deepEqual(await overlayNames(env), {
    people: { 'i-p1': 'Leah Cohen' }, programs: { 'i-g1': 'Shabbat' }, venues: { 'i-v1': 'Community Hall' }, venueTypes: { 'i-t1': 'Partner' },
  });
});

test('overlayRead planning: number and checkbox writes merge without marking the row stale (colKinds from /columns)', async () => {
  const d = doStub(() => ok({ entries: [
    entry({ tableId: 'grid-plan', key: 'Capacity', keying: 'name', value: 40 }),
    entry({ tableId: 'grid-plan', key: 'All day', keying: 'name', value: true, writtenAt: NOW - 900 }),
    entry({ tableId: 'grid-plan', key: 'Leads', keying: 'name', value: ['i-p1'], writtenAt: NOW - 800 }),
  ] }));
  const env = { OVERLAY_MODE: 'live', OVERLAY: d.ns, CACHE: kvStub({ [PEOPLE_KV_KEY]: { at: 1, data: [{ id: 'i-p1', values: { [PEOPLE_COLS.fullName]: 'Leah Cohen' } }] },
    [refKvKey('programs')]: { at: 1, data: [] }, [VENUES_KV_KEY]: { at: 1, data: [] }, [refKvKey('venue-types')]: { at: 1, data: [] } }) };   // all name caches warm: no refill
  await withFetch(colsResp, async (calls) => {
    const rows = [{ id: 'i-1', values: { [PLANNING_COLS.capacity]: 10, [PLANNING_COLS.allDay]: false } }];
    const out = await overlayRead(env, 'grid-plan', rows, { shape: 'id', snapshotAt: NOW, now: NOW, planning: { base: 'https://c', docId: 'D', auth: {} } });
    assert.deepEqual(out.stale, []);
    assert.equal(out.rows[0].values[PLANNING_COLS.capacity], 40);
    assert.equal(out.rows[0].values[PLANNING_COLS.allDay], true);
    assert.deepEqual(out.rows[0].values[PLANNING_COLS.leads], ['Leah Cohen']);
    assert.equal(calls.length, 1, 'one /columns call');
  });
});

test('overlayStatus: the DO state; null when off or on error', async () => {
  const d = doStub((p, b) => ok({ state: b.requestId === 'a' ? 'applied' : null }));
  const env = { OVERLAY_MODE: 'live', OVERLAY: d.ns };
  assert.equal(await overlayStatus(env, 'a'), 'applied');
  assert.equal(await overlayStatus(env, 'b'), null);
  assert.equal(await overlayStatus({ OVERLAY: d.ns }, 'a'), null);
  assert.equal(d.calls.length, 2);
  await quiet(async (errs) => {
    assert.equal(await overlayStatus({ OVERLAY_MODE: 'live', OVERLAY: doStub(() => { throw new Error('x'); }).ns }, 'a'), null);
    assert.equal(errs.length, 1);
  });
});

// ── a missing names cache refills (M3) ──
test('overlayRead planning: a missing venues cache is refilled from Coda, and the Venue cell converts instead of going stale', async () => {
  const d = doStub(() => ok({ entries: [entry({ tableId: 'grid-plan', key: 'Venue', keying: 'name', value: ['i-v1'] })] }));
  const seeded = {
    [PEOPLE_KV_KEY]: { at: 1, data: [{ id: 'i-p1', values: { [PEOPLE_COLS.fullName]: 'Leah Cohen' } }] },
    [refKvKey('programs')]: { at: 1, data: [] }, [refKvKey('venue-types')]: { at: 1, data: [] },
  };
  const env = { OVERLAY_MODE: 'live', OVERLAY: d.ns, CACHE: kvStub(seeded) };   // no VENUES_KV_KEY: just busted by a venue write
  const venues = (u) => (/\/columns/.test(u) ? colsResp() : /grid-foC40iAOaX\/rows/.test(u)
    ? ok({ items: [{ id: 'i-v1', name: 'Community Hall', values: {} }] }) : new Response('{}', { status: 404 }));
  await withFetch(venues, async (calls) => {
    const rows = [{ id: 'i-1', values: { Venue: ['Old Place'] } }];
    const out = await overlayRead(env, 'grid-plan', rows, { shape: 'name', snapshotAt: NOW, now: NOW, planning: { base: 'https://c', docId: 'D', auth: {} } });
    assert.deepEqual(out.stale, []);
    assert.deepEqual(out.rows[0].values.Venue, ['Community Hall']);
    const vr = calls.filter((c) => /grid-foC40iAOaX\/rows/.test(c.u));
    assert.equal(vr.length, 1, 'one Coda read for the missing cache');
    assert.match(vr[0].u, /useColumnNames=false/, 'read by column id, as /ref/venues does');
  });
  const hit = await env.CACHE.get(VENUES_KV_KEY, 'json');
  assert.equal(hit.data[0].name, 'Community Hall');
  assert.equal('hasAddress' in hit.data[0], true, 'the /ref/venues projection (venueRefItem), never raw addresses');
});

test('overlayRead planning: a failed refill keeps today\'s stale cell and console line', async () => {
  const d = doStub(() => ok({ entries: [entry({ tableId: 'grid-plan', key: 'Venue', keying: 'name', value: ['i-v1'] })] }));
  const env = { OVERLAY_MODE: 'live', OVERLAY: d.ns, CACHE: kvStub({ [PEOPLE_KV_KEY]: { at: 1, data: [] }, [refKvKey('programs')]: { at: 1, data: [] }, [refKvKey('venue-types')]: { at: 1, data: [] } }) };
  await quiet(async (errs) => {
    await withFetch((u) => (/\/columns/.test(u) ? colsResp() : new Response('{}', { status: 500 })), async () => {
      const out = await overlayRead(env, 'grid-plan', [{ id: 'i-1', values: { Venue: ['Old Place'] } }], { shape: 'name', snapshotAt: NOW, now: NOW, planning: { base: 'https://c', docId: 'D', auth: {} } });
      assert.deepEqual(out.stale, ['i-1']);
      assert.deepEqual(out.rows[0].values.Venue, ['Old Place']);
    });
    assert.ok(errs.some((x) => /venues/.test(x) && /500/.test(x)), errs.join('\n'));
    assert.ok(errs.some((x) => /no KV names for venues/.test(x)), errs.join('\n'));
  });
  assert.equal(await env.CACHE.get(VENUES_KV_KEY), null, 'a failed read is never cached');
});
