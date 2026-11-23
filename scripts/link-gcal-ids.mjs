#!/usr/bin/env node
// Before the Google Calendar cutover: copy the gCal event id the Zap/Coda already made onto
// each planning row, so the Worker updates that event instead of adding a second one.
//
//   node scripts/link-gcal-ids.mjs           # dry run (GET only): markdown table of links, unmatched, conflicts
//   node scripts/link-gcal-ids.mjs --apply   # writes only `gCal Event ID` on the linked rows; refuses while conflicts exist
//
// Rows considered: a blank gCal Event ID, a date of yesterday or later, and an Eventbrite
// Event ID or a filled `gCal Event` lookup. Ids come from stored ids only:
// 1) EST Events SRC `gCal Event Id` by Eventbrite id, 2) the Events EVENTBRITE sync table's
// `gCal Event` lookup, 3) the planning row's own `gCal Event` lookup; 2 and 3 resolve through
// Events GCAL by referenced row id, East Side Tribe Events calendar only.
// The dry run also lists upcoming EST Events SRC events with a gCal id and no planning row:
// frozen on the calendar until Phase C's backfill brings them into plan.
// Token: CODA_API_TOKEN from proxy/.dev.vars (read here, never printed).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseDevVars } from './eb-webhook.mjs';
import { PLANNING_COLS as P, LEGACY_COLS as L, LEGACY_EVENTS_TABLE } from '../proxy/src/coda-columns.js';

const DOC = 'DYAz_wCVfv', PLANNING_TABLE = 'grid--gYIvdD-cE', BASE = 'https://coda.io/apis/v1';
const EB_SYNC_TABLE = 'grid-sync-20456-Event', GCAL_SYNC_TABLE = 'grid-sync-1003-Event';
const EST_CALENDAR = 'East Side Tribe Events';
const DAY_MS = 86400000;

const str = (v) => (v == null ? '' : Array.isArray(v) ? str(v[0]) : typeof v === 'object' ? String(v.name || v.url || '') : String(v)).trim();
const yesterday = (todayIso) => new Date(Date.parse(todayIso + 'T00:00:00Z') - DAY_MS).toISOString().slice(0, 10);

/**
 * Pure. planning: [{rowId,title,date,ebId,gcalEventId, ownIds?, legacyRefs?}] (ownIds: the
 * row's own gCal Event lookup, resolved; legacyRefs: its linked EST Events SRC row ids);
 * legacy: [{rowId?,name?,date?,ebId,gcalEventId}]; ebSync: [{ebId,gcalEventId}].
 * Two different ids for one row (across or within the sources) are a conflict, not a link.
 * frozen: upcoming legacy rows with a gCal id that no planning row covers (by legacy row
 * link, Eventbrite id or gCal id).
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
  const out = { links: [], unmatched: [], conflicts: [], frozen: [] };
  const known = new Set(), refd = new Set(), ebIds = new Set();
  for (const r of planning || []) {
    for (const x of r.legacyRefs || []) refd.add(x);
    if (r.ebId) ebIds.add(r.ebId);
    for (const x of [r.gcalEventId, ...(r.ownIds || [])]) if (x) known.add(x);
    const own = r.ownIds || [];
    if ((!r.ebId && !own.length) || r.gcalEventId || !r.date || r.date < from) continue;
    const a = (r.ebId && leg.get(r.ebId)) || [], b = (r.ebId && syn.get(r.ebId)) || [];
    const ids = [...new Set([...a, ...b, ...own])];
    const base = { rowId: r.rowId, title: r.title, date: r.date };
    if (ids.length > 1) out.conflicts.push({ rowId: r.rowId, ids });
    else if (ids.length === 1) { known.add(ids[0]); out.links.push({ ...base, gcalEventId: ids[0], from: a.length ? 'EST Events SRC' : b.length ? 'Events EVENTBRITE' : 'gCal Event lookup' }); }
    else out.unmatched.push(base);
  }
  for (const l of legacy || []) {
    if (!l.gcalEventId || !l.date || l.date < from) continue;
    if ((l.rowId && refd.has(l.rowId)) || (l.ebId && ebIds.has(l.ebId)) || known.has(l.gcalEventId)) continue;
    out.frozen.push({ rowId: l.rowId, name: l.name, date: l.date, gcalEventId: l.gcalEventId });
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
  lines.push('', '### Frozen until Phase C (upcoming EST Events SRC events with a gCal id and no planning row: leave them as they are, nothing is written)', '',
    '| EST Events SRC row | name | date | gCal event id |', '|---|---|---|---|');
  for (const f of plan.frozen || []) lines.push(`| ${[f.rowId, f.name, f.date, f.gcalEventId].map(cell).join(' | ')} |`);
  lines.push('', `${plan.links.length} to link, ${plan.unmatched.length} unmatched, ${plan.conflicts.length} conflict(s), ${(plan.frozen || []).length} frozen`);
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

/** Pure. Events GCAL rich rows -> Map(row id -> event id), East Side Tribe Events calendar only. cols = {gcId, calendar}. */
export function calendarIds(gcRows, cols) {
  return new Map((gcRows || []).filter((r) => plain(r.values[cols.calendar]) === EST_CALENDAR).map((r) => [r.id, plain(r.values[cols.gcId])]));
}
/** Pure. A rich lookup cell -> the event ids of the Events GCAL rows it references (by row id) that are in `ids`. */
export function lookupIds(v, ids) {
  return [...new Set(refIds(v).map((x) => ids.get(x)).filter(Boolean))];
}

