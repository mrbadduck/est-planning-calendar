import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mutationResult } from '../src/publish.js';

test('mutationResult: 200 completed true', () => {
  assert.deepEqual(mutationResult(200, { completed: true }), { httpStatus: 200, json: { completed: true } });
});
test('mutationResult: 200 completed false / missing', () => {
  assert.deepEqual(mutationResult(200, { completed: false }), { httpStatus: 200, json: { completed: false } });
  assert.deepEqual(mutationResult(200, {}), { httpStatus: 200, json: { completed: false } });
  assert.deepEqual(mutationResult(200, null), { httpStatus: 200, json: { completed: false } });
});
test('mutationResult: 400 is unknown request id', () => {
  assert.deepEqual(mutationResult(400, {}), { httpStatus: 400, json: { error: 'unknown request id' } });
});
test('mutationResult: other is 502', () => {
  assert.deepEqual(mutationResult(500, {}), { httpStatus: 502, json: { error: 'coda 500' } });
});
