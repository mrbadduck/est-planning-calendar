#!/usr/bin/env node
// Help guard — keeps the in-app help (web/help/) in step with the app.
// Design: docs/superpowers/specs/2026-09-29-in-app-help-design.md (§7–8).
//
//   node scripts/check-help.mjs                               content checks (working tree)
//   node scripts/check-help.mjs --branch <ref> [--base main]  + branch check, reading <ref>'s commits
//   node scripts/check-help.mjs --hook                        Claude Code PreToolUse hook (stdin = tool-call JSON)
//
// Content: every [[label]] in guide.md still appears on screen; guide ids, links
// and embeds are valid; the app's openHelp('id') / help:'id' / data-help="id"
// name real guides; whats-new.md is dated, newest first.
// Branch: a branch that changes the screens (top-level web/*.js|html) must also
// change the help text (web/help/*.md) — or carry a commit-message line
// "Help: none — <reason>".
// Hook: acts only on `git merge <ref>` into main and on `gh pr create`, and only
// when the command runs in THIS repository (any worktree of it).
// Exit codes — CLI: 0 ok, 1 problems/error. Hook: 0 allow, 2 block, 1 guard error (never blocks).
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import '../web/help/help-lib.js';

const H = globalThis.HelpLib;

/* ---- pure helpers (unit-tested in proxy/test/check-help.test.js) ---------- */
export const isScreensFile = (p) => /^web\/[^/]+\.(?:js|html)$/.test(p);
export const isHelpFile = (p) => /^web\/help\/[^/]+\.md$/.test(p);   // the help text — not its renderer

// On-screen text, normalized for comparison: decode the entities we use, fold
// curly apostrophes, drop icons/arrows/ellipses/dashes, collapse whitespace.
export function normText(s) {
  return String(s == null ? '' : s)
    .replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ').replace(/&#?\w+;/g, ' ')
    .replace(/[‘’]/g, "'")
    .replace(/[^\p{L}\p{N} +&'/.,?!:()-]/gu, ' ')
    .replace(/\s+/g, ' ').trim();
}

// Blank out HTML comments and JS block/line comments, keeping newlines so line
// numbers survive. `//` starts a comment only at line start or after whitespace
// or punctuation — never after `:` — so 'https://…' strings survive.
export function stripCodeComments(src) {
  const blank = (m) => m.replace(/[^\n]/g, ' ');
  return String(src == null ? '' : src)
    .replace(/<!--[\s\S]*?-->/g, blank)
    .replace(/\/\*[\s\S]*?\*\//g, blank)
    .replace(/(^|[\s;{}(),])\/\/[^\n]*/g, '$1');
}

// Every JS string-literal body and template chunk (the static text between
// ${…}), from one pass that tracks strings, nested templates, comments and regex
// literals. A regex alone can't pair backticks once a template holds ${, and the
// strings after it would be hidden (a third of web/app.js, measured).
const KW_BEFORE_REGEX = /(?:^|[^\w$])(?:return|typeof|instanceof|in|of|new|delete|void|throw|case|do|else|yield|await)$/;
export function jsStrings(src) {
  const s = String(src == null ? '' : src), n = s.length, out = [], opened = [];
  let i = 0, depth = 0, regexOk = true;
  const chunk = () => {   // i is just past a ` or the } that closes a ${
    let t = '';
    while (i < n) {
      const c = s[i];
      if (c === '\\') { t += s[i + 1] || ''; i += 2; continue; }
      if (c === '`') { i++; out.push(t); regexOk = false; return; }
      if (c === '$' && s[i + 1] === '{') { i += 2; out.push(t); opened.push(depth++); regexOk = true; return; }
      t += c; i++;
    }
    out.push(t);
  };
  while (i < n) {
    const c = s[i], d = s[i + 1];
    if (c === '/' && d === '/') { while (i < n && s[i] !== '\n') i++; continue; }
    if (c === '/' && d === '*') { const e = s.indexOf('*/', i + 2); i = e < 0 ? n : e + 2; continue; }
    if (c === "'" || c === '"') {
      let t = ''; i++;
      while (i < n && s[i] !== c && s[i] !== '\n') { if (s[i] === '\\') { t += s[i + 1] || ''; i += 2; } else t += s[i++]; }
      i++; out.push(t); regexOk = false; continue;
    }
    if (c === '`') { i++; chunk(); continue; }
    if (c === '/' && regexOk) {   // regex literal: skip it whole ([…] may hold / and quotes)
      let k = i + 1, cls = false;
      while (k < n && s[k] !== '\n') { if (s[k] === '\\') k++; else if (s[k] === '[') cls = true; else if (s[k] === ']') cls = false; else if (s[k] === '/' && !cls) break; k++; }
      if (s[k] === '/') { i = k + 1; while (i < n && /[a-z]/i.test(s[i])) i++; regexOk = false; continue; }
    }
    if (c === '{') depth++;
    else if (c === '}') {
      if (opened.length && opened[opened.length - 1] === depth - 1) { opened.pop(); depth--; i++; chunk(); continue; }
      depth--;
    }
    if (/[\w$]/.test(c)) { let k = i; while (k < n && /[\w$]/.test(s[k])) k++; regexOk = KW_BEFORE_REGEX.test(s.slice(Math.max(0, i - 12), k)); i = k; continue; }
    if (!/\s/.test(c)) regexOk = !/[)\]}]/.test(c);
    i++;
  }
  return out;
}

