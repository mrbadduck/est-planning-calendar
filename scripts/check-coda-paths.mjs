#!/usr/bin/env node
// check.sh rule 7: the write overlay's read and write paths (decision 0012).
//
// Every Worker write to the planning, slots, claims or venues tables goes through
// codaWrite (proxy/src/worker-io.js), and every read of them through overlayRead.
// This flags, in proxy/src/*.js, a direct Coda call to one of those tables:
//   - a write: fetch(<rows url>, { method: 'PUT' | 'POST' | 'DELETE' … })
//   - a read:  readAllRows(<rows url>) or a single-row fetch(<rows url>/<id>)
// unless ALLOW below lists it with a reason. A table this can't name counts as guarded
// (classify it in ALLOW). An ALLOW entry that matches nothing is a problem too, so the
// list never outlives the code it excuses.
//
//   node scripts/check-coda-paths.mjs    exit 0 ok, 1 problems (run by scripts/check.sh)
//
// What it sees: the first argument of fetch( / readAllRows( when it is a template with
// /tables/${X}/rows, or a rows-url variable (rowsUrl, venuesUrl, …). A call is a write
// when its options carry `method:` other than GET, in any quote style.
// Blind spot (accepted): it doesn't follow a URL built elsewhere and passed in a variable
// (`new URL(x)` then fetch(u.toString()), or a bare `url`). codaWrite's own
// fetch(url, …) is one of those, by design; so is eb-sync-run.js's rowsForEb (its file is
// allowlisted). Review such calls by hand. Unit-tested in proxy/test/check-coda-paths.test.js.
import { readFileSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Table expressions (the X in /tables/${X}/rows) and rows-url variables.
export const GUARDED = new Set([
  'tableId', 'c.tableId', 'env.CODA_TABLE_ID',                 // EST Planning Events SRC
  'env.CODA_SLOTS_TABLE', 'env.CODA_CLAIMS_TABLE',            // gather slots and claims
  'VENUES_TABLE', 'EB_VENUES_TABLE', 'REF_TABLES.venues', 'REF_TABLES[name]',   // EST Venues SRC (REF_TABLES[name] includes it)
  'rowsUrl', 'c.rowsUrl', 'venuesUrl', 'slotsUrl', 'claimsUrl', 'btnUrl',
]);
export const OTHER = new Set([   // tables the overlay doesn't cover (0012: People and Programs are out of scope)
  'env.CODA_PUBLISH_LOG_TABLE', 'env.CODA_FEEDBACK_TABLE', 'ft',   // Publish Log, Roadmap Feedback
  'REFERENCES_TABLE', 'REF_TABLES.people', 'REF_TABLES.programs', 'VENUE_TYPES_TABLE', 'PEOPLE_TABLE',
]);

// Whole files left out, with the reason.
export const ALLOW_FILES = {
  'proxy/src/eb-sync-run.js': 'deferred: sync runners still write directly, see roadmap',
  'proxy/src/gcal-run.js': 'deferred: sync runners still write directly, see roadmap',
};
// Single sites: `match` is a substring of the call (from its name to its closing paren);
// `count` is how many calls it must match, so a new call can't hide behind an old entry.
export const ALLOW = [
  // Reads the overlay is merged into (overlayRead / mergedRows right after the read).
  { file: 'proxy/src/overlay-routes.js', match: 'fetch(`${base}/docs/${docId}/tables/${tableId}/rows/${encodeURIComponent(rowId)}?${query}`',
    reason: 'readRowMerged: the one-row read overlayRead merges into (planning, claims, slots, venues)', count: 1 },
  { file: 'proxy/src/worker.js', match: 'readAllRows(rowsUrl, auth)',
    reason: '/rows: the snapshot planningList merges the overlay into', count: 1 },
  { file: 'proxy/src/worker-io.js', match: 'readAllRows(`${base}/docs/${docId}/tables/${REF_TABLES[name]}/rows`',
    reason: 'fetchRefItems: /ref/venues merges the overlay before venueRefItem (programs and venue types are not guarded)', count: 1 },
  { file: 'proxy/src/worker.js', match: 'readAllRows(venuesUrl', reason: 'POST /venues: the duplicate-name read mergedRows merges into', count: 1 },
  { file: 'proxy/src/worker.js', match: 'readAllRows(`${base}/docs/${docId}/tables/${EB_VENUES_TABLE}/rows`', reason: 'publish: the Venues read mergedRows merges into', count: 1 },
  { file: 'proxy/src/worker.js', match: 'readAllRows(`${base}/docs/${docId}/tables/${env.CODA_SLOTS_TABLE}/rows`', reason: 'slots reads mergedRows merges into (roster, /slots, buildMyClaims)', count: 3 },
  { file: 'proxy/src/worker.js', match: 'readAllRows(`${base}/docs/${docId}/tables/${env.CODA_CLAIMS_TABLE}/rows`', reason: 'claims reads mergedRows merges into (roster, /slots, buildMyClaims)', count: 3 },
  { file: 'proxy/src/worker.js', match: 'readAllRows(`${base}/docs/${docId}/tables/${t}/rows`', reason: 'the gather snapshot: raw rows gatherRows merges into', count: 1 },
  { file: 'proxy/src/worker.js', match: 'readAllRows(`${base}/docs/${docId}/tables/${tableId}/rows`, auth, { rich: true })', reason: 'buildMyClaims: the planning read gatherRows merges into', count: 1 },
  // Permanent.
  { file: 'proxy/src/worker.js', match: 'fetch(btnUrl',
    reason: 'the notes-doc button: Coda runs the button and writes the doc URL, so nothing is overlaid', count: 1 },
  { file: 'proxy/src/worker.js', match: 'fetch(`${base}/docs/${docId}/tables/${table}/rows`',
    reason: 'findOrCreatePerson writes People: not a guarded table', count: 1 },
];

// Blank out comments, keeping newlines (line numbers survive). `//` starts a comment
// only at line start or after whitespace or punctuation, so 'https://…' survives.
export function stripComments(src) {
  const blank = (m) => m.replace(/[^\n]/g, ' ');
  return String(src).replace(/\/\*[\s\S]*?\*\//g, blank).replace(/(^|[\s;{}(),])\/\/[^\n]*/g, '$1');
}

// The table a call's first argument names, or null when it isn't a Coda rows URL.
export function tableOf(arg) {
  const t = /\/tables\/\$\{([^}]+)\}\/rows\b/.exec(arg);
  if (t) return t[1].trim();
  const v = /^`?\$\{([\w.]+)\}/.exec(arg) || /^([\w.]*[uU]rl)$/.exec(arg);
  if (v && v[1] !== 'url' && /[uU]rl$/.test(v[1])) return v[1];
  return null;
}

// Every Coda rows call in one file: {line, kind: 'read'|'write', table, text}.
export function codaSites(src) {
  const s = stripComments(src), out = [];
  const re = /(?<![\w.$])(fetch|readAllRows)\(/g;
  let m;
  while ((m = re.exec(s))) {
    if (/function\s+$/.test(s.slice(Math.max(0, m.index - 12), m.index))) continue;   // a definition
    let i = m.index + m[0].length, depth = 1, comma = -1;
    for (; i < s.length && depth > 0 && i - m.index < 1200; i++) {
      const ch = s[i];
      if (ch === '(' || ch === '{' || ch === '[') depth++;
      else if (ch === ')' || ch === '}' || ch === ']') depth--;
      else if (ch === ',' && depth === 1 && comma < 0) comma = i;
    }
    const text = s.slice(m.index, i);
    const args = s.slice(m.index + m[0].length, i - 1);
    const arg = (comma < 0 ? args : s.slice(m.index + m[0].length, comma)).trim();
    const table = tableOf(arg);
    if (!table) continue;
    const write = m[1] === 'fetch' && /method:\s*(?!['"`]GET['"`])['"`\w]/.test(args);
    out.push({ line: s.slice(0, m.index).split('\n').length, kind: write ? 'write' : 'read', table, text });
  }
  return out;
}

