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

// The program tag's text must reach WCAG AA (4.5:1, 11px/600) on its tint in both
// themes, for the fixed palette and every hue genColor can make (hsl(H,50%,55%)).
import { readFileSync } from 'node:fs';
const css = readFileSync(new URL('../../web/styles.css', import.meta.url), 'utf8');
const { tagColors, contrast, TAG_MIX, THEMES, parseColor } = globalThis.EditorHead;

test('styles.css mixes the tag with the percentages and tokens the test checks', () => {
  const lightVar = css.match(/:root\{[^}]*--ptag-text:(\d+)%/);
  const darkVar = css.match(/prefers-color-scheme:dark\)\{\s*:root\{[^}]*--ptag-text:(\d+)%/);
  assert.equal(Number(lightVar && lightVar[1]), TAG_MIX.light.text);
  assert.equal(Number(darkVar && darkVar[1]), TAG_MIX.dark.text);
  assert.match(css, new RegExp(`\\.ptag\\{[^}]*var\\(--c,var\\(--p-oth\\)\\) ${TAG_MIX.bg}%,var\\(--surface\\)`));
  assert.match(css, /\.ptag\{[^}]*color:color-mix\(in srgb,var\(--c,var\(--p-oth\)\) var\(--ptag-text\),var\(--ink\)\)/);
  assert.match(css, new RegExp(`--surface:${THEMES.dark.surface}`, 'i'));
  assert.match(css, new RegExp(`--ink:${THEMES.dark.ink}`, 'i'));
  assert.match(css, new RegExp(`--ink:${THEMES.light.ink}`, 'i'));
});

test('program tag text is >= 4.5:1 on its tint, light and dark, palette + every generated hue', () => {
  const palette = [...css.matchAll(/--p-[a-z]+:(#[0-9a-f]{6})/gi)].map(m => m[1]);
  assert.ok(palette.length >= 8);
  const colors = palette.concat(['#888']);
  for (let h = 0; h < 360; h += 15) colors.push(`hsl(${h}, 50%, 55%)`);
  for (const theme of ['light', 'dark']) {
    for (const c of colors) {
      const t = tagColors(c, theme);
      const r = contrast(t.text, t.bg);
      assert.ok(r >= 4.5, `${theme} ${c}: ${r.toFixed(2)}:1`);
    }
  }
});

test('contrast and parseColor basics', () => {
  assert.equal(Math.round(contrast(parseColor('#000'), parseColor('#fff'))), 21);
  assert.equal(contrast(parseColor('#777777'), parseColor('#777777')), 1);
  assert.deepEqual(parseColor('hsl(0, 100%, 50%)'), [255, 0, 0]);
  assert.equal(parseColor('var(--p-wan)'), null);
});