// Candidate on-screen text in the screens code: text between tags (>Label<),
// whole quoted strings, and every JS string/template chunk.
export function screenTexts(sources) {
  const out = new Set();
  const add = (t) => { const n = normText(t); if (n) out.add(n); };
  for (const src of sources) {
    const s = stripCodeComments(src);
    for (const m of s.matchAll(/>([^<>]*)</g)) add(m[1]);
    for (const m of s.matchAll(/'([^'\\\n]*)'|"([^"\\\n]*)"|`([^`\\$]*)`/g)) add(m[1] ?? m[2] ?? m[3]);
    for (const t of jsStrings(src)) add(t);
  }
  return out;
}

export function labelProblems(guideMd, sources) {
  const texts = screenTexts(sources.map((s) => s.src));
  const out = [];
  for (const { label, line } of H.uiLabels(guideMd)) {
    const n = normText(label);
    if (!n) out.push(`web/help/guide.md:${line} [[${label}]] has no words to check — write it in **bold** instead`);
    else if (!texts.has(n)) out.push(`web/help/guide.md:${line} [[${label}]] no longer appears on screen — update the guide to match the app`);
  }
  return out;
}

const APP_REF_RES = [/openHelp\(\s*['"]([^'"]*)['"]/g, /\bhelp\s*:\s*['"]([^'"]*)['"]/g, /data-help="([^"]*)"/g];
const lineAt = (s, i) => s.slice(0, i).split('\n').length;

export function refProblems(guideMd, newsMd, sources) {
  if (guideMd == null) return ['web/help/guide.md is missing'];
  const out = [];
  const { guides, errors } = H.parseGuide(guideMd);
  for (const e of errors) out.push(`web/help/guide.md:${e.line} ${e.message}`);
  const ids = new Set([...guides.map((g) => g.id), ...H.RESERVED]);
  for (const l of H.guideLinks(guideMd)) if (!ids.has(l.id)) out.push(`web/help/guide.md:${l.line} link to #${l.id} — no guide has that id`);
  for (const e of H.embeds(guideMd)) {
    if (!H.EMBEDS.includes(e.name)) out.push(`web/help/guide.md:${e.line} unknown embed {{${e.name}}} (known: ${H.EMBEDS.join(', ')})`);
    else if (!e.ownLine) out.push(`web/help/guide.md:${e.line} {{${e.name}}} must be on a line of its own`);
  }
  for (const { file, src } of sources) {
    const code = stripCodeComments(src);
    for (const re of APP_REF_RES) {
      for (const m of code.matchAll(re)) {
        if (m[1] && !ids.has(m[1])) out.push(`${file}:${lineAt(code, m.index)} help link "${m[1]}" — no guide has that id`);
      }
    }
  }
  if (newsMd == null) out.push('web/help/whats-new.md is missing');
  else for (const e of H.parseWhatsNew(newsMd).errors) out.push(`web/help/whats-new.md:${e.line} ${e.message}`);
  return out;
}

