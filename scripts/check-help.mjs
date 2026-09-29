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
// change web/help/ — or carry a commit-message line "Help: none — <reason>".
// Exit codes — CLI: 0 ok, 1 problems/error. Hook: 0 allow, 2 block, 1 guard error (never blocks).
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import '../web/help/help-lib.js';

const H = globalThis.HelpLib;

/* ---- pure helpers (unit-tested in proxy/test/check-help.test.js) ---------- */
export const isScreensFile = (p) => /^web\/[^/]+\.(?:js|html)$/.test(p);
export const isHelpFile = (p) => p.startsWith('web/help/');

// On-screen text, normalized for comparison: decode the entities we use, drop
// icons/arrows/ellipses/dashes, collapse whitespace.
export function normText(s) {
  return String(s == null ? '' : s)
    .replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ').replace(/&#?\w+;/g, ' ')
    .replace(/[^\p{L}\p{N} +&'’/.,?!:()-]/gu, ' ')
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

// Candidate on-screen text in the screens code: text between tags (>Label<)
// and whole string literals ('…', "…", and `…` without ${}).
export function screenTexts(sources) {
  const out = new Set();
  const add = (t) => { const n = normText(t); if (n) out.add(n); };
  for (const src of sources) {
    const s = stripCodeComments(src);
    for (const m of s.matchAll(/>([^<>]*)</g)) add(m[1]);
    for (const m of s.matchAll(/'([^'\\\n]*)'|"([^"\\\n]*)"|`([^`\\$]*)`/g)) add(m[1] ?? m[2] ?? m[3]);
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

const CMD = String.raw`(?:^|&&|\|\||;|\||\(|\n)\s*`;   // a command position in a shell line
const MERGE_RE = new RegExp(CMD + String.raw`git\s+merge\b`);
const TO_MAIN_RE = new RegExp(CMD + String.raw`git\s+(?:checkout|switch)\s+main\b`);
const PR_RE = new RegExp(CMD + String.raw`gh\s+pr\s+create\b`);
const SEPARATORS = new Set(['&&', '||', ';', '|']);
const VALUE_OPTS = new Set(['-m', '--message', '-F', '--file', '-s', '--strategy', '-X', '--strategy-option', '--cleanup', '--into-name']);

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

// The base of a `gh pr create` (default main), or null when the command doesn't create a PR.
export function prCreateBase(command) {
  const cmd = String(command || '');
  const m = PR_RE.exec(cmd);
  if (!m) return null;
  const words = shellWords(cmd.slice(m.index + m[0].length));
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (SEPARATORS.has(w)) break;
    if (w === '--base' || w === '-B') return words[i + 1] || 'main';
    if (w.startsWith('--base=')) return w.slice(7) || 'main';
  }
  return 'main';
}

export const hasHelpNone = (messages) => /^[ \t]*help:[ \t]*none[ \t]*[—–:-]+[ \t]*\S/im.test(String(messages || ''));

export function branchVerdict(files, messages) {
  const screens = files.filter(isScreensFile);
  if (!screens.length || files.some(isHelpFile) || hasHelpNone(messages)) return null;
  return `this branch changes the app's screens (${screens.join(', ')}) but not web/help/`;
}

/* ---- git plumbing + entry points ------------------------------------------ */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let CWD = ROOT;   // repo toplevel the git commands run in (hook mode: the session's cwd)
const git = (args) => execFileSync('git', args, { cwd: CWD, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });

function readAt(ref, path) {   // a file from <ref>'s commit, or from the working tree when ref is empty
  try { return ref ? git(['show', `${ref}:${path}`]) : readFileSync(join(CWD, path), 'utf8'); } catch { return null; }
}
function screensSourcesAt(ref) {
  const names = ref ? git(['ls-tree', '--name-only', ref, 'web/']).split('\n') : readdirSync(join(CWD, 'web')).map((f) => `web/${f}`);
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
    try { git(['rev-parse', '--verify', '--quiet', `${cand}^{commit}`]); return cand; } catch { /* try the next */ }
  }
  return name;
}
function branchProblems(base, ref) {
  const b = existingRef(base);
  const files = git(['diff', '--name-only', `${b}...${ref}`]).split('\n').filter(Boolean);
  const verdict = branchVerdict(files, git(['log', '--format=%B', `${b}..${ref}`]));
  return verdict ? [`${verdict} (${ref} vs ${b})`] : [];
}

const FIX = 'Fix: update web/help/guide.md (and add a dated line to web/help/whats-new.md). If a program lead would notice nothing, add a commit whose message has a line "Help: none — <reason>" instead. Rules: CLAUDE.md → Conventions → "Help ships with the change".';
const listOf = (problems) => problems.map((p) => `  - ${p}`).join('\n');

function cli(args) {
  const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
  const ref = opt('--branch'), base = opt('--base') || 'main';
  try {
    const problems = [...contentProblems(ref), ...(ref ? branchProblems(base, ref) : [])];
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
  if (input.tool_name !== 'Bash' || !/\bgit\s+merge\b|\bgh\s+pr\s+create\b/.test(command)) return 0;   // fast path: not ours
  try {
    CWD = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: input.cwd || process.cwd(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const mergeRef = mergeIntoMainTarget(command, git(['rev-parse', '--abbrev-ref', 'HEAD']).trim());
    const prBase = mergeRef ? null : prCreateBase(command);
    if (!mergeRef && !prBase) return 0;
    const [ref, base] = mergeRef ? [mergeRef, 'main'] : ['HEAD', prBase];
    const problems = [...contentProblems(ref), ...branchProblems(base, ref)];
    if (!problems.length) return 0;
    process.stderr.write(`Help guard blocked this ${mergeRef ? `merge of ${ref} into main` : 'pull request'} — the in-app help is out of step with the app:\n${listOf(problems)}\n${FIX}\nThen run the command again.\n`);
    return 2;
  } catch (err) {
    process.stderr.write(`check-help hook skipped (guard error, not blocking): ${err.message}\n`);
    return 1;
  }
}

// Run only when executed directly (the unit tests import the helpers above).
// process.exitCode (not process.exit) so stderr to a pipe is flushed first.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  process.exitCode = args.includes('--hook') ? await hook() : cli(args);
}
