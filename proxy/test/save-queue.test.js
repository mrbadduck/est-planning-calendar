// web/save-queue.js is a plain browser script that attaches `SaveQueue` to
// globalThis — importing it for side effects makes it testable under node too
// (same pattern as help-lib.test.js / roster-lib.test.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../../web/save-queue.js';

const { create, changedCells } = globalThis.SaveQueue;

// A writer the test controls: every write waits until the test resolves or rejects it.
function fakeWriter() {
  const calls = [];
  const write = (id, cells) => new Promise((resolve, reject) => calls.push({ id, cells, resolve, reject }));
  return { calls, write };
}
const tick = () => new Promise(r => setImmediate(r));
const cols = cells => Object.fromEntries(cells.map(c => [c.column, c.value]));

test('changedCells returns only the cells whose value differs', () => {
  const before = [{ column: 'Title', value: 'A' }, { column: 'Leads', value: ['p1', 'p2'] }, { column: 'Status', value: 'Draft' }];
  const after = [{ column: 'Title', value: 'B' }, { column: 'Leads', value: ['p1', 'p2'] }, { column: 'Status', value: 'Draft' }];
  assert.deepEqual(changedCells(before, after), [{ column: 'Title', value: 'B' }]);
});

test('changedCells compares relation lists by content', () => {
  const before = [{ column: 'Leads', value: ['p1'] }];
  assert.deepEqual(changedCells(before, [{ column: 'Leads', value: ['p1'] }]), []);
  assert.deepEqual(changedCells(before, [{ column: 'Leads', value: ['p1', 'p2'] }]), [{ column: 'Leads', value: ['p1', 'p2'] }]);
});

test('changedCells treats a column missing from before as changed', () => {
  assert.deepEqual(changedCells([], [{ column: 'Title', value: '' }]), [{ column: 'Title', value: '' }]);
});

test('a staged edit is written right away', () => {
  const w = fakeWriter(); const q = create({ write: w.write });
  q.stage('e1', [{ column: 'Title', value: 'A' }]);
  assert.equal(w.calls.length, 1);
  assert.equal(w.calls[0].id, 'e1');
  assert.deepEqual(w.calls[0].cells, [{ column: 'Title', value: 'A' }]);
  assert.equal(q.status('e1'), 'saving');
});

test('edits staged during a write go out together once it finishes', async () => {
  const w = fakeWriter(); const q = create({ write: w.write });
  q.stage('e1', [{ column: 'Title', value: 'A' }]);
  q.stage('e1', [{ column: 'Title', value: 'B' }]);
  q.stage('e1', [{ column: 'Venue', value: ['v1'] }]);
  q.stage('e1', [{ column: 'Title', value: 'C' }]);
  assert.equal(w.calls.length, 1, 'one write per event at a time');
  w.calls[0].resolve(); await tick();
  assert.equal(w.calls.length, 2);
  assert.deepEqual(cols(w.calls[1].cells), { Title: 'C', Venue: ['v1'] });
});

test('each event has its own queue', async () => {
  const w = fakeWriter(); const q = create({ write: w.write });
  q.stage('A', [{ column: 'Title', value: 'A1' }]);
  q.stage('A', [{ column: 'Title', value: 'A2' }]);   // waits behind A1
  q.stage('B', [{ column: 'Title', value: 'B1' }]);   // must not replace A2
  assert.deepEqual(w.calls.map(c => [c.id, c.cells[0].value]), [['A', 'A1'], ['B', 'B1']]);
  w.calls[0].resolve(); await tick();
  assert.deepEqual(w.calls.map(c => [c.id, c.cells[0].value]), [['A', 'A1'], ['B', 'B1'], ['A', 'A2']]);
});

test('a failed write goes out again with the next edit, under newer values', async () => {
  const w = fakeWriter(); const q = create({ write: w.write });
  q.stage('e1', [{ column: 'Title', value: 'A' }, { column: 'Venue', value: ['v1'] }]);
  q.stage('e1', [{ column: 'Title', value: 'B' }]);    // staged while the first write is in flight
  w.calls[0].reject(new Error('offline')); await tick();
  assert.equal(w.calls.length, 2, 'retried right away because the user kept editing');
  assert.deepEqual(cols(w.calls[1].cells), { Title: 'B', Venue: ['v1'] });
});

test('a failed write with nothing newer reports an error and waits', async () => {
  const w = fakeWriter(); const states = [];
  const q = create({ write: w.write, onState: (id, s, err) => states.push([id, s, err && err.message]) });
  q.stage('e1', [{ column: 'Title', value: 'A' }]);
  w.calls[0].reject(new Error('offline')); await tick();
  assert.equal(w.calls.length, 1, 'no automatic retry loop');
  assert.equal(q.status('e1'), 'error');
  assert.deepEqual(states.at(-1), ['e1', 'error', 'offline']);
  q.stage('e1', [{ column: 'Capacity', value: 20 }]);   // the next edit carries the failed one
  assert.deepEqual(cols(w.calls[1].cells), { Title: 'A', Capacity: 20 });
});

test('a writer that throws synchronously counts as a failed write', async () => {
  const q = create({ write: () => { throw new Error('boom'); } });
  q.stage('e1', [{ column: 'Title', value: 'A' }]);
  await tick();
  assert.equal(q.status('e1'), 'error');
});

test('onState reports saving, then saved when nothing is left', async () => {
  const w = fakeWriter(); const states = [];
  const q = create({ write: w.write, onState: (id, s) => states.push(s) });
  q.stage('e1', [{ column: 'Title', value: 'A' }]);
  assert.equal(states[0], 'saving');
  q.stage('e1', [{ column: 'Title', value: 'B' }]);
  w.calls[0].resolve(); await tick();
  assert.ok(!states.includes('saved'), 'not saved while an edit is still queued');
  w.calls[1].resolve(); await tick();
  assert.equal(states.at(-1), 'saved');
  assert.equal(q.status('e1'), 'idle');
});

