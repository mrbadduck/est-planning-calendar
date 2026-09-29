// web/help/help-lib.js is a plain browser script that attaches `HelpLib` to
// globalThis — importing it for side effects makes it testable under node too
// (same pattern as roster-lib.test.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../../web/help/help-lib.js';

const H = globalThis.HelpLib;

const GUIDE = [
  '<!-- writing guide: [[Not A Label]] {#nope} -->',
  '# Getting started',
  '',
  '## Welcome {#welcome}',
  '',
  'Hello [[+ New event]].',
  '',
  '## Get around {#getting-around}',
  'Use [[Overview]].',
  '# Help',
  '## Common problems {#troubleshooting}',
  'See [the welcome](#welcome).',
].join('\n');

test('parseGuide: groups, ids, titles, 1-based heading lines; comments stripped', () => {
  const { guides, errors } = H.parseGuide(GUIDE);
  assert.deepEqual(errors, []);
  assert.deepEqual(guides.map((g) => [g.group, g.id, g.title, g.line]), [
    ['Getting started', 'welcome', 'Welcome', 4],
    ['Getting started', 'getting-around', 'Get around', 8],
    ['Help', 'troubleshooting', 'Common problems', 11],
  ]);
  assert.equal(guides[0].body, 'Hello [[+ New event]].');
  assert.equal(guides[2].body, 'See [the welcome](#welcome).');
});

test('parseGuide: reports a missing, malformed, reserved or duplicate id and skips that guide', () => {
  const md = ['# G', '## No id', '## Bad {#Bad_Id}', '## Reserved {#whats-new}', '## A {#a}', '## A again {#a}'].join('\n');
  const { guides, errors } = H.parseGuide(md);
  assert.deepEqual(guides.map((g) => g.id), ['a']);
  assert.deepEqual(errors.map((e) => e.line), [2, 3, 4, 6]);
  assert.match(errors[0].message, /no \{#id\}/);
  assert.match(errors[1].message, /kebab-case/);
  assert.match(errors[2].message, /reserved/);
  assert.match(errors[3].message, /duplicate/);
});

test('renderGuide: paragraphs, steps, bullets, subheads and tips', () => {
  const html = H.renderGuide(['First line', 'continues.', '', '1. One', '2. Two', '', '- A', '- B', '', '### Sub', '> **Tip:** hi'].join('\n'));
  assert.equal(html, [
    '<p>First line continues.</p>',
    '<ol><li>One</li><li>Two</li></ol>',
    '<ul><li>A</li><li>B</li></ul>',
    '<h4>Sub</h4>',
    '<div class="help-tip"><strong>Tip:</strong> hi</div>',
  ].join('\n'));
});

test('renderGuide: chips, bold, italic and links', () => {
  const html = H.renderGuide('Click [[Propose]] **now** or *later*; see [lifecycle](#lifecycle), [site](https://x.org) and [mail](mailto:a@b.org).');
  assert.equal(html, '<p>Click <span class="uichip">Propose</span> <strong>now</strong> or <em>later</em>; see <a href="#" data-help-link="lifecycle">lifecycle</a>, <a href="https://x.org" target="_blank" rel="noopener">site</a> and <a href="mailto:a@b.org" target="_blank" rel="noopener">mail</a>.</p>');
});

test('renderGuide: escapes HTML and refuses other link schemes', () => {
  assert.equal(H.renderGuide('<b>x</b> & [[<i>]] [bad](javascript:void0)'), '<p>&lt;b&gt;x&lt;/b&gt; &amp; <span class="uichip">&lt;i&gt;</span> bad</p>');
});

test('renderGuide: {{embed}} on its own line calls opts.embed; none given → nothing', () => {
  const embed = (n) => `<div data-embed="${n}"></div>`;
  assert.equal(H.renderGuide('Key:\n\n{{legend}}\n\nEnd', { embed }), '<p>Key:</p>\n<div data-embed="legend"></div>\n<p>End</p>');
  assert.equal(H.renderGuide('{{legend}}'), '');
});

test('uiLabels / guideLinks / embeds: report line numbers and ignore comments', () => {
  const md = ['<!-- [[Ghost]] [x](#ghost) {{ghost}} -->', 'Click [[Propose]] then [[ Approve ]].', 'See [x](#lifecycle).', '{{legend}}', 'Inline {{legend}} here'].join('\n');
  assert.deepEqual(H.uiLabels(md), [{ label: 'Propose', line: 2 }, { label: 'Approve', line: 2 }]);
  assert.deepEqual(H.guideLinks(md), [{ id: 'lifecycle', line: 3 }]);
  assert.deepEqual(H.embeds(md), [{ name: 'legend', line: 4, ownLine: true }, { name: 'legend', line: 5, ownLine: false }]);
});

test('parseWhatsNew: dated entries newest-first, with wrapped bullets', () => {
  const md = ["# What's new", '## 2026-09-29', '- **Help.** Click ?', '  for guides.', '## 2026-09-16', '- **Attendees.**'].join('\n');
  const { entries, errors } = H.parseWhatsNew(md);
  assert.deepEqual(errors, []);
  assert.deepEqual(entries.map((e) => [e.date, e.items]), [['2026-09-29', ['**Help.** Click ? for guides.']], ['2026-09-16', ['**Attendees.**']]]);
});

test('parseWhatsNew: flags a bad date, an empty entry and out-of-order dates', () => {
  const { errors } = H.parseWhatsNew(['## Sept 1', '- x', '## 2026-09-01', '## 2026-09-10', '- y'].join('\n'));
  assert.deepEqual(errors.map((e) => e.line), [1, 3, 4]);
  assert.match(errors[0].message, /must be a date/);
  assert.match(errors[1].message, /no bullet points/);
  assert.match(errors[2].message, /out of order/);
});

test('renderWhatsNew: formats dates and renders inline markup', () => {
  assert.equal(H.renderWhatsNew([{ date: '2026-09-19', items: ['**Moved.** See [[Details]].'] }]), '<h4>September 19, 2026</h4><ul><li><strong>Moved.</strong> See <span class="uichip">Details</span>.</li></ul>');
  assert.equal(H.renderWhatsNew([]), '<p class="help-empty">Nothing new yet.</p>');
  assert.equal(H.renderWhatsNew(null), '<p class="help-empty">Nothing new yet.</p>');
});

test('searchGuides: every word must appear in the title or body, case-insensitive', () => {
  const guides = [{ id: 'a', title: 'Add an event', body: 'Click [[+ New event]].' }, { id: 'b', title: 'Publish', body: 'Eventbrite listing' }];
  assert.deepEqual(H.searchGuides(guides, 'NEW event').map((g) => g.id), ['a']);
  assert.deepEqual(H.searchGuides(guides, 'eventbrite').map((g) => g.id), ['b']);
  assert.deepEqual(H.searchGuides(guides, '  '), []);
});
