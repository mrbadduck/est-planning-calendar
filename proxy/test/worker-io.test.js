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
  const g = publishLogCells({ action: 'create', ok: false, target: 'Google Calendar', via: 'sweep' }, 'now');
  assert.equal(cell(g, 'Target'), 'Google Calendar');
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