/**
 * Pure. ebRows, gcRows: id-keyed rich rows. cols = {ebId, lookup, gcId, calendar} column ids.
 * The lookup's referenced Events GCAL rows are found by row id. A lookup that references
 * several rows yields one entry per row, so planLinks sees two ids and reports a conflict.
 */
export function resolveSyncRows(ebRows, gcRows, cols) {
  const eventIdByRow = calendarIds(gcRows, cols);
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
  const cols = { ebId: findCol(ebCols, /^(eventbrite )?(event )?id$/i), lookup: findCol(ebCols, /^gcal event$/i), gcId: findCol(gcCols, /^(gcal |google )?(event )?id$/i), calendar: findCol(gcCols, /^calendar$/i) };
  log(`Events EVENTBRITE: Eventbrite id = ${cols.ebId}, gCal Event = ${cols.lookup}; Events GCAL: event id = ${cols.gcId}, calendar = ${cols.calendar}`);
  const missing = Object.entries(cols).filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) throw new Error(`Could not find the sync-table column(s) ${missing.join(', ')} by name; refusing to continue (dry run or --apply).`);
  const rich = (t) => pages(token, `${BASE}/docs/${DOC}/tables/${t}/rows?useColumnNames=false&valueFormat=rich&limit=200`);
  const [ebRows, gcRows, planRich] = await Promise.all([rich(EB_SYNC_TABLE), rich(GCAL_SYNC_TABLE), rich(PLANNING_TABLE)]);
  const ids = calendarIds(gcRows, cols);
  log(`Events GCAL: ${ids.size} of ${gcRows.length} rows on "${EST_CALENDAR}"`);
  // The planning row's own gCal Event lookup and its linked EST Events SRC row, by row id.
  const own = new Map(planRich.map((r) => [r.id, { ownIds: lookupIds(r.values[P.gcalEventLookup], ids), legacyRefs: refIds(r.values[P.legacyRow]) }]));
  return { ebSync: resolveSyncRows(ebRows, gcRows, cols), own };
}

async function main() {
  const apply = process.argv.includes('--apply');
  const token = readToken(), log = (m) => console.error(m);
  const planningRows = await rowsOf(token, PLANNING_TABLE);
  const legacyRows = await rowsOf(token, LEGACY_EVENTS_TABLE);
  const { ebSync, own } = await readSyncTable(token, log);
  log(`planning columns: Eventbrite Event ID ${P.eventbriteId}, gCal Event ID ${P.gcalEventId}, gCal Event ${P.gcalEventLookup}, date ${P.date}; EST Events SRC: Eventbrite Id ${L.eventbriteId}, gCal Event Id ${L.gcalEventId}`);
  const plan = planLinks({
    planning: planningRows.map((r) => ({ rowId: r.id, title: str(r.values[P.title]) || r.name || '', date: str(r.values[P.date]).slice(0, 10), ebId: str(r.values[P.eventbriteId]), gcalEventId: str(r.values[P.gcalEventId]), ...(own.get(r.id) || {}) })),
    legacy: legacyRows.map((r) => ({ rowId: r.id, name: str(r.values[L.name]) || r.name || '', date: str(r.values[L.date]).slice(0, 10), ebId: str(r.values[L.eventbriteId]), gcalEventId: str(r.values[L.gcalEventId]) })),
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
