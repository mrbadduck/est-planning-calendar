#!/usr/bin/env node
// Microbenchmark (not part of the suite): the CPU a gather read spends on its snapshot.
// Times JSON.parse of the cached raw rows + the overlay merge (mergeRows x3) + gatherSnapshot,
// on a synthetic 250-event / 100-slot / 300-claim snapshot, with 0 and 10 live overlay entries.
//   node scripts/bench-gather.mjs [iterations=300]
// The free plan allows ~10 ms of CPU per invocation; this is the part gather adds.
import { mergeRows } from '../proxy/src/overlay.js';
import { gatherSnapshot } from '../proxy/src/gather.js';
import { PLANNING_COLS as P, SLOT_COLS as S, CLAIM_COLS as C } from '../proxy/src/coda-columns.js';

const N = Number(process.argv[2]) || 300;
const fence = (s) => '```' + s + '```';
const day = (i) => new Date(Date.UTC(2026, 10, 20) + i * 86400_000).toISOString().slice(0, 10);
const events = Array.from({ length: 250 }, (_, i) => ({ id: `i-e${i}`, values: {
  [P.title]: fence(`Event number ${i} with a longer title`), [P.status]: fence(i % 3 ? 'Approved' : 'Proposed'),
  [P.published]: i % 2 === 0, [P.date]: `${day(i)}T00:00:00.000-06:00`, [P.eventbriteId]: fence(String(100000 + i)),
  'c-filler1': fence('Some description text that pads the row like the real table does. '.repeat(4)),
  'c-filler2': [{ rowId: 'i-p1', name: 'Person One' }, { rowId: 'i-p2', name: 'Person Two' }],
} }));
const slots = Array.from({ length: 100 }, (_, i) => ({ id: `i-s${i}`, values: {
  [S.event]: [{ rowId: `i-e${i * 2}`, name: '' }], [S.label]: fence(`Slot ${i}`), [S.kind]: fence('Potluck'), [S.neededQty]: 4, [S.sortOrder]: i,
} }));
const claims = Array.from({ length: 300 }, (_, i) => ({ id: `i-c${i}`, values: {
  [C.slot]: [{ rowId: `i-s${i % 100}`, name: '' }], [C.member]: [{ rowId: `i-p${i}`, name: `Member ${i}` }], [C.qty]: 1,
} }));
const cached = JSON.stringify({ at: Date.now(), data: { events, slots, claims } });
const now = Date.now();
const names = { people: Object.fromEntries(Array.from({ length: 400 }, (_, i) => [`i-p${i}`, `Member ${i}`])), programs: {}, venues: {}, venueTypes: {} };
const entriesFor = (k) => {
  if (!k) return { plan: [], slot: [], claim: [] };
  const e = (tableId, rowId, key, value, op = 'set') => ({ tableId, rowId, key, keying: 'id', value, op, requestId: `r-${rowId}`, writtenAt: now - 1000, state: 'pending' });
  return {
    plan: Array.from({ length: 4 }, (_, i) => e('grid-plan', `i-e${i * 7}`, P.status, 'Approved')),
    slot: Array.from({ length: 3 }, (_, i) => e('grid-slots', `i-snew${i}`, S.event, ['i-e0'], 'insert')),
    claim: Array.from({ length: 3 }, (_, i) => e('grid-claims', `i-cnew${i}`, C.member, ['i-p1'], 'insert')),
  };
};
function run(k) {
  const en = entriesFor(k), times = [];
  for (let i = 0; i < N + 20; i++) {
    const t0 = process.hrtime.bigint();
    const raw = JSON.parse(cached);
    const at = raw.at, o = { shape: 'rich', snapshotAt: at, now, names };
    const ev = mergeRows(raw.data.events, en.plan, { ...o, tableId: 'grid-plan' }).rows;
    const sl = mergeRows(raw.data.slots, en.slot, { ...o, tableId: 'grid-slots' }).rows;
    const cl = mergeRows(raw.data.claims, en.claim, { ...o, tableId: 'grid-claims' }).rows;
    gatherSnapshot(ev, sl, cl, '2026-11-23');
    if (i >= 20) times.push(Number(process.hrtime.bigint() - t0) / 1e6);   // 20 warm-up runs
  }
  times.sort((a, b) => a - b);
  const q = (p) => times[Math.min(times.length - 1, Math.floor(p * times.length))].toFixed(2);
  console.log(`${String(k).padStart(2)} overlay entries: p50 ${q(0.5)} ms, p95 ${q(0.95)} ms  (n=${N}, ${(cached.length / 1024).toFixed(0)} KB cached)`);
}
run(0); run(10);
