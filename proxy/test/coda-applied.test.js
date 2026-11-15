// web/coda-applied.js is a plain script attaching `CodaApplied` to globalThis.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../../web/coda-applied.js';

const { waitApplied } = globalThis.CodaApplied;

// Fake clock: sleep(ms) advances now(); no real timers.
function clock() {
  let t = 0;
  return { now: () => t, sleep: async ms => { t += ms; }, at: () => t };
}
function harness(fetchStatus) {
  const c = clock();
  const calls = { fetch: 0, slow: 0 };
  return {
    c, calls,
    run: id => waitApplied(id, {
      fetchStatus: async rid => { calls.fetch++; return fetchStatus(calls.fetch, rid); },
      sleep: c.sleep, now: c.now, onSlow: () => { calls.slow++; },
    }),
  };
}

test('completes on the 3rd poll', async () => {
  const h = harness(n => ({ status: 200, completed: n >= 3 }));
  await h.run('req-1');
  assert.equal(h.calls.fetch, 3);
  assert.equal(h.calls.slow, 0);
});

test('404 resolves after one call', async () => {
  const h = harness(() => ({ status: 404 }));
  await h.run('req-1');
  assert.equal(h.calls.fetch, 1);
});

test('400 rejects with status 400', async () => {
  const h = harness(() => ({ status: 400 }));
  await assert.rejects(h.run('req-1'), e => e.message === 'save not confirmed' && e.status === 400);
  assert.equal(h.calls.fetch, 1);
});

test('never completes: rejects at >=120000ms, onSlow called once', async () => {
  const h = harness(() => ({ status: 200, completed: false }));
  await assert.rejects(h.run('req-1'), e => e.message === 'save not confirmed' && e.status !== 400);
  assert.ok(h.c.at() >= 120000);
  assert.equal(h.calls.slow, 1);
});

test('poll delays: 1000 x5, then 1500 until 20s, then 2000', async () => {
  const delays = [];
  let t = 0;
  await assert.rejects(waitApplied('r', {
    fetchStatus: async () => ({ status: 200, completed: false }),
    sleep: async ms => { delays.push(ms); t += ms; },
    now: () => t, onSlow() {},
  }));
  assert.deepEqual(delays.slice(0, 5), [1000, 1000, 1000, 1000, 1000]);
  assert.equal(delays[5], 1500);
  assert.equal(delays.at(-1), 2000);
});

test('fetchStatus throws twice then completes', async () => {
  const h = harness(n => { if (n <= 2) throw new Error('network'); return { status: 200, completed: true }; });
  await h.run('req-1');
  assert.equal(h.calls.fetch, 3);
});

test('fetchStatus always throws: rejects at the deadline', async () => {
  const h = harness(() => { throw new Error('network'); });
  await assert.rejects(h.run('req-1'), e => e.message === 'save not confirmed');
  assert.ok(h.c.at() >= 120000);
});

test('falsy requestId resolves with no calls', async () => {
  const h = harness(() => ({ status: 200, completed: true }));
  await h.run('');
  await h.run(null);
  assert.equal(h.calls.fetch, 0);
});
