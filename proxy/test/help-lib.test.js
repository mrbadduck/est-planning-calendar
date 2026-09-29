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