const CMD = String.raw`(?:^|&&|\|\||;|\||\(|\n)[ \t]*`;                // a command position in a shell line (each \n is its own)
// One shell word. Its alternatives start with different characters (" or ' or
// neither), so any text matches exactly one way — no catastrophic backtracking
// on the hook's fast path, which sees every Bash call.
const WORD = String.raw`(?:"[^"]*"|'[^']*'|[^\s;&|"'])+`;
const ENV = String.raw`(?:\w+=(?:${WORD})?[ \t]+)*`;     // VAR=value prefixes, on the command's own line
// `git` plus its global options (-C dir, -c k=v, --no-pager, …); group 1 = those options.
const GIT = String.raw`git((?:[ \t]+(?:-[Cc][ \t]+${WORD}|--?[A-Za-z][\w-]*(?:=${WORD})?))*)[ \t]+`;
const MERGE_RE = new RegExp(CMD + ENV + GIT + String.raw`merge(?![\w-])`);   // not merge-base / merge-tree / merge-file
const TO_MAIN_RE = new RegExp(CMD + ENV + GIT + String.raw`(?:checkout|switch)(?:\s+-[\w-]+)*\s+main(?![\w./-])`);
const PR_RE = new RegExp(CMD + ENV + String.raw`gh\s+pr\s+create(?![\w-])`);
const CD_RE = new RegExp(CMD + String.raw`cd\s+("[^"]*"|'[^']*'|[^\s;&|()]+)`, 'g');
const SEPARATORS = new Set(['&&', '||', ';', '|']);
const VALUE_OPTS = new Set(['-m', '--message', '-F', '--file', '-s', '--strategy', '-X', '--strategy-option', '--cleanup', '--into-name']);
// gh flags that take a value — skipped so a title like "-Refactor…" isn't read as -R/-B.
const GH_VALUE_OPTS = new Set(['-t', '--title', '-b', '--body', '-F', '--body-file', '-H', '--head', '-a', '--assignee', '-l', '--label', '-m', '--milestone', '-p', '--project', '-r', '--reviewer', '-T', '--template']);

// Quote-aware shell words ("…" may span lines, e.g. a heredoc commit message).
function shellWords(s) {
  return [...s.matchAll(/"((?:[^"\\]|\\.)*)"|'([^']*)'|(&&|\|\||[;|])|([^\s;|&"']+)/g)].map((m) => m[1] ?? m[2] ?? m[3] ?? m[4]);
}

// The branch a command merges INTO main — when main is checked out, or when the
// same command switches to it first (`git checkout main && git merge <ref>`).
export function mergeIntoMainTarget(command, currentBranch) {
  const cmd = String(command || '');
  const m = MERGE_RE.exec(cmd);
  if (!m) return null;
  const end = m.index + m[0].length;
  if (currentBranch !== 'main' && !TO_MAIN_RE.test(cmd.slice(0, end))) return null;
  const words = shellWords(cmd.slice(end));
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (SEPARATORS.has(w)) break;
    if (['--abort', '--continue', '--quit', '--skip'].includes(w)) return null;
    if (VALUE_OPTS.has(w)) { i++; continue; }
    if (w.startsWith('-')) continue;
    return w;
  }
  return null;
}

