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
