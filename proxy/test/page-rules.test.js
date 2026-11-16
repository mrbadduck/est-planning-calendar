// web/page-rules.js is a plain browser script that attaches `PageRules` to globalThis.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../../web/page-rules.js';

const { sectionFromParam, stepNotes, needsApproval } = globalThis.PageRules;

test('sectionFromParam maps aliases and passes other ids through', () => {
  assert.equal(sectionFromParam('notes'), 'planning');
  assert.equal(sectionFromParam('attendance'), 'attendees');
  assert.equal(sectionFromParam('publish'), 'details');
  assert.equal(sectionFromParam('listing'), 'details');
  assert.equal(sectionFromParam(''), 'details');
  assert.equal(sectionFromParam(null), 'details');
  assert.equal(sectionFromParam('volunteers'), 'volunteers');
});

const FULL = { createdBy: 'Ana', approvedBy: 'Ben', approvedAt: '2026-11-02',
  lastEbPushAt: '2026-11-03T15:00:00Z', lastPublishedAt: '2026-11-04T15:00:00Z' };
const fmtDate = s => 'D(' + s.slice(0, 10) + ')';

test('stepNotes gives one note per step', () => {
  assert.deepEqual(stepNotes(FULL, { fmtDate, registrants: 12, capacity: 40 }),
    ['by Ana', '', 'by Ben · D(2026-11-02)', 'D(2026-11-03)', 'D(2026-11-04) · 12 of 40 registered']);
});

test('stepNotes is all blank when there is nothing to say', () => {
  assert.deepEqual(stepNotes({}, { fmtDate, registrants: null, capacity: null }), ['', '', '', '', '']);
});

test('stepNotes drops or shortens the registered part', () => {
  assert.equal(stepNotes(FULL, { fmtDate, registrants: null, capacity: 40 })[4], 'D(2026-11-04)');
  assert.equal(stepNotes(FULL, { fmtDate, registrants: 5, capacity: null })[4], 'D(2026-11-04) · 5 registered');
});

test('stepNotes shows either half of the Approved note alone', () => {
  assert.equal(stepNotes({ approvedBy: 'Ben' }, { fmtDate })[2], 'by Ben');
  assert.equal(stepNotes({ approvedAt: '2026-11-02' }, { fmtDate })[2], 'D(2026-11-02)');
});

test('needsApproval is true only for a proposed planning event', () => {
  assert.equal(needsApproval({ source: 'planning', status: 'proposed' }), true);
  assert.equal(needsApproval({ source: 'planning', status: 'draft' }), false);
  assert.equal(needsApproval({ source: 'ref', status: 'proposed' }), false);
});
