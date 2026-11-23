// web/page-rules.js is a plain browser script that attaches `PageRules` to globalThis.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../../web/page-rules.js';

const { sectionFromParam, stepNotes, updatedFromEbLine, needsApproval, revertTransition, lateFailMsg } = globalThis.PageRules;

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

test('an imported event says so where the creator would be', () => {
  assert.equal(stepNotes({ origin: 'Eventbrite' }, { fmtDate })[0], 'Imported from Eventbrite');
  assert.equal(stepNotes({ origin: 'Plan', createdBy: 'Ana' }, { fmtDate })[0], 'by Ana');
});

test('updatedFromEbLine names the fields that came in from Eventbrite and when', () => {
  const at = '2026-11-19T10:00:00Z';
  const ev = { lastFromEb: { at, fields: ['start', 'capacity'] }, lastEbPushAt: '2026-11-18T00:00:00Z' };
  assert.equal(updatedFromEbLine(ev, fmtDate), 'Updated from Eventbrite: Start time, Capacity · D(' + localDay(at) + ')');
  assert.equal(updatedFromEbLine(Object.assign({}, ev, { lastEbPushAt: '2026-11-20T00:00:00Z' }), fmtDate), '');
  assert.equal(updatedFromEbLine(Object.assign({}, ev, { lastEbPushAt: '' }), fmtDate).startsWith('Updated from Eventbrite: '), true);
  assert.equal(updatedFromEbLine({ lastFromEb: null }, fmtDate), '');
  assert.equal(updatedFromEbLine({ lastFromEb: { at, fields: ['publishState', 'venue', 'title', 'date', 'end', 'publicDescription'] } }, fmtDate)
    .split(' · ')[0], 'Updated from Eventbrite: Status on Eventbrite, Venue, Title, Date, End time, Description');
});

test('revertTransition puts prev back only while the event still has the status this transition set', () => {
  const ev = { status: 'approved', approvedBy: 'Dana', approvedAt: '2026-11-23', title: 'Shabbat' };
  const prev = { status: 'proposed', approvedBy: '', approvedAt: '' };
  assert.equal(revertTransition(ev, prev, 'approved'), true);
  assert.deepEqual(ev, { status: 'proposed', approvedBy: '', approvedAt: '', title: 'Shabbat' });
  // a later transition (Reopen) moved it on: never undo that one
  const later = { status: 'draft', approvedBy: 'Dana' };
  assert.equal(revertTransition(later, prev, 'approved'), false);
  assert.deepEqual(later, { status: 'draft', approvedBy: 'Dana' });
  assert.equal(revertTransition(null, prev, 'approved'), false);
});

test('lateFailMsg: no step gives the generic message, never throws', () => {
  assert.equal(lateFailMsg(undefined, 'Shabbat'), 'The change didn’t confirm. Check again in a minute.');
});

test('lateFailMsg: the step holds the title or leads it; Worker writes say check it again', () => {
  assert.equal(lateFailMsg('Approving', 'Shabbat'), 'Approving “Shabbat” didn’t confirm — open it and try again');
  assert.equal(lateFailMsg('Adding {title} to Eventbrite', 'Shabbat', { workerWrite: true }),
    'Adding “Shabbat” to Eventbrite didn’t confirm — check it again in a minute');
  assert.equal(lateFailMsg('Updating the draft of', 'Shabbat', { workerWrite: true }),
    'Updating the draft of “Shabbat” didn’t confirm — check it again in a minute');
  assert.equal(lateFailMsg('Cancelling', '', { workerWrite: true }),
    'Cancelling “an event” didn’t confirm — check it again in a minute');
});
