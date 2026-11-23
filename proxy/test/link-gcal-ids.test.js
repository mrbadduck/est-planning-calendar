import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planLinks, resolveSyncRows, calendarIds, lookupIds, renderPlan } from '../../scripts/link-gcal-ids.mjs';

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

const COLS = { ebId: 'c-eb', lookup: 'c-look', gcId: 'c-gid', calendar: 'c-cal' };
const ref = (rowId, name) => ({ '@type': 'StructuredValue', additionalType: 'row', rowId, name });
const gc = (id, name, eventId) => ({ id, name, values: { [COLS.gcId]: '```' + eventId + '```', [COLS.calendar]: '```East Side Tribe Events```' } });

test('resolveSyncRows resolves by row id, even when two calendar rows share a name', () => {
  const gcRows = [gc('i-a', 'Shabbat', 'evA'), gc('i-b', 'Shabbat', 'evB')];
  const ebRows = [{ id: 'i-1', values: { [COLS.ebId]: '111', [COLS.lookup]: ref('i-b', 'Shabbat') } }];
  assert.deepEqual(resolveSyncRows(ebRows, gcRows, COLS), [{ ebId: '111', gcalEventId: 'evB' }]);
});

test('a lookup referencing several calendar rows becomes a conflict', () => {
  const gcRows = [gc('i-a', 'X', 'evA'), gc('i-b', 'X', 'evB')];
  const ebRows = [{ id: 'i-1', values: { [COLS.ebId]: '111', [COLS.lookup]: [ref('i-a', 'X'), ref('i-b', 'X')] } }];
  const ebSync = resolveSyncRows(ebRows, gcRows, COLS);
  assert.equal(ebSync.length, 2);
  const r = planLinks({ planning: [p('i-1', '111', '2026-12-01')], legacy: [], ebSync, todayIso: TODAY });
  assert.deepEqual(r.links, []);
  assert.deepEqual(r.conflicts, [{ rowId: 'i-1', ids: ['evA', 'evB'] }]);
});

test('an empty lookup or an unknown reference gives no id', () => {
  const ebRows = [{ id: 'i-1', values: { [COLS.ebId]: '111', [COLS.lookup]: '' } }, { id: 'i-2', values: { [COLS.ebId]: '222', [COLS.lookup]: ref('i-zz', 'N') } }];
  assert.deepEqual(resolveSyncRows(ebRows, [], COLS), [{ ebId: '222', gcalEventId: '' }]);
});

// ── final fix wave: the planning row's own gCal Event lookup, the calendar filter, frozen legacy events ──
const COLS2 = { ...COLS, calendar: 'c-cal' };
const gc2 = (id, eventId, calendar = 'East Side Tribe Events') => ({ id, name: 'N', values: { [COLS2.gcId]: '```' + eventId + '```', [COLS2.calendar]: typeof calendar === 'string' ? '```' + calendar + '```' : calendar } });

test('calendarIds keeps only East Side Tribe Events rows', () => {
  const m = calendarIds([gc2('i-a', 'evA'), gc2('i-b', 'evB', 'Eric personal'), gc2('i-c', 'evC', { '@type': 'StructuredValue', name: 'East Side Tribe Events' })], COLS2);
  assert.deepEqual([...m], [['i-a', 'evA'], ['i-c', 'evC']]);
});

test('resolveSyncRows ignores calendar rows on other calendars', () => {
  const gcRows = [gc2('i-a', 'evA', 'Other calendar')];
  const ebRows = [{ id: 'i-1', values: { [COLS.ebId]: '111', [COLS.lookup]: ref('i-a', 'X') } }];
  assert.deepEqual(resolveSyncRows(ebRows, gcRows, COLS2), [{ ebId: '111', gcalEventId: '' }]);
});

test('lookupIds resolves a planning lookup cell by row id, EST calendar only', () => {
  const ids = calendarIds([gc2('i-a', 'evA'), gc2('i-b', 'evB', 'Other')], COLS2);
  assert.deepEqual(lookupIds([ref('i-a', 'Same'), ref('i-b', 'Same'), ref('i-zz', 'Same')], ids), ['evA']);
  assert.deepEqual(lookupIds('', ids), []);
});

test('a row without an Eventbrite id links through its own gCal Event lookup', () => {
  const r = planLinks({ planning: [p('i-1', '', '2026-12-01', { ownIds: ['evX'] })], legacy: [], ebSync: [], todayIso: TODAY });
  assert.deepEqual(r.links, [{ rowId: 'i-1', title: 'T i-1', date: '2026-12-01', gcalEventId: 'evX', from: 'gCal Event lookup' }]);
});

test('the own lookup disagreeing with another source is a conflict', () => {
  const r = planLinks({ planning: [p('i-1', '111', '2026-12-01', { ownIds: ['evX'] })], legacy: [{ ebId: '111', gcalEventId: 'g1' }], ebSync: [], todayIso: TODAY });
  assert.deepEqual(r.links, []);
  assert.deepEqual(r.conflicts, [{ rowId: 'i-1', ids: ['g1', 'evX'] }]);
  const agree = planLinks({ planning: [p('i-1', '111', '2026-12-01', { ownIds: ['g1'] })], legacy: [{ ebId: '111', gcalEventId: 'g1' }], ebSync: [], todayIso: TODAY });
  assert.equal(agree.links.length, 1);
});

test('a row with neither an Eventbrite id nor a lookup is not listed', () => {
  const r = planLinks({ planning: [p('i-1', '', '2026-12-01')], legacy: [], ebSync: [], todayIso: TODAY });
  assert.deepEqual([r.links, r.unmatched, r.conflicts], [[], [], []]);
});

test('frozen: upcoming EST Events SRC rows with a gCal id and no planning row', () => {
  const L = (rowId, date, o = {}) => ({ rowId, name: `L ${rowId}`, date, ebId: '', gcalEventId: `g-${rowId}`, ...o });
  const legacy = [
    L('l-potluck', '2026-12-03'),                      // no planning row: frozen
    L('l-past', '2026-11-01'),                         // past: not listed
    L('l-noid', '2026-12-03', { gcalEventId: '' }),    // no calendar event: not listed
    L('l-eb', '2026-12-04', { ebId: '111' }),          // a planning row has its Eventbrite id
    L('l-ref', '2026-12-05'),                          // a planning row links this legacy row
    L('l-same', '2026-12-06'),                         // a planning row already holds its gCal id
  ];
  const planning = [
    p('i-1', '111', '2026-12-04'),
    p('i-2', '', '2026-12-05', { legacyRefs: ['l-ref'] }),
    p('i-3', '', '2026-12-06', { gcalEventId: 'g-l-same' }),
  ];
  const r = planLinks({ planning, legacy, ebSync: [], todayIso: TODAY });
  assert.deepEqual(r.frozen, [{ rowId: 'l-potluck', name: 'L l-potluck', date: '2026-12-03', gcalEventId: 'g-l-potluck' }]);
  assert.match(renderPlan(r), /Frozen until Phase C[\s\S]*l-potluck/);
});
