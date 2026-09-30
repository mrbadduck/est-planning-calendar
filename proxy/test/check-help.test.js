// Pure helpers of the help guard (scripts/check-help.mjs). Its git plumbing,
// CLI and hook mode are exercised by hand (plan Tasks 5 and 10).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isScreensFile, isHelpFile, normText, stripCodeComments, jsStrings, screenTexts,
  labelProblems, refProblems, mergeIntoMainTarget, prCreateBase, commandDirOf, hasHelpNone, branchVerdict,
} from '../../scripts/check-help.mjs';

test('isScreensFile / isHelpFile', () => {
  assert.ok(isScreensFile('web/app.js'));
  assert.ok(isScreensFile('web/index.html'));
  assert.ok(isScreensFile('web/roster-lib.js'));
  assert.ok(!isScreensFile('web/styles.css'));
  assert.ok(!isScreensFile('web/help/help-lib.js'));
  assert.ok(!isScreensFile('web/embed-test/index.html'));
  assert.ok(!isScreensFile('gather/app.js'));
  assert.ok(isHelpFile('web/help/guide.md'));
  assert.ok(!isHelpFile('web/app.js'));
  assert.ok(!isHelpFile('web/help/help-lib.js'));
});

test('normText: decodes &amp;, drops icons/ellipses/dashes, collapses space', () => {
  assert.equal(normText('Refresh roles &amp; people'), 'Refresh roles & people');
  assert.equal(normText('Edit in Google Docs ↗'), 'Edit in Google Docs');
  assert.equal(normText('↻ Refresh'), 'Refresh');
  assert.equal(normText('Saving…'), 'Saving');
  assert.equal(normText('Save failed — retry'), 'Save failed retry');
  assert.equal(normText('+ New event'), '+ New event');
  assert.equal(normText('?'), '?');
  assert.equal(normText('↻'), '');
  assert.equal(normText('Couldn’t reach Eventbrite'), "Couldn't reach Eventbrite");
});

test('stripCodeComments: removes JS/HTML comments, keeps URLs and the line count', () => {
  const src = "a = 'https://x.org'; // Propose\n/* Approve\n */ b = 1;\n<!-- Delete -->";
  const out = stripCodeComments(src);
  assert.ok(out.includes("'https://x.org'"));
  assert.ok(!out.includes('Propose') && !out.includes('Approve') && !out.includes('Delete'));
  assert.equal(out.split('\n').length, src.split('\n').length);
});

test('screenTexts: text between tags and whole quoted strings count; comments do not', () => {
  const src = [
    'b.push(`<button data-act="propose">Propose</button>`);',
    "const S = [{ label:'Potluck & Volunteers' }];",
    "el.textContent = s==='saving' ? 'Saving…' : 'Saved';",
    '// Approve lives in the footer',
    '<a class="reflink" href="#">Open in Eventbrite ↗</a>',
  ].join('\n');
  const t = screenTexts([src]);
  for (const s of ['Propose', 'Potluck & Volunteers', 'Saving', 'Saved', 'Open in Eventbrite']) assert.ok(t.has(s), s);
  assert.ok(!t.has('Approve'));
});

test('labelProblems: labels missing from screen, and icon-only labels', () => {
  const guide = ['## A {#a}', 'Click [[Propose]], then [[Approve]].', 'Or [[↻]].'].join('\n');
  const probs = labelProblems(guide, [{ file: 'web/app.js', src: '<b>Propose</b> // Approve' }]);
  assert.equal(probs.length, 2);
  assert.match(probs[0], /guide\.md:2 \[\[Approve\]\] no longer appears on screen/);
  assert.match(probs[1], /guide\.md:3 \[\[↻\]\] has no words to check/);
});

test("refProblems: dead links, unknown embeds, bad app references, What's new errors", () => {
  const guide = ['# G', '## A {#a}', 'See [b](#b) and [news](#whats-new).', '{{legend}}', '{{chart}}'].join('\n');
  const news = ['## 2026-09-01', '- ok', '## 2026-09-10', '- out of order'].join('\n');
  const sources = [
    { file: 'web/app.js', src: "openHelp('a'); openHelp('zzz');\nconst S=[{ help:'nope' }];\n// openHelp('ignored')" },
    { file: 'web/index.html', src: '<button data-help="">?</button><a data-help="gone">x</a>' },
  ];
  assert.deepEqual(refProblems(guide, news, sources), [
    'web/help/guide.md:3 link to #b — no guide has that id',
    'web/help/guide.md:5 unknown embed {{chart}} (known: legend)',
    'web/app.js:1 help link "zzz" — no guide has that id',
    'web/app.js:2 help link "nope" — no guide has that id',
    'web/index.html:1 help link "gone" — no guide has that id',
    'web/help/whats-new.md:3 2026-09-10 is out of order — newest first',
  ]);
  assert.deepEqual(refProblems(null, news, sources), ['web/help/guide.md is missing']);
});

test('mergeIntoMainTarget: only merges into main; skips options and their values', () => {
  assert.equal(mergeIntoMainTarget('git merge feat/x', 'main'), 'feat/x');
  assert.equal(mergeIntoMainTarget('git merge feat/x', 'feat/y'), null);
  assert.equal(mergeIntoMainTarget('git checkout main && git merge --no-ff feat/x -m "Merge: x"', 'feat/x'), 'feat/x');
  assert.equal(mergeIntoMainTarget('git switch main; git merge -m "Merge: x" --no-ff feat/x', 'feat/x'), 'feat/x');
  assert.equal(mergeIntoMainTarget("git merge --no-ff -q feat/x -m \"$(cat <<'EOF'\nMerge: x\n\nBody\nEOF\n)\"", 'main'), 'feat/x');
  assert.equal(mergeIntoMainTarget('git merge --abort', 'main'), null);
  assert.equal(mergeIntoMainTarget('git log --grep "git merge feat/x"', 'main'), null);
  assert.equal(mergeIntoMainTarget('git merge main', 'feat/x'), null);
});

