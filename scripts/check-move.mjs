#!/usr/bin/env node
// Proves a split of web/app.js is a pure move, and that every script still loads.
//
//   node scripts/check-move.mjs <orig-ref> [--load]
//
// Reads web/app.js at <orig-ref> (git show) and compares it with the scripts that
// web/index.html lists now: the ones that are new since <orig-ref>, plus web/app.js
// if it is still listed. A pure move means (1) no line added or lost (a multiset of
// trimmed non-blank lines, new files' header comments ignored) and (2) the
// top-level executed statements run in the original order. Every new file must
// open with a header comment that has an "Owns:" line.
// --load also runs every classic script in order in a stub DOM (node:vm) and
// reports the first one that throws. A final `init();` is skipped.
// Exit 1 with the problems printed, else prints a one-line verdict.
import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const HEADER_RE = /^\s*\/\*[\s\S]*?\*\//;

/* ---- pure helpers (unit-tested in proxy/test/check-move.test.js) ---------- */
export function codeLines(src, { stripHeader = false } = {}) {
  let s = String(src == null ? '' : src);
  if (stripHeader) s = s.replace(HEADER_RE, '');
  return s.split('\n').map((l) => l.trimEnd()).filter((l) => l !== '');
}

const DECL_RE = /^(?:function |async function |const |let |var |class )/;
export function topLevelStatements(src) {
  return String(src == null ? '' : src).split('\n')
    .filter((l) => /^[A-Za-z_$(]/.test(l) && !DECL_RE.test(l));
}

const hasHeader = (src) => { const m = HEADER_RE.exec(String(src)); return !!m && /Owns:/.test(m[0]); };
const isApp = (name) => /(?:^|\/)app\.js$/.test(name);

function counts(lines) {
  const m = new Map();
  for (const l of lines) m.set(l, (m.get(l) || 0) + 1);
  return m;
}

export function compareMove(origSrc, files) {
  const problems = [];
  const parts = files.map((f) => ({ name: f.name, strip: !isApp(f.name), src: f.src }));
  for (const f of parts) {
    if (f.strip && !hasHeader(f.src)) problems.push(`${f.name}: missing header comment with an "Owns:" line`);
  }
  const orig = counts(codeLines(origSrc));
  const now = counts(parts.flatMap((f) => codeLines(f.src, { stripHeader: f.strip })));
  const diff = (a, b, label) => {
    const out = [];
    for (const [l, n] of a) for (let i = 0; i < n - (b.get(l) || 0); i++) out.push(`${label}: ${JSON.stringify(l)}`);
    return out;
  };
  const lines = [...diff(orig, now, 'missing'), ...diff(now, orig, 'extra')];
  problems.push(...lines.slice(0, 20));
  if (lines.length > 20) problems.push(`…and ${lines.length - 20} more missing/extra lines`);

  const a = topLevelStatements(origSrc);
  const b = parts.flatMap((f) => topLevelStatements(f.strip ? f.src.replace(HEADER_RE, '') : f.src));
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] !== b[i]) {
      problems.push(`top-level order differs at statement ${i + 1}: expected ${JSON.stringify(a[i])}, got ${JSON.stringify(b[i])}`);
      break;
    }
  }
  return problems;
}

export function scriptList(indexHtml) {
  const out = [];
  for (const m of String(indexHtml).matchAll(/<script\b([^>]*)>/gi)) {
    const attrs = m[1];
    if (/\btype\s*=\s*["']?module/i.test(attrs)) continue;
    const src = /\bsrc\s*=\s*["']([^"']+)["']/i.exec(attrs);
    if (src && !/^(?:[a-z]+:)?\/\//i.test(src[1])) out.push(src[1]);
  }
  return out;
}

/* ---- load smoke ------------------------------------------------------------ */
// A universal stub: any property is the stub, calling or constructing gives the
// stub, it converts to '' and is not a thenable. Iterating it yields nothing.
function makeStub() {
  const stub = new Proxy(function () {}, {
    get(_t, prop) {
      if (prop === Symbol.toPrimitive) return () => '';
      if (prop === 'then') return undefined;
      if (prop === Symbol.iterator) return function* () {};
      if (prop === 'length') return 0;
      return stub;
    },
    set() { return true; },
    has() { return true; },
    apply() { return stub; },
    construct() { return stub; },
  });
  return stub;
}

export function loadSmoke(scripts) {   // scripts: {name, src}[] in load order
  const stub = makeStub();
  const sandbox = {
    URL, URLSearchParams, console, TextEncoder, TextDecoder, structuredClone, AbortController,
    window: stub, document: stub, localStorage: stub, sessionStorage: stub, location: stub, history: stub,
    navigator: stub, matchMedia: stub, fetch: stub, setTimeout: stub, setInterval: stub,
    clearTimeout: stub, clearInterval: stub, requestAnimationFrame: stub, addEventListener: stub,
  };
  const ctx = vm.createContext(sandbox);
  vm.runInContext('globalThis.globalThis = globalThis', ctx);
  const last = scripts.length - 1;
  for (let i = 0; i <= last; i++) {
    let { name, src } = scripts[i];
    if (i === last) src = src.replace(/(^|\n)init\(\);[ \t]*\n?$/, '$1');
    try {
      new vm.Script(src, { filename: name }).runInContext(ctx);
    } catch (e) {
      return [`load: ${name} threw ${e && e.name}: ${e && e.message}`];
    }
  }
  return [];
}

/* ---- CLI -------------------------------------------------------------------- */
function cli(args) {
  const ref = args.find((a) => !a.startsWith('--'));
  if (!ref) { process.stderr.write('usage: node scripts/check-move.mjs <orig-ref> [--load]\n'); return 1; }
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const git = (...a) => execFileSync('git', a, { cwd: root, encoding: 'utf8', maxBuffer: 64 << 20 });
  const existedAtRef = (p) => { try { git('cat-file', '-e', `${ref}:${p}`); return true; } catch { return false; } };
  const orig = git('show', `${ref}:web/app.js`);
  const listed = scriptList(readFileSync(join(root, 'web/index.html'), 'utf8'));
  const read = (src) => ({ name: `web/${src}`, src: readFileSync(join(root, 'web', src), 'utf8') });
  const files = listed.filter((s) => s === 'app.js' || !existedAtRef(`web/${s}`)).map(read);
  const problems = compareMove(orig, files);
  if (args.includes('--load')) problems.push(...loadSmoke(listed.map(read)));
  if (problems.length) {
    process.stderr.write(`check-move: ${problems.length} problem(s)\n${problems.map((p) => `- ${p}`).join('\n')}\n`);
    return 1;
  }
  const n = codeLines(orig).length, m = topLevelStatements(orig).length;
  process.stdout.write(`check-move: pure move (${n} lines, ${m} top-level statements in order)${args.includes('--load') ? '; all scripts load' : ''}\n`);
  return 0;
}

// Run only when executed directly (the unit tests import the helpers above).
const isEntry = () => { try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } };
if (process.argv[1] && isEntry()) process.exitCode = cli(process.argv.slice(2));
