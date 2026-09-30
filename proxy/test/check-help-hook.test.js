// End-to-end tests of the help guard's --hook and CLI entry points (plan Task
// 10's live checks, automated): each test builds a throwaway git repo holding a
// copy of scripts/check-help.mjs + web/help/help-lib.js — so the guard's own repo
// (ROOT) is that temp repo — then feeds the hook a tool-call JSON on stdin.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
// Children must not inherit a caller's git plumbing vars (e.g. when run from a git hook).
const CLEAN_ENV = { ...process.env, GIT_DIR: undefined, GIT_WORK_TREE: undefined, GIT_INDEX_FILE: undefined, GIT_COMMON_DIR: undefined };
const temps = [];
after(() => { for (const d of temps) rmSync(d, { recursive: true, force: true }); });

const tempDir = (prefix) => { const d = realpathSync(mkdtempSync(join(tmpdir(), prefix))); temps.push(d); return d; };
const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: CLEAN_ENV });
const write = (root, rel, text) => { mkdirSync(join(root, dirname(rel)), { recursive: true }); writeFileSync(join(root, rel), text); };

// Add the guard, one screen and a guide that's in step with it, then commit.
function landHelp(root) {
  mkdirSync(join(root, 'scripts'), { recursive: true });
  mkdirSync(join(root, 'web/help'), { recursive: true });
  copyFileSync(join(REPO, 'scripts/check-help.mjs'), join(root, 'scripts/check-help.mjs'));
  copyFileSync(join(REPO, 'web/help/help-lib.js'), join(root, 'web/help/help-lib.js'));
  write(root, 'web/app.js', 'b.push(`<button>Propose</button>`);\n');
  write(root, 'web/help/guide.md', '# Group\n\n## Start {#start}\n\nClick [[Propose]].\n');
  write(root, 'web/help/whats-new.md', '## 2026-09-01\n- **Hello.** First entry.\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', 'help lands');
}
// A repo on `main` whose guide is in step with its one screen.
function makeRepo() {
  const root = tempDir('help-hook-');
  git(root, 'init', '-q', '-b', 'main');
  landHelp(root);
  return root;
}
// Run the hook as Claude Code would: `command` about to run, the session in `cwd`.
function runHook(root, command, cwd = root) {
  const r = spawnSync(process.execPath, [join(root, 'scripts/check-help.mjs'), '--hook'], { input: JSON.stringify({ tool_name: 'Bash', tool_input: { command }, cwd }), encoding: 'utf8', env: CLEAN_ENV });
  return { code: r.status, err: r.stderr };
}
// A feature branch that changes the screen but not the help.
function screensOnlyBranch(root, name) {
  git(root, 'checkout', '-qb', name);
  write(root, 'web/app.js', 'b.push(`<button>Propose</button>`);\nconst extra = 1;\n');
  git(root, 'commit', '-qam', 'feat: screens only');
}

test('hook: blocks merging a screens-only branch into main; a "Help: none — …" commit unblocks it', () => {
  const root = makeRepo();
  screensOnlyBranch(root, 'feat');
  git(root, 'checkout', '-q', 'main');
  let r = runHook(root, 'git merge --no-ff feat');
  assert.equal(r.code, 2);
  assert.match(r.err, /changes the app's screens \(web\/app\.js\) but not web\/help\//);
  git(root, 'checkout', '-q', 'feat');
  git(root, 'commit', '-q', '--allow-empty', '-m', 'chore: no visible change', '-m', 'Help: none — test fixture');
  git(root, 'checkout', '-q', 'main');
  r = runHook(root, 'git merge --no-ff feat');
  assert.equal(r.code, 0, r.err);
});

test('hook: blocks a PR whose guide names a label that is no longer on screen', () => {
  const root = makeRepo();
  git(root, 'checkout', '-qb', 'rename');
  write(root, 'web/app.js', 'b.push(`<button>Submit for approval</button>`);\n');
  write(root, 'web/help/whats-new.md', '## 2026-09-02\n- **Renamed.** Propose is now Submit for approval.\n\n## 2026-09-01\n- **Hello.** First entry.\n');
  git(root, 'commit', '-qam', 'rename the button');
  const r = runHook(root, 'gh pr create --fill');
  assert.equal(r.code, 2);
  assert.match(r.err, /\[\[Propose\]\] no longer appears on screen/);
});

test('hook: stands aside for other commands, merge-base, merges not into main, and other repositories', () => {
  const root = makeRepo();
  screensOnlyBranch(root, 'feat');                                    // now on feat
  assert.equal(runHook(root, 'ls -la').code, 0);
  assert.equal(runHook(root, 'git merge main').code, 0);               // main INTO a feature branch
  git(root, 'checkout', '-q', 'main');
  assert.equal(runHook(root, 'git merge-base main feat').code, 0);     // read-only, not a merge
  const other = tempDir('help-other-');                                // an unrelated repository
  git(other, 'init', '-q', '-b', 'main');
  write(other, 'README.md', 'other\n');
  git(other, 'add', '-A');
  git(other, 'commit', '-qm', 'init');
  git(other, 'branch', 'x');
  assert.equal(runHook(root, 'git merge x', other).code, 0);           // the session is in the other repo
  assert.equal(runHook(root, `cd ${other} && gh pr create --fill`).code, 0);
});

test('entry point: still runs when invoked through a symlinked path (no silent pass)', () => {
  const root = makeRepo();
  write(root, 'web/help/guide.md', '# Group\n\n## Start {#start}\n\nClick [[Nope]].\n');
  git(root, 'commit', '-qam', 'break the guide');
  const link = join(tempDir('help-link-'), 'repo');
  symlinkSync(root, link);
  const r = spawnSync(process.execPath, [join(link, 'scripts/check-help.mjs')], { cwd: link, encoding: 'utf8', env: CLEAN_ENV });
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /\[\[Nope\]\] no longer appears on screen/);
});

test('hook: judges the merge result — a docs-only branch cut before the help landed is not blocked', () => {
  const root = tempDir('help-stale-');
  git(root, 'init', '-q', '-b', 'main');
  write(root, 'README.md', 'start\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', 'before the help');
  git(root, 'branch', 'old');                                        // cut before the help existed
  landHelp(root);
  git(root, 'checkout', '-q', 'old');
  write(root, 'docs/notes.md', 'docs only\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', 'docs: notes');
  git(root, 'checkout', '-q', 'main');
  const r = runHook(root, 'git merge --no-ff old');
  assert.equal(r.code, 0, r.err);
});

test('hook: guards this repo when reached via git -C from elsewhere; an option-like --base writes nothing', () => {
  const root = makeRepo();
  screensOnlyBranch(root, 'feat');
  git(root, 'checkout', '-q', 'main');
  const elsewhere = tempDir('help-elsewhere-');                      // not a git repo
  assert.equal(runHook(root, `git -C ${root} merge feat`, elsewhere).code, 2);
  git(root, 'checkout', '-q', 'feat');
  const out = join(tempDir('help-out-'), 'leak');
  const r = runHook(root, `gh pr create --base --output=${out} --fill`);
  assert.equal(r.code, 2);                                           // judged against main instead
  assert.ok(!existsSync(`${out}...HEAD`) && !existsSync(`${out}..HEAD`));
});