test('prCreateBase: null unless the command runs gh pr create; base defaults to main', () => {
  assert.equal(prCreateBase('gh pr list'), null);
  assert.equal(prCreateBase('gh pr create --fill'), 'main');
  assert.equal(prCreateBase('git push -u origin HEAD && gh pr create --base develop --title x'), 'develop');
  assert.equal(prCreateBase('gh pr create -B release'), 'release');
  assert.equal(prCreateBase('gh pr create --base=staging'), 'staging');
});

test('hasHelpNone: needs "Help: none" plus a reason', () => {
  assert.ok(hasHelpNone('fix: x\n\nHelp: none — internal refactor'));
  assert.ok(hasHelpNone('help: none - typo'));
  assert.ok(hasHelpNone('Help: none: css only'));
  assert.ok(!hasHelpNone('Help: none'));
  assert.ok(!hasHelpNone('Help: none —   '));
  assert.ok(!hasHelpNone('Help: none —\nCo-Authored-By: x'));
  assert.ok(!hasHelpNone('Helpful: none - x'));
});

test('branchVerdict: screens changed without help → a problem, unless help changed or Help: none', () => {
  assert.match(branchVerdict(['web/app.js', 'web/styles.css'], 'feat: x'), /changes the app's screens \(web\/app\.js\) but not web\/help\//);
  assert.equal(branchVerdict(['web/app.js', 'web/help/guide.md'], 'feat: x'), null);
  assert.equal(branchVerdict(['web/app.js'], 'refactor\n\nHelp: none — no visible change'), null);
  assert.equal(branchVerdict(['proxy/src/worker.js', 'web/styles.css'], 'feat: y'), null);
  assert.match(branchVerdict(['web/app.js', 'web/help/help-lib.js'], 'feat: x'), /but not web\/help\//);
});

test('screenTexts: a ${} template earlier in the file does not hide later strings', () => {
  assert.ok(screenTexts(["a = `<b>${x}</b>`;\nt = 'Public listing';\nb = `<i>${y}</i>`;"]).has('Public listing'));
});

test('jsStrings: string bodies and template chunks, skipping comments and regex literals', () => {
  assert.deepEqual(jsStrings("a = 'x'; // 'no'\nb = `p${q + '!'}r`; c = /'[']/g; d = \"y\";"), ['x', 'p', '!', 'r', 'y']);
});

test('mergeIntoMainTarget: merge-base/merge-tree are not merges; -C, env and option prefixes are', () => {
  assert.equal(mergeIntoMainTarget('git merge-base main HEAD', 'main'), null);
  assert.equal(mergeIntoMainTarget('git merge-tree --write-tree main feat/x', 'main'), null);
  assert.equal(mergeIntoMainTarget('git -C /repo merge feat/x', 'main'), 'feat/x');
  assert.equal(mergeIntoMainTarget('GIT_EDITOR=true git merge feat/x', 'main'), 'feat/x');
  assert.equal(mergeIntoMainTarget('git --no-pager -c core.editor=true merge feat/x', 'main'), 'feat/x');
  assert.equal(mergeIntoMainTarget('git checkout -q main && git merge feat/x', 'feat/x'), 'feat/x');
  assert.equal(mergeIntoMainTarget('git checkout main-backup && git merge feat/x', 'feat/x'), null);
});

test('prCreateBase: never an option-like base; attached -B; another repo (-R/--repo) → null', () => {
  assert.equal(prCreateBase('gh pr create --base --output=/tmp/x'), 'main');
  assert.equal(prCreateBase('gh pr create -Bdevelop'), 'develop');
  assert.equal(prCreateBase('gh pr create -R other/repo --fill'), null);
  assert.equal(prCreateBase('gh pr create --repo=other/repo'), null);
  assert.equal(prCreateBase('gh pr create --title "-Refactor the legend" --fill'), 'main');
  assert.equal(prCreateBase('gh pr create -t "-Bump deps" -B develop'), 'develop');
});

test('commandDirOf: git -C, else the last cd before the command; null by default; $VAR → undefined', () => {
  assert.equal(commandDirOf('git merge x'), null);
  assert.equal(commandDirOf('git -C /a/b merge x'), '/a/b');
  assert.equal(commandDirOf('cd /a && cd /b && gh pr create'), '/b');
  assert.equal(commandDirOf('cd "$REPO" && git merge x'), undefined);
});

test('command regexes stay linear on many VAR="v" lines', () => {
  const cmd = `cat > .env <<'EOF'\n${Array.from({ length: 24 }, (_, i) => `K${i}="v${i}"`).join('\n')}\nEOF`;
  const t = Date.now();
  assert.equal(mergeIntoMainTarget(cmd, 'main'), null);
  assert.equal(prCreateBase(cmd), null);
  assert.ok(Date.now() - t < 1000, `took ${Date.now() - t} ms`);
});

test('command regexes stay fast on long runs of blank lines, and still see a command after them', () => {
  const blank = '\n'.repeat(50000);
  const t = Date.now();
  assert.equal(mergeIntoMainTarget(`echo hi${blank}echo bye`, 'main'), null);
  assert.ok(Date.now() - t < 1000, `took ${Date.now() - t} ms`);
  assert.equal(mergeIntoMainTarget(`echo hi${blank}  git merge feat/x`, 'main'), 'feat/x');
  assert.equal(mergeIntoMainTarget('git checkout main &&\n  git merge feat/x', 'feat/x'), 'feat/x');
});
