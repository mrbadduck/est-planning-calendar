// The split-is-a-pure-move checker (scripts/check-move.mjs). Its git plumbing
// and the --load smoke are exercised by running the CLI (plan Task 1).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareMove, scriptList } from '../../scripts/check-move.mjs';

const HDR = '/* x.js — h\n   Owns: f */\n';

test('compareMove passes a pure split', () => {
  const orig = 'a();\nfunction f(){\n  return 1;\n}\nb();\n';
  const files = [
    { name: 'web/x.js', src: HDR + 'function f(){\n  return 1;\n}\n' },
    { name: 'web/app.js', src: 'a();\n\nb();\n' },
  ];
  assert.deepEqual(compareMove(orig, files), []);
});

test('compareMove reports a lost line', () => {
  const orig = 'a();\nfunction f(){\n  return 1;\n}\nb();\n';
  const files = [
    { name: 'web/x.js', src: HDR + 'function f(){\n  return 2;\n}\n' },
    { name: 'web/app.js', src: 'a();\n\nb();\n' },
  ];
  const problems = compareMove(orig, files).join('\n');
  assert.ok(problems.includes('missing: "  return 1;"'), problems);
  assert.ok(problems.includes('extra: "  return 2;"'), problems);
});

test('compareMove reports reordered top-level statements', () => {
  const problems = compareMove('a();\nb();\n', [{ name: 'web/app.js', src: 'b();\na();\n' }]);
  assert.ok(problems.some((p) => p.includes('top-level order')), problems.join('\n'));
});

test('compareMove requires a header with Owns:', () => {
  const problems = compareMove('f();\n', [{ name: 'web/x.js', src: 'f();\n' }]);
  assert.ok(problems.some((p) => p.includes('header')), problems.join('\n'));
});

test('scriptList skips modules', () => {
  const html = '<script type="module" src="auth-firebase.js"></script>\n<script src="a.js"></script>\n<script src="b.js"></script>';
  assert.deepEqual(scriptList(html), ['a.js', 'b.js']);
});
