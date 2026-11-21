import { test } from 'node:test';
import assert from 'node:assert/strict';
import { publishLogCells } from '../src/worker-io.js';

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
