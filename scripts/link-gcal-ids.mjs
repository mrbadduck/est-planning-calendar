#!/usr/bin/env node
// Before the Google Calendar cutover: copy the gCal event id the Zap/Coda already made onto
// each planning row, so the Worker updates that event instead of adding a second one.
//
//   node scripts/link-gcal-ids.mjs           # dry run (GET only): markdown table of links, unmatched, conflicts
//   node scripts/link-gcal-ids.mjs --apply   # writes only `gCal Event ID` on the linked rows; refuses while conflicts exist
//
// Rows considered: an Eventbrite Event ID, a blank gCal Event ID, a date of yesterday or later.
// Ids come from stored ids only: 1) EST Events SRC `gCal Event Id` by Eventbrite id,
// 2) the Events EVENTBRITE sync table's `gCal Event` lookup, resolved through Events GCAL.
// Token: CODA_API_TOKEN from proxy/.dev.vars (read here, never printed).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseDevVars } from './eb-webhook.mjs';
import { PLANNING_COLS as P, LEGACY_COLS as L, LEGACY_EVENTS_TABLE } from '../proxy/src/coda-columns.js';

const DOC = 'DYAz_wCVfv', PLANNING_TABLE = 'grid--gYIvdD-cE', BASE = 'https://coda.io/apis/v1';
const EB_SYNC_TABLE = 'grid-sync-20456-Event', GCAL_SYNC_TABLE = 'grid-sync-1003-Event';
const DAY_MS = 86400000;

const str = (v) => (v == null ? '' : Array.isArray(v) ? str(v[0]) : typeof v === 'object' ? String(v.name || v.url || '') : String(v)).trim();
const yesterday = (todayIso) => new Date(Date.parse(todayIso + 'T00:00:00Z') - DAY_MS).toISOString().slice(0, 10);

/**
 * Pure. planning: [{rowId,title,date,ebId,gcalEventId}]; legacy and ebSync: [{ebId,gcalEventId}].
 * Two different ids for one row (across or within the sources) are a conflict, not a link.
 */
export function planLinks({ planning, legacy, ebSync, todayIso }) {
  const index = (rows) => {
    const m = new Map();
    for (const r of rows || []) {
      if (!r.ebId || !r.gcalEventId) continue;
      if (!m.has(r.ebId)) m.set(r.ebId, []);
      m.get(r.ebId).push(r.gcalEventId);
    }
    return m;
  };
  const leg = index(legacy), syn = index(ebSync), from = yesterday(todayIso);
  const out = { links: [], unmatched: [], conflicts: [] };
  for (const r of planning || []) {
    if (!r.ebId || r.gcalEventId || !r.date || r.date < from) continue;
    const a = leg.get(r.ebId) || [], b = syn.get(r.ebId) || [];
    const ids = [...new Set([...a, ...b])];
    const base = { rowId: r.rowId, title: r.title, date: r.date };
    if (ids.length > 1) out.conflicts.push({ rowId: r.rowId, ids });
    else if (ids.length === 1) out.links.push({ ...base, gcalEventId: ids[0], from: a.length ? 'EST Events SRC' : 'Events EVENTBRITE' });
    else out.unmatched.push(base);
  }
  return out;
}

const cell = (s) => String(s == null ? '' : s).replace(/\|/g, '\\|').replace(/\s+/g, ' ');
export function renderPlan(plan) {
  const lines = ['### Links', '', '| row id | title | date | gCal event id | from |', '|---|---|---|---|---|'];
  for (const l of plan.links) lines.push(`| ${[l.rowId, l.title, l.date, l.gcalEventId, l.from].map(cell).join(' | ')} |`);
  lines.push('', '### Unmatched (link by hand, or let the Worker insert)', '', '| row id | title | date |', '|---|---|---|');
  for (const u of plan.unmatched) lines.push(`| ${[u.rowId, u.title, u.date].map(cell).join(' | ')} |`);
  lines.push('', '### Conflicts (two different ids; nothing is linked while any exist)', '', '| row id | ids |', '|---|---|');
  for (const c of plan.conflicts) lines.push(`| ${cell(c.rowId)} | ${c.ids.map(cell).join(', ')} |`);
  lines.push('', `${plan.links.length} to link, ${plan.unmatched.length} unmatched, ${plan.conflicts.length} conflict(s)`);
  return lines.join('\n');
}

// The PUT for one row (one write per row, not batched): only the gCal Event ID cell.
export function buildWrite(rowId, gcalEventId) {
  return { url: `${BASE}/docs/${DOC}/tables/${PLANNING_TABLE}/rows/${encodeURIComponent(rowId)}`, body: { row: { cells: [{ column: P.gcalEventId, value: gcalEventId }] } } };
}

