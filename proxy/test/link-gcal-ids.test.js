import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planLinks } from '../../scripts/link-gcal-ids.mjs';

const TODAY = '2026-11-22';
const p = (rowId, ebId, date, extra = {}) => ({ rowId, title: `T ${rowId}`, date, ebId, gcalEventId: '', ...extra });

test('links by the legacy row first', () => {
  const r = planLinks({ planning: [p('i-1', '111', '2026-12-01')], legacy: [{ ebId: '111', gcalEventId: 'g1' }], ebSync: [], todayIso: TODAY });
  assert.deepEqual(r.links, [{ rowId: 'i-1', title: 'T i-1', date: '2026-12-01', gcalEventId: 'g1', from: 'EST Events SRC' }]);
  assert.deepEqual(r.unmatched, []);
});

test('falls back to the Events EVENTBRITE sync table', () => {
  const r = planLinks({ planning: [p('i-1', '111', '2026-12-01')], legacy: [{ ebId: '111', gcalEventId: '' }], ebSync: [{ ebId: '111', gcalEventId: 'g2' }], todayIso: TODAY });
  assert.equal(r.links[0].gcalEventId, 'g2');
  assert.equal(r.links[0].from, 'Events EVENTBRITE');
});

test('both sources agreeing is a link; disagreeing is a conflict, not a link', () => {
  const agree = planLinks({ planning: [p('i-1', '111', '2026-12-01')], legacy: [{ ebId: '111', gcalEventId: 'g1' }], ebSync: [{ ebId: '111', gcalEventId: 'g1' }], todayIso: TODAY });
  assert.equal(agree.links.length, 1);
  const clash = planLinks({ planning: [p('i-1', '111', '2026-12-01')], legacy: [{ ebId: '111', gcalEventId: 'g1' }], ebSync: [{ ebId: '111', gcalEventId: 'g2' }], todayIso: TODAY });
  assert.deepEqual(clash.links, []);
  assert.deepEqual(clash.conflicts, [{ rowId: 'i-1', ids: ['g1', 'g2'] }]);
});

test('two legacy rows with different ids are a conflict', () => {
  const r = planLinks({ planning: [p('i-1', '111', '2026-12-01')], legacy: [{ ebId: '111', gcalEventId: 'g1' }, { ebId: '111', gcalEventId: 'g3' }], ebSync: [], todayIso: TODAY });
  assert.equal(r.conflicts.length, 1);
  assert.equal(r.links.length, 0);
});

test('a row with no known id is unmatched', () => {
  const r = planLinks({ planning: [p('i-1', '111', '2026-12-01')], legacy: [], ebSync: [], todayIso: TODAY });
  assert.deepEqual(r.unmatched, [{ rowId: 'i-1', title: 'T i-1', date: '2026-12-01' }]);
});

test('skips rows with an id already, no Eventbrite id, or a date before yesterday', () => {
  const planning = [
    p('i-1', '111', '2026-12-01', { gcalEventId: 'already' }),
    p('i-2', '', '2026-12-01'),
    p('i-3', '333', '2026-11-20'),
    p('i-4', '444', ''),
    p('i-5', '555', '2026-11-21'),
  ];
  const legacy = ['111', '333', '444', '555'].map((ebId) => ({ ebId, gcalEventId: 'g' + ebId }));
  const r = planLinks({ planning, legacy, ebSync: [], todayIso: TODAY });
  assert.deepEqual(r.links.map((l) => l.rowId), ['i-5']);
  assert.deepEqual(r.unmatched, []);
});
