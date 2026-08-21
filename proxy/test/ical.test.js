import { test } from 'node:test';
import assert from 'node:assert/strict';
import { unfoldLines, icalDateToYMD, unescapeText, parseVEvents, parseRrule, expandRrule } from '../src/ical.js';

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

test('parseRrule parses FREQ/INTERVAL/COUNT/UNTIL/BYDAY', () => {
  assert.deepEqual(parseRrule('RRULE:FREQ=WEEKLY;INTERVAL=2;COUNT=5;BYDAY=MO,WE'),
    { interval: 2, byday: ['MO', 'WE'], freq: 'WEEKLY', count: 5 });
  assert.deepEqual(parseRrule('RRULE:FREQ=DAILY;UNTIL=20260110T000000Z'),
    { interval: 1, byday: [], freq: 'DAILY', until: '2026-01-10' });
});

test('expandRrule WEEKLY BYDAY with COUNT (starts Thu 2026-01-01)', () => {
  const out = expandRrule('2026-01-01', parseRrule('RRULE:FREQ=WEEKLY;BYDAY=MO,FR;COUNT=4'), null);
  assert.deepEqual(out, ['2026-01-02', '2026-01-05', '2026-01-09', '2026-01-12']);
});

test('expandRrule DAILY with INTERVAL and UNTIL', () => {
  const out = expandRrule('2026-01-01', parseRrule('RRULE:FREQ=DAILY;INTERVAL=3;UNTIL=20260110'), null);
  assert.deepEqual(out, ['2026-01-01', '2026-01-04', '2026-01-07', '2026-01-10']);
});

test('expandRrule MONTHLY skips months missing the start day, honors cap', () => {
  const out = expandRrule('2026-01-31', parseRrule('RRULE:FREQ=MONTHLY'), '2026-04-30');
  assert.deepEqual(out, ['2026-01-31', '2026-03-31']);   // Feb/Apr have no 31st; May past cap
});

test('expandRrule YEARLY skips Feb 29 in non-leap years', () => {
  const out = expandRrule('2028-02-29', parseRrule('RRULE:FREQ=YEARLY'), '2033-01-01');
  assert.deepEqual(out, ['2028-02-29', '2032-02-29']);   // 2029-2031 have no Feb 29
});

test('expandRrule caps unbounded rules at the window end', () => {
  const out = expandRrule('2026-01-01', parseRrule('RRULE:FREQ=DAILY'), '2026-01-05');
  assert.deepEqual(out, ['2026-01-01', '2026-01-02', '2026-01-03', '2026-01-04', '2026-01-05']);
});

test('parseVEvents expands RRULE and honors EXDATE', () => {
  const ics = [
    'BEGIN:VEVENT',
    'DTSTART;VALUE=DATE:20260101',
    'SUMMARY:Weekly Thing',
    'RRULE:FREQ=WEEKLY;BYDAY=TH;COUNT=3',
    'EXDATE;VALUE=DATE:20260108',
    'END:VEVENT',
  ].join('\r\n');
  assert.deepEqual(parseVEvents(ics), [
    { title: 'Weekly Thing', date: '2026-01-01', allDay: true },
    { title: 'Weekly Thing', date: '2026-01-15', allDay: true },
  ]);
});