// The base of a `gh pr create` (default main; never an option-like value), or
// null when the command doesn't create a PR here (-R/--repo names another repo).
export function prCreateBase(command) {
  const cmd = String(command || '');
  const m = PR_RE.exec(cmd);
  if (!m) return null;
  const words = shellWords(cmd.slice(m.index + m[0].length));
  let base = '';
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (SEPARATORS.has(w)) break;
    if (GH_VALUE_OPTS.has(w)) { i++; continue; }
    if (w === '-R' || w === '--repo' || /^-R./.test(w) || w.startsWith('--repo=')) return null;
    if (w === '--base' || w === '-B') { base = words[i + 1] || ''; i++; }
    else if (w.startsWith('--base=')) base = w.slice(7);
    else if (/^-B./.test(w)) base = w.slice(2);
  }
  return base && !base.startsWith('-') ? base : 'main';
}

// Where a merge/PR command's git runs: `git -C <dir>`, else the last `cd <dir>`
// before it. null = the session's cwd; undefined = can't tell ($VAR) → stand aside.
export function commandDirOf(command) {
  const cmd = String(command || '');
  const m = MERGE_RE.exec(cmd) || PR_RE.exec(cmd);
  if (!m) return null;
  const opts = shellWords(m[1] || ''), c = opts.lastIndexOf('-C');   // m[1] = git's global options (MERGE_RE only)
  let dir = c >= 0 ? opts[c + 1] : null;
  if (!dir) for (const cd of cmd.slice(0, m.index).matchAll(CD_RE)) dir = shellWords(cd[1])[0];
  if (!dir) return null;
  if (/[$`]/.test(dir)) return undefined;
  return dir === '~' || dir.startsWith('~/') ? join(homedir(), dir.slice(1)) : dir;
}

export const hasHelpNone = (messages) => /^[ \t]*help:[ \t]*none[ \t]*[—–:-]+[ \t]*\S/im.test(String(messages || ''));

export function branchVerdict(files, messages) {
  const screens = files.filter(isScreensFile);
  if (!screens.length || files.some(isHelpFile) || hasHelpNone(messages)) return null;
  return `this branch changes the app's screens (${screens.join(', ')}) but not web/help/`;
}

/* ---- git plumbing + entry points ------------------------------------------ */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let CWD = ROOT;   // repo toplevel the git commands run in (hook mode: where the command runs)
const EOO = '--end-of-options';   // after this, a ref can't be read as a git option (e.g. a --base of "--output=…")
const git = (args) => execFileSync('git', ['-c', 'core.quotePath=false', '-c', 'color.ui=false', ...args], { cwd: CWD, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
// The shared .git directory — the same for every worktree of one repository.
const commonDir = (dir) => realpathSync(resolve(dir, execFileSync('git', ['rev-parse', '--git-common-dir'], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()));

function readAt(ref, path) {   // a file from <ref>'s commit, or from the working tree when ref is empty
  try { return ref ? git(['show', EOO, `${ref}:${path}`]) : readFileSync(join(CWD, path), 'utf8'); } catch { return null; }
}
function screensSourcesAt(ref) {
  const names = ref ? git(['ls-tree', '--name-only', EOO, ref, 'web/']).split('\n') : readdirSync(join(CWD, 'web')).map((f) => `web/${f}`);
  return names.filter(isScreensFile).map((file) => ({ file, src: readAt(ref, file) || '' }));
}
function contentProblems(ref) {
  const sources = screensSourcesAt(ref);
  const guideMd = readAt(ref, 'web/help/guide.md');
  const newsMd = readAt(ref, 'web/help/whats-new.md');
  return [...refProblems(guideMd, newsMd, sources), ...(guideMd == null ? [] : labelProblems(guideMd, sources))];
}
function existingRef(name) {   // `main`, else `origin/main` (a fresh clone may only have the remote one)
  for (const cand of [name, `origin/${name}`]) {
    try { git(['rev-parse', '--verify', '--quiet', EOO, `${cand}^{commit}`]); return cand; } catch { /* try the next */ }
  }
  return name;
}
function branchProblems(base, ref) {
  const b = existingRef(base);
  const files = git(['diff', '--name-only', '--no-renames', EOO, `${b}...${ref}`]).split('\n').filter(Boolean);
  const verdict = branchVerdict(files, git(['log', '--format=%B', EOO, `${b}..${ref}`]));
  return verdict ? [`${verdict} (${ref} vs ${b})`] : [];
}
// The tree the merge would produce — git ≥ 2.38 builds it in the object store
// without touching any branch or worktree — so a branch cut before the latest
// help is judged with main's help, as the GitHub check (a PR's merge commit) is.
// On a conflict or an older git: the ref's own tree.
function mergedTree(base, ref) {
  try { return git(['merge-tree', '--write-tree', '--no-messages', EOO, existingRef(base), ref]).split('\n')[0].trim(); } catch { return ref; }
}

const FIX = 'Fix: update web/help/guide.md (and add a dated line to web/help/whats-new.md). If a program lead would notice nothing, add a commit whose message has a line "Help: none — <reason>" instead. Rules: CLAUDE.md → Conventions → "Help ships with the change".';
const USAGE = 'usage: node scripts/check-help.mjs [--branch <ref> [--base <ref>]] | --hook';
const listOf = (problems) => problems.map((p) => `  - ${p}`).join('\n');

function cli(args) {
  const opts = {};
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i], value = args[i + 1];
    if (!['--branch', '--base'].includes(flag)) { console.error(`check-help: unexpected argument "${flag}" — ${USAGE}`); return 1; }
    if (!value || value.startsWith('-')) { console.error(`check-help: ${flag} needs a value — ${USAGE}`); return 1; }
    opts[flag] = value;
  }
  const ref = opts['--branch'], base = opts['--base'] || 'main';
  try {
    const problems = [...contentProblems(ref ? mergedTree(base, ref) : undefined), ...(ref ? branchProblems(base, ref) : [])];
    if (!problems.length) { console.log(`check-help: OK${ref ? ` (${ref} vs ${base})` : ''}`); return 0; }
    console.error(`check-help: ${problems.length} problem${problems.length === 1 ? '' : 's'}\n${listOf(problems)}\n${FIX}`);
    return 1;
  } catch (err) {
    console.error(`check-help: could not run — ${err.message}`);
    return 1;
  }
}

async function hook() {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  let input;
  try { input = JSON.parse(raw || '{}'); } catch { return 0; }
  const command = (input.tool_input && input.tool_input.command) || '';
  if (input.tool_name !== 'Bash' || !(MERGE_RE.test(command) || PR_RE.test(command))) return 0;   // fast path: not ours
  const dir = commandDirOf(command);
  if (dir === undefined) return 0;                                // can't tell where it runs ($VAR) — stand aside
  try {
    CWD = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: resolve(input.cwd || process.cwd(), dir || '.'), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (commonDir(CWD) !== commonDir(ROOT)) return 0;              // another repository — not ours to guard
  } catch { return 0; }                                            // not in a git repo
  try {
    const mergeRef = mergeIntoMainTarget(command, git(['rev-parse', '--abbrev-ref', 'HEAD']).trim());
    const prBase = mergeRef ? null : prCreateBase(command);
    if (!mergeRef && !prBase) return 0;
    const [ref, base] = mergeRef ? [mergeRef, 'main'] : ['HEAD', prBase];
    const problems = [...contentProblems(mergedTree(base, ref)), ...branchProblems(base, ref)];
    if (!problems.length) return 0;
    process.stderr.write(`Help guard blocked this ${mergeRef ? `merge of ${ref} into main` : 'pull request'} — the in-app help is out of step with the app:\n${listOf(problems)}\n${FIX}\nThen run the command again.\n`);
    return 2;
  } catch (err) {
    process.stderr.write(`check-help hook skipped (guard error, not blocking): ${err.message}\n`);
    return 1;
  }
}

// Run only when executed directly (the unit tests import the helpers above).
// Compare REAL paths: Node resolves symlinks in import.meta.url but not in
// argv[1], and a mismatch would silently skip the guard.
const isEntry = () => { try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } };
if (process.argv[1] && isEntry()) {
  const args = process.argv.slice(2);
  process.exitCode = args.includes('--hook') ? await hook() : cli(args);   // exitCode, not exit(): piped stderr flushes first
}
