// web/editor-head.js is a plain browser script that attaches `EditorHead` to
// globalThis — importing it for side effects makes it testable under node.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../../web/editor-head.js';

const { subtitle, programTag } = globalThis.EditorHead;

test('subtitle: first non-blank line, whitespace collapsed', () => {
  assert.equal(subtitle('\n  \n  Need a   host\tfor 20.\nAsk Sophie.'), 'Need a host for 20.');
  assert.equal(subtitle('One line'), 'One line');
});

test('subtitle: empty for blank or missing notes', () => {
  assert.equal(subtitle(''), '');
  assert.equal(subtitle('   \n\n '), '');
  assert.equal(subtitle(null), '');
  assert.equal(subtitle(undefined), '');
});

test('subtitle: long lines are cut with an ellipsis within max', () => {
  const s = subtitle('a'.repeat(50) + ' ' + 'b'.repeat(100), 60);
  assert.equal(s.length <= 60, true);
  assert.equal(s.endsWith('…'), true);
  assert.equal(subtitle('x'.repeat(60), 60), 'x'.repeat(60));   // exactly max: untouched
  assert.equal(subtitle('word '.repeat(10) + 'end', 11), 'word word…');   // no space before the ellipsis
});

test('programTag: first known program, its color, and how many more', () => {
  const map = { wan: { name: 'Wandering Scholars', color: 'var(--p-wan)' }, kab: { name: 'Kabbalat Shabbat', color: 'hsl(10, 50%, 55%)' } };
  assert.deepEqual(programTag(['wan', 'kab'], map), { id: 'wan', name: 'Wandering Scholars', color: 'var(--p-wan)', more: 1 });
  assert.deepEqual(programTag(['kab'], map), { id: 'kab', name: 'Kabbalat Shabbat', color: 'hsl(10, 50%, 55%)', more: 0 });
  assert.deepEqual(programTag('wan', map), { id: 'wan', name: 'Wandering Scholars', color: 'var(--p-wan)', more: 0 });
});

test('programTag: skips unknown ids and Other; null when nothing to show', () => {
  const map = { wan: { name: 'Wandering Scholars', color: '#2F7DC4' }, oth: { name: 'Other', color: '#888' } };
  assert.deepEqual(programTag(['zzz', 'wan'], map), { id: 'wan', name: 'Wandering Scholars', color: '#2F7DC4', more: 1 });
  assert.equal(programTag(['oth'], map), null);
  assert.equal(programTag([], map), null);
  assert.equal(programTag(null, map), null);
  assert.equal(programTag(['wan'], null), null);
});
