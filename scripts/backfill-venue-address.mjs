#!/usr/bin/env node
// One-off backfill: split each EST Venues SRC row's free-text `Address` into the
// structured Street / Unit / City / State / ZIP columns.
//
//   node scripts/backfill-venue-address.mjs                # dry run (GET only), prints a markdown table
//   node scripts/backfill-venue-address.mjs --write --yes  # writes OK rows only (the five fields; never Address or EB ids)
//
// Token: CODA_API_TOKEN from proxy/.dev.vars (read here, never printed).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import '../web/venue-address.js';
import { parseUsAddress } from '../proxy/src/eventbrite.js';
import { VENUE_COLS as C } from '../proxy/src/coda-columns.js';

const DOC = 'DYAz_wCVfv', TABLE = 'grid-foC40iAOaX', BASE = 'https://coda.io/apis/v1';
const VA = globalThis.VenueAddress;
const str = v => (v == null ? '' : Array.isArray(v) ? str(v[0]) : String(v));
// Words that say "this isn't a street address".
const NON_ADDRESS = /\b(tbd|tba|online|virtual|various|zoom|n\/a|varies|multiple|anywhere)\b|https?:|www\.|\.(com|org|net)\b/i;

// Pure: one id-keyed row → { id, name, address, status: 'OK'|'FLAG'|'SKIP', reason, fields }.
export function planRow(row) {
  const v = (row && row.values) || {};
  const out = { id: row.id, name: str(v[C.name]) || row.name || '', address: str(v[C.address]).trim(), status: 'OK', reason: '', fields: null };
  if (str(v[C.street]).trim()) return { ...out, status: 'SKIP', reason: 'Street already filled' };
  const flag = reason => ({ ...out, status: 'FLAG', reason });
  if (!out.address) return flag('Address is blank');
  if (NON_ADDRESS.test(out.address)) return flag('Address looks like a non-address');
  const p = parseUsAddress(out.address, { city: 'Nashville', region: 'TN' });
  let street = p.address_1, unit = p.address_2 || '';
  // A trailing "Apt 222" / "Unit 4" / "#5" belongs in Unit, not Street (parseUsAddress is left alone: the Worker's publish path uses it).
  const um = !unit && /(?:^|[\s,])((?:apt|apartment|unit|suite|ste|#)\.?\s*[\w-]+)$/i.exec(street);
  if (um && um.index > 0) { unit = um[1]; street = street.slice(0, um.index).replace(/[\s,]+$/, ''); }
  const fields = VA.normalize({ street, unit, city: p.city, state: p.region, zip: p.postal_code || '' });
  const whole = out.address.replace(/\s+/g, ' ');
  if (fields.street.toLowerCase() === whole.toLowerCase()) return { ...flag('no city/state found in Address'), fields };
  const val = VA.validate(fields);
  if (!val.ok) return { ...flag('invalid: ' + Object.values(val.errors).join('; ')), fields };
  return { ...out, fields };
}

const cell = s => String(s == null ? '' : s).replace(/\|/g, '\\|').replace(/\s+/g, ' ');
export function renderTable(plans) {
  const lines = ['| row id | name | Address | Street | Unit | City | State | ZIP | result |', '|---|---|---|---|---|---|---|---|---|'];
  for (const p of plans) {
    const f = p.fields || {};
    const res = p.status === 'OK' ? 'OK' : p.status === 'SKIP' ? `SKIP (${p.reason})` : `FLAG (${p.reason})`;
    lines.push(`| ${[p.id, p.name, p.address, f.street, f.unit, f.city, f.state, f.zip, res].map(cell).join(' | ')} |`);
  }
  const n = s => plans.filter(p => p.status === s).length;
  lines.push('', `${n('OK')} OK, ${n('FLAG')} flagged, ${n('SKIP')} skipped`);
  return lines.join('\n');
}

export const cellsFor = f => [
  { column: C.street, value: f.street }, { column: C.unit, value: f.unit }, { column: C.city, value: f.city },
  { column: C.state, value: f.state }, { column: C.zip, value: f.zip },
];

function readToken() {
  const dir = path.dirname(fileURLToPath(import.meta.url));
  const text = fs.readFileSync(path.join(dir, '../proxy/.dev.vars'), 'utf8');
  const m = /^\s*CODA_API_TOKEN\s*=\s*["']?([^"'\r\n]+?)["']?\s*$/m.exec(text);
  if (!m) throw new Error('CODA_API_TOKEN not found in proxy/.dev.vars');
  return m[1];
}

// The PUT for one row: URL + body, the five structured columns only (by id).
export function buildWrite(id, fields) {
  return { url: `${BASE}/docs/${DOC}/tables/${TABLE}/rows/${encodeURIComponent(id)}`, body: { row: { cells: cellsFor(fields) } } };
}

async function codaFetch(token, url, init) {
  const r = await fetch(url, { ...init, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } });
  if (!r.ok) { const e = new Error(`Coda ${init && init.method || 'GET'} ${r.status}`); e.status = r.status; throw e; }
  return r.json();
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
// PUT one row; retries 429/5xx up to 3 times (1s, 3s, 9s). Failure names the row.
async function writeRow(token, p) {
  const w = buildWrite(p.id, p.fields);
  for (let attempt = 0; ; attempt++) {
    try { return await codaFetch(token, w.url, { method: 'PUT', body: JSON.stringify(w.body) }); }
    catch (e) {
      if (attempt < 3 && (e.status === 429 || e.status >= 500)) { await sleep(1000 * 3 ** attempt); continue; }
      throw new Error(`${e.message} writing ${p.id} ${p.name}`);
    }
  }
}

async function readRows(token) {
  const rows = [];
  let url = `${BASE}/docs/${DOC}/tables/${TABLE}/rows?useColumnNames=false&valueFormat=simpleWithArrays&limit=200`;
  while (url) {
    const j = await codaFetch(token, url);
    rows.push(...(j.items || []));
    url = j.nextPageToken ? `${BASE}/docs/${DOC}/tables/${TABLE}/rows?useColumnNames=false&valueFormat=simpleWithArrays&limit=200&pageToken=${encodeURIComponent(j.nextPageToken)}` : null;
  }
  return rows;
}

const USAGE = 'usage: backfill-venue-address.mjs [--write --yes] [--only <rowId>[,<rowId>...]]';

async function main() {
  const args = process.argv.slice(2);
  let write = false, yes = false, only = null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--write') write = true;
    else if (a === '--yes') yes = true;
    else if (a === '--only' && args[i + 1] && !args[i + 1].startsWith('--')) only = args[++i].split(',').map(x => x.trim()).filter(Boolean);
    else { console.error(USAGE); process.exit(2); }
  }
  if (write && !yes) { console.error('--write needs --yes'); process.exit(1); }
  const token = readToken();
  const plans = (await readRows(token)).map(planRow);
  console.log(renderTable(plans));
  if (!write) return;
  let ok = plans.filter(p => p.status === 'OK');
  if (only) {
    const bad = only.filter(id => !ok.some(p => p.id === id));
    if (bad.length) { console.error(`--only: not an OK row: ${bad.join(', ')}`); process.exit(1); }
    ok = ok.filter(p => only.includes(p.id));
  }
  const reqIds = [];
  for (const p of ok) {   // sequential, paced
    const res = await writeRow(token, p);
    reqIds.push(res.requestId);
    console.error(`wrote ${p.id} ${p.name} (requestId ${res.requestId})`);
    await sleep(250);
  }
  console.error(`requestIds: ${reqIds.join(' ')}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch(e => { console.error(e.message); process.exit(1); });
}
