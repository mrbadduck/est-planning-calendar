import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PLANNING_COLS, LEGACY_COLS, LEGACY_EVENTS_TABLE } from '../src/coda-columns.js';

const ID = /^c-[\w-]+$/;

for (const [name, cols] of [['PLANNING_COLS', PLANNING_COLS], ['LEGACY_COLS', LEGACY_COLS]]) {
  test(`${name}: every value is a Coda column id`, () => {
    assert.ok(cols && Object.keys(cols).length > 0);
    for (const [k, v] of Object.entries(cols)) assert.match(v, ID, k);
  });
  test(`${name}: no two keys share an id`, () => {
    const ids = Object.values(cols);
    assert.equal(new Set(ids).size, ids.length);
  });
}

test('Source and Last from Eventbrite columns are mapped by id', () => {
  assert.equal(PLANNING_COLS.source, 'c-XNXXPfY74v');
  assert.equal(PLANNING_COLS.lastFromEb, 'c-b02zbLiHgk');
});

test('existing planning columns and the legacy table are mapped', () => {
  for (const k of ['capacity', 'publishStatus', 'ticketClassId', 'lastPublishedAt', 'lastPublishError',
    'eventDescription', 'programs', 'leads', 'volunteers', 'legacyRow', 'createdBy']) {
    assert.ok(PLANNING_COLS[k], k);
  }
  assert.equal(LEGACY_EVENTS_TABLE, 'grid-9TAt5vMMKH');
});
