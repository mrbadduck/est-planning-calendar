import { test } from 'node:test';
import assert from 'node:assert/strict';
import { unfoldLines, icalDateToYMD, unescapeText, parseVEvents } from '../src/ical.js';

test('unfoldLines rejoins RFC5545 continuation lines, dropping the fold whitespace', () => {
  // RFC 5545: a fold is CRLF + one leading whitespace; unfolding removes BOTH,
  // since fold points fall on arbitrary octet boundaries (the space is not content).
  const raw = 'SUMMARY:Hello\r\n World\r\nDTSTART:20260101';
  assert.equal(unfoldLines(raw), 'SUMMARY:HelloWorld\nDTSTART:20260101');
});

test('icalDateToYMD handles all-day VALUE=DATE', () => {
  assert.deepEqual(icalDateToYMD('DTSTART;VALUE=DATE:20260907'), { date: '2026-09-07', allDay: true });
});

test('icalDateToYMD handles UTC timed DTSTART', () => {
  assert.deepEqual(icalDateToYMD('DTSTART:20260911T230000Z'), { date: '2026-09-11', allDay: true });
});

test('icalDateToYMD handles TZID timed DTSTART', () => {
  assert.deepEqual(icalDateToYMD('DTSTART;TZID=America/Chicago:20260911T180000'), { date: '2026-09-11', allDay: true });
});

test('unescapeText unescapes commas, semicolons, newlines, backslashes', () => {
  assert.equal(unescapeText('Erev\\, Rosh\\; Hashanah\\nfun\\\\'), 'Erev, Rosh; Hashanah fun\\');
});

test('parseVEvents extracts summary + date from folded, escaped VEVENTs', () => {
  const ics = [
    'BEGIN:VCALENDAR',
    'BEGIN:VEVENT',
    'DTSTART;VALUE=DATE:20260907',
    'SUMMARY:Labor',
    '  Day',
    'END:VEVENT',
    'BEGIN:VEVENT',
    'DTSTART:20260921T120000Z',
    'SUMMARY:Yom Kippur\\, 5787',
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');
  assert.deepEqual(parseVEvents(ics), [
    { title: 'Labor Day', date: '2026-09-07', allDay: true },
    { title: 'Yom Kippur, 5787', date: '2026-09-21', allDay: true },
  ]);
});

test('parseVEvents skips events missing SUMMARY or DTSTART', () => {
  const ics = 'BEGIN:VEVENT\r\nDTSTART;VALUE=DATE:20260101\r\nEND:VEVENT';
  assert.deepEqual(parseVEvents(ics), []);
});