function readToken() {
  const dir = path.dirname(fileURLToPath(import.meta.url));
  const t = parseDevVars(fs.readFileSync(path.join(dir, '../proxy/.dev.vars'), 'utf8')).CODA_API_TOKEN;
  if (!t) throw new Error('CODA_API_TOKEN not found in proxy/.dev.vars');
  return t;
}
async function codaFetch(token, url, init) {
  const r = await fetch(url, { ...init, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } });
  if (!r.ok) throw Object.assign(new Error(`Coda ${(init && init.method) || 'GET'} ${r.status}`), { status: r.status });
  return r.json();
}
async function pages(token, url) {
  const items = []; let next = url;
  while (next) { const j = await codaFetch(token, next); items.push(...(j.items || [])); next = j.nextPageToken ? `${url}&pageToken=${encodeURIComponent(j.nextPageToken)}` : null; }
  return items;
}
const rowsOf = (token, table) => pages(token, `${BASE}/docs/${DOC}/tables/${table}/rows?useColumnNames=false&valueFormat=simpleWithArrays&limit=200`);
const columnsOf = (token, table) => pages(token, `${BASE}/docs/${DOC}/tables/${table}/columns?limit=200`);
const findCol = (cols, re) => (cols.find((c) => re.test(c.name)) || {}).id;

// Rich cells (valueFormat=rich): text may be fenced in triple backticks; a reference is
// {rowId, name, ...} or an array of them. Never match on a name.
const plain = (v) => str(Array.isArray(v) ? v[0] : v).replace(/^```\s*/, '').replace(/\s*```$/, '').trim();
const refIds = (v) => (Array.isArray(v) ? v : v == null || v === '' ? [] : [v]).flatMap((x) => (x && typeof x === 'object' && x.rowId ? [String(x.rowId)] : []));

/**
 * Pure. ebRows, gcRows: id-keyed rich rows. cols = {ebId, lookup, gcId} column ids.
 * The lookup's referenced Events GCAL rows are found by row id. A lookup that references
 * several rows yields one entry per row, so planLinks sees two ids and reports a conflict.
 */
export function resolveSyncRows(ebRows, gcRows, cols) {
  const eventIdByRow = new Map((gcRows || []).map((r) => [r.id, plain(r.values[cols.gcId])]));
  const out = [];
  for (const r of ebRows || []) {
    const ebId = plain(r.values[cols.ebId]);
    for (const ref of refIds(r.values[cols.lookup])) out.push({ ebId, gcalEventId: eventIdByRow.get(ref) || '' });
  }
  return out;
}

// The sync tables' column ids are not recorded in the repo: find them by name at run time and print them.
// A missing column is a hard failure (decision 0007), never a silent skip.
async function readSyncTable(token, log) {
  const [ebCols, gcCols] = await Promise.all([columnsOf(token, EB_SYNC_TABLE), columnsOf(token, GCAL_SYNC_TABLE)]);
  const cols = { ebId: findCol(ebCols, /^(eventbrite )?(event )?id$/i), lookup: findCol(ebCols, /^gcal event$/i), gcId: findCol(gcCols, /^(gcal |google )?(event )?id$/i) };
  log(`Events EVENTBRITE: Eventbrite id = ${cols.ebId}, gCal Event = ${cols.lookup}; Events GCAL: event id = ${cols.gcId}`);
  const missing = Object.entries(cols).filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) throw new Error(`Could not find the sync-table column(s) ${missing.join(', ')} by name; refusing to continue (dry run or --apply).`);
  const rich = (t) => pages(token, `${BASE}/docs/${DOC}/tables/${t}/rows?useColumnNames=false&valueFormat=rich&limit=200`);
  const [ebRows, gcRows] = await Promise.all([rich(EB_SYNC_TABLE), rich(GCAL_SYNC_TABLE)]);
  return resolveSyncRows(ebRows, gcRows, cols);
}

async function main() {
  const apply = process.argv.includes('--apply');
  const token = readToken(), log = (m) => console.error(m);
  const planningRows = await rowsOf(token, PLANNING_TABLE);
  const legacyRows = await rowsOf(token, LEGACY_EVENTS_TABLE);
  const ebSync = await readSyncTable(token, log);
  log(`planning columns: Eventbrite Event ID ${P.eventbriteId}, gCal Event ID ${P.gcalEventId}, date ${P.date}; EST Events SRC: Eventbrite Id ${L.eventbriteId}, gCal Event Id ${L.gcalEventId}`);
  const plan = planLinks({
    planning: planningRows.map((r) => ({ rowId: r.id, title: str(r.values[P.title]) || r.name || '', date: str(r.values[P.date]).slice(0, 10), ebId: str(r.values[P.eventbriteId]), gcalEventId: str(r.values[P.gcalEventId]) })),
    legacy: legacyRows.map((r) => ({ ebId: str(r.values[L.eventbriteId]), gcalEventId: str(r.values[L.gcalEventId]) })),
    ebSync,
    todayIso: new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(new Date()),
  });
  console.log(renderPlan(plan));
  if (!apply) { console.log('\nDry run. Re-run with --apply to write the links.'); return; }
  if (plan.conflicts.length) { console.error('\nRefusing --apply while conflicts exist. Fix them in Coda and run again.'); process.exitCode = 1; return; }
  for (const l of plan.links) {
    const w = buildWrite(l.rowId, l.gcalEventId);
    await codaFetch(token, w.url, { method: 'PUT', body: JSON.stringify(w.body) });
    log(`linked ${l.rowId} ${l.title}`);
  }
  log(`wrote ${plan.links.length} link(s). Coda applies writes ~28 s later; re-run the dry run to confirm.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(e.message); process.exit(1); });
}
