// check.sh rule 7 (scripts/check-coda-paths.mjs): Coda writes and reads of the planning,
// slots, claims and venues tables go through codaWrite / overlayRead, or are on its
// allowlist with a reason (decision 0012).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { codaSites, codaPathProblems, readSources, tableOf, ALLOW, ALLOW_FILES } from '../../scripts/check-coda-paths.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

test('the real proxy/src passes, and every allowlist entry has a reason and is used', () => {
  const files = readSources(root);
  assert.deepEqual(codaPathProblems(files), []);
  for (const a of ALLOW) assert.ok(a.reason && a.reason.length > 8, a.match);
  for (const [f, why] of Object.entries(ALLOW_FILES)) { assert.ok(files[f], f); assert.match(why, /deferred/); }
});

test('each allowlisted file passes on its own', () => {
  const files = readSources(root);
  for (const f of new Set([...ALLOW.map((a) => a.file), ...Object.keys(ALLOW_FILES)]))
    assert.deepEqual(codaPathProblems({ [f]: files[f] }), [], f);
});

test('a direct write to a guarded table outside the allowlist fails', () => {
  const src = [
    'async function x(env, base, docId, auth, rowId) {',
    "  const r = await fetch(`${base}/docs/${docId}/tables/${env.CODA_SLOTS_TABLE}/rows/${encodeURIComponent(rowId)}`, { method: 'PUT', headers: auth, body: '{}' });",
    '}',
  ].join('\n');
  const p = codaPathProblems({ 'proxy/src/new-route.js': src });
  assert.equal(p.length, 1);
  assert.match(p[0], /^proxy\/src\/new-route\.js:2: a direct Coda write of env\.CODA_SLOTS_TABLE\. Go through codaWrite/);
});

test('a direct read (readAllRows or one row) of a guarded table fails; a multi-line write is a write', () => {
  const src = [
    'const a = await readAllRows(`${base}/docs/${docId}/tables/${tableId}/rows`, auth);',
    'const b = await fetch(`${rowsUrl}/${encodeURIComponent(id)}?useColumnNames=true`, { headers: auth });',
    'const c = await fetch(`${c.rowsUrl}/${id}`, {',
    "  method: 'DELETE', headers: auth,",
    '});',
  ].join('\n');
  const p = codaPathProblems({ 'proxy/src/new-route.js': src });
  assert.equal(p.length, 3);
  assert.match(p[0], /:1: a direct Coda read of tableId\. Go through overlayRead/);
  assert.match(p[1], /:2: a direct Coda read of rowsUrl/);
  assert.match(p[2], /:3: a direct Coda write of c\.rowsUrl\. Go through codaWrite/);
});

test('codaWrite, overlayRead, other tables, comments and non-Coda fetches pass', () => {
  const src = [
    "const w = await codaWrite(env, { url: rowsUrl, method: 'POST', body, tableId, op: 'insert', auth });",
    'const m = await overlayRead(env, tableId, rows, { shape: "name", snapshotAt, now });',
    "await fetch(`${base}/docs/${docId}/tables/${env.CODA_PUBLISH_LOG_TABLE}/rows`, { method: 'POST', headers: auth });",
    '// await fetch(`${base}/docs/${docId}/tables/${tableId}/rows`, { method: "PUT" });',
    'await fetch(`${base}/mutationStatus/${id}`, { headers: auth });',
    "await fetch(url, { method: 'PUT' });",
    'const o = env.OVERLAY.get(id); await o.fetch(`https://overlay/read`, { method: "POST" });',
  ].join('\n');
  assert.deepEqual(codaPathProblems({ 'proxy/src/new-route.js': src }), []);
});

test('an unclassified table is flagged, so a new table gets a decision', () => {
  const p = codaPathProblems({ 'proxy/src/x.js': 'await readAllRows(`${base}/docs/${docId}/tables/${mystery}/rows`, auth);' });
  assert.equal(p.length, 1);
  assert.match(p[0], /unclassified table \(mystery\)/);
});

test('an allowlist entry that matches nothing is a problem', () => {
  const allow = [{ file: 'proxy/src/x.js', match: 'fetch(slotsUrl', reason: 'PR B: gone' }];
  const p = codaPathProblems({ 'proxy/src/x.js': 'const a = 1;' }, { allow, allowFiles: {} });
  assert.deepEqual(p, ['scripts/check-coda-paths.mjs: ALLOW entry "PR B: gone" (proxy/src/x.js) matches nothing; remove it']);
});

test('the allowlisted sync runners pass even with direct writes; the same code elsewhere fails', () => {
  const src = "await fetch(`${c.rowsUrl}/${id}`, { method: 'PUT', headers: c.auth });";
  assert.deepEqual(codaPathProblems({ 'proxy/src/gcal-run.js': src }), []);
  assert.equal(codaPathProblems({ 'proxy/src/other.js': src }).length, 1);
});

test('tableOf and codaSites', () => {
  assert.equal(tableOf('`${base}/docs/${docId}/tables/${env.CODA_CLAIMS_TABLE}/rows`'), 'env.CODA_CLAIMS_TABLE');
  assert.equal(tableOf('`${venuesUrl}/${encodeURIComponent(v)}`'), 'venuesUrl');
  assert.equal(tableOf('btnUrl'), 'btnUrl');
  assert.equal(tableOf('url'), null);
  assert.equal(tableOf('u.toString()'), null);
  assert.equal(codaSites('export async function readAllRows(rowsUrl, auth) {}').length, 0);   // a definition, not a call
});