// files: {path: source}. Problems as strings; [] when clean.
export function codaPathProblems(files, { allow = ALLOW, allowFiles = ALLOW_FILES } = {}) {
  const problems = [], used = new Map();   // ALLOW index -> calls matched
  for (const [path, src] of Object.entries(files)) {
    if (allowFiles[path]) continue;
    for (const site of codaSites(src)) {
      if (OTHER.has(site.table)) continue;
      const hit = allow.findIndex((a) => a.file === path && site.text.includes(a.match));
      if (hit >= 0) { used.set(hit, (used.get(hit) || 0) + 1); continue; }
      const what = GUARDED.has(site.table) ? `a direct Coda ${site.kind} of ${site.table}` : `a Coda ${site.kind} of an unclassified table (${site.table})`;
      problems.push(`${path}:${site.line}: ${what}. Go through ${site.kind === 'write' ? 'codaWrite' : 'overlayRead'} (proxy/src/worker-io.js), or add it to ALLOW in scripts/check-coda-paths.mjs with a reason`);
    }
  }
  allow.forEach((a, i) => {
    if (!Object.prototype.hasOwnProperty.call(files, a.file)) return;
    const n = used.get(i) || 0, want = a.count == null ? 1 : a.count;
    if (!n) problems.push(`scripts/check-coda-paths.mjs: ALLOW entry "${a.reason}" (${a.file}) matches nothing; remove it`);
    else if (n !== want) problems.push(`scripts/check-coda-paths.mjs: ALLOW entry "${a.reason}" (${a.file}) matches ${n} calls, expected ${want}; route the new call through the helpers or update the count with a reason`);
  });
  return problems;
}

export function readSources(root) {
  const dir = join(root, 'proxy/src'), files = {};
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.js')).sort()) files[`proxy/src/${f}`] = readFileSync(join(dir, f), 'utf8');
  return files;
}

const isEntry = () => { try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } };
if (process.argv[1] && isEntry()) {
  const problems = codaPathProblems(readSources(join(dirname(fileURLToPath(import.meta.url)), '..')));
  if (problems.length) { process.stderr.write(problems.map((p) => `  ${p}`).join('\n') + '\n'); process.exitCode = 1; }
}
