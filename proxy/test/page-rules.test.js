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

const FULL = { date: '2026-11-20', createdBy: 'Ana', approvedBy: 'Ben', approvedAt: '2026-11-02',
  lastEbPushAt: '2026-11-03T15:00:00Z', lastPublishedAt: '2026-11-04T15:00:00Z' };
const fmtDate = s => 'D(' + s.slice(0, 10) + ')';
// ISO timestamps show by their LOCAL date; the expected value is computed from the same Date.
const localDay = iso => { const d = new Date(iso), p = n => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()); };
const EB = 'D(' + localDay(FULL.lastEbPushAt) + ')', PUB = 'D(' + localDay(FULL.lastPublishedAt) + ')';

test('stepNotes gives one note per step', () => {
  assert.deepEqual(stepNotes(FULL, { fmtDate, registrants: 12, capacity: 40 }),
    ['by Ana', '', 'by Ben · D(2026-11-02)', EB, PUB + ' · 12 of 40 registered', 'D(2026-11-20)']);
});

test('stepNotes is all blank when there is nothing to say', () => {
  assert.deepEqual(stepNotes({}, { fmtDate, registrants: null, capacity: null }), ['', '', '', '', '', '']);
});

test('stepNotes drops or shortens the registered part', () => {
  assert.equal(stepNotes(FULL, { fmtDate, registrants: null, capacity: 40 })[4], PUB);
  assert.equal(stepNotes(FULL, { fmtDate, registrants: 5, capacity: null })[4], PUB + ' · 5 registered');
});

test('stepNotes formats ISO timestamps by local date, plain dates as they are', () => {
  // Near midnight UTC the local date differs from the UTC slice in most time zones.
  for (const iso of ['2026-11-04T03:30:00Z', '2026-11-04T23:30:00Z', '2026-11-04T12:00:00.000+05:00']) {
    const notes = stepNotes({ lastEbPushAt: iso, lastPublishedAt: iso }, { fmtDate });
    assert.equal(notes[3], 'D(' + localDay(iso) + ')', iso);
    assert.equal(notes[4], 'D(' + localDay(iso) + ')', iso);
  }
  assert.equal(stepNotes({ approvedAt: '2026-11-04' }, { fmtDate })[2], 'D(2026-11-04)');
  assert.equal(stepNotes({ lastEbPushAt: 'not a date' }, { fmtDate })[3], 'D(not a date)');
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