test('settle waits for the write in flight and anything queued behind it', async () => {
  const w = fakeWriter(); const q = create({ write: w.write });
  q.stage('e1', [{ column: 'Title', value: 'A' }]);
  q.stage('e1', [{ column: 'Title', value: 'B' }]);
  let settled = false; const p = q.settle('e1').then(() => { settled = true; });
  w.calls[0].resolve(); await tick();
  assert.equal(settled, false);
  w.calls[1].resolve(); await p;
  assert.equal(settled, true);
});

test('settle resolves at once when nothing is pending', async () => {
  const q = create({ write: fakeWriter().write });
  await q.settle('e1');
});

test('settle rejects when the write in flight fails', async () => {
  const w = fakeWriter(); const q = create({ write: w.write });
  q.stage('e1', [{ column: 'Title', value: 'A' }]);
  const p = q.settle('e1');
  w.calls[0].reject(new Error('offline'));
  await assert.rejects(p, /offline/);
});

test('settle sends a failed edit again and rejects if it fails again', async () => {
  const w = fakeWriter(); const q = create({ write: w.write });
  q.stage('e1', [{ column: 'Title', value: 'A' }]);
  w.calls[0].reject(new Error('offline')); await tick();
  const p = q.settle('e1');
  assert.equal(w.calls.length, 2, 'settle sends the failed edit again');
  assert.deepEqual(cols(w.calls[1].cells), { Title: 'A' });
  w.calls[1].reject(new Error('still offline'));
  await assert.rejects(p, /still offline/);
  assert.equal(q.status('e1'), 'error');
});

test('discard drops queued edits and ignores the write in flight', async () => {
  const w = fakeWriter(); const states = [];
  const q = create({ write: w.write, onState: (id, s) => states.push(s) });
  q.stage('e1', [{ column: 'Title', value: 'A' }]);
  q.stage('e1', [{ column: 'Title', value: 'B' }]);
  let done = false; const p = q.discard('e1').then(() => { done = true; });
  await tick(); assert.equal(done, false, 'waits for the write in flight');
  w.calls[0].reject(new Error('offline')); await p;
  assert.equal(w.calls.length, 1, 'the queued edit is never written');
  assert.equal(q.status('e1'), 'idle');
  assert.ok(!states.includes('error'));
});

test('discard ignores a write in flight that succeeds', async () => {
  const w = fakeWriter(); const states = [];
  const q = create({ write: w.write, onState: (id, s) => states.push(s) });
  q.stage('e1', [{ column: 'Title', value: 'A' }]);
  const p = q.discard('e1');
  w.calls[0].resolve(); await p;
  assert.deepEqual(states, ['saving'], 'no saved for a discarded write');
  assert.equal(q.status('e1'), 'idle');
});

test('discard rejects settle waiters whose edits it dropped', async () => {
  const w = fakeWriter(); const q = create({ write: w.write });
  q.stage('e1', [{ column: 'Title', value: 'A' }]);
  const waiting = q.settle('e1');
  q.discard('e1');
  await assert.rejects(waiting, /discarded/);
  w.calls[0].resolve();
});

test('settle after a discard resolves once the discarded write finishes', async () => {
  const w = fakeWriter(); const q = create({ write: w.write });
  q.stage('e1', [{ column: 'Title', value: 'A' }]);
  q.discard('e1');
  let settled = false; const p = q.settle('e1').then(() => { settled = true; });
  await tick(); assert.equal(settled, false);
  w.calls[0].resolve(); await p;
  assert.equal(settled, true);
});

test('edits staged after a discard are written once the discarded write finishes', async () => {
  const w = fakeWriter(); const q = create({ write: w.write });
  q.stage('e1', [{ column: 'Title', value: 'A' }]);
  q.discard('e1');
  q.stage('e1', [{ column: 'Title', value: 'B' }]);
  assert.equal(w.calls.length, 1, 'waits for the discarded write');
  w.calls[0].reject(new Error('offline')); await tick();
  assert.equal(w.calls.length, 2);
  assert.deepEqual(cols(w.calls[1].cells), { Title: 'B' }, 'the discarded cells are not restored');
});

test('an onState callback that throws does not jam the queue', async () => {
  const w = fakeWriter(); const errors = [];
  const q = create({ write: w.write, onState: () => { throw new Error('ui broke'); }, onError: e => errors.push(e.message) });
  q.stage('e1', [{ column: 'Title', value: 'A' }]);
  assert.equal(w.calls.length, 1, 'the write still goes out');
  w.calls[0].resolve(); await tick();
  assert.equal(q.status('e1'), 'idle');
  assert.ok(errors.includes('ui broke'), 'the callback error is reported, not swallowed');
});

test('settle rejects with the write error even when onState discards on it', async () => {
  const w = fakeWriter();
  const q = create({ write: w.write, onState: (id, s) => { if (s === 'error') q.discard(id); } });
  q.stage('e1', [{ column: 'Title', value: 'A' }]);
  const p = q.settle('e1');
  w.calls[0].reject(new Error('offline'));
  await assert.rejects(p, /offline/);
});

test('discard clears an error so nothing is retried', async () => {
  const w = fakeWriter(); const q = create({ write: w.write });
  q.stage('e1', [{ column: 'Title', value: 'A' }]);
  w.calls[0].reject(new Error('offline')); await tick();
  await q.discard('e1');
  assert.equal(q.status('e1'), 'idle');
  await q.settle('e1');
  assert.equal(w.calls.length, 1);
});
