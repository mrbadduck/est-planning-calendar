# Real Reference Calendars Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the hardcoded `MOCK_REFS` reference overlays with real public Google/Hebcal calendars, fetched + parsed server-side by the proxy from a council-managed Coda config table, and rendered as toggleable reference layers.

**Architecture:** A new pure `proxy/src/ical.js` module parses raw `.ics` text into normalized events (unit-tested with `node --test`). A new read-only `GET /references` route in the Worker reads the `Reference Calendars SRC` Coda table, fetches each enabled feed server-side (browser fetch is CORS-blocked), parses it, and returns `{layers, events}` cached ~1h. The app makes `REF_LAYERS`/`REF`/`state.layers` dynamic, hydrates them from `/references`, and retires `MOCK_REFS`.

**Tech Stack:** Cloudflare Worker (ESM, `fetch`), vanilla buildless JS app, Node 22 built-in test runner. No new runtime dependencies (verified: Google `.ics` feeds have 0 `RRULE`, so a ~20-line VEVENT parser suffices — no `ical.js`).

**Source of truth for design:** `docs/superpowers/specs/2026-08-21-reference-calendars-handoff.md`. Config table = `Reference Calendars SRC` = `grid-vg-fRbtoyr` in doc `DYAz_wCVfv`, 10 rows hydrated, columns `Name` / `iCal URL` / `Color` / `Enabled` / `Default on`.

---

## File Structure

- **Create** `proxy/src/ical.js` — pure iCal parsing helpers (`unfoldLines`, `icalDateToYMD`, `unescapeText`, `parseVEvents`). No network, no Worker globals — trivially unit-testable.
- **Create** `proxy/test/ical.test.js` — `node --test` unit tests for the parser against real folded/all-day/timed/escaped fixtures.
- **Modify** `proxy/package.json` — add `"type": "module"` (so `node --test` imports the ESM parser) + a `test` script.
- **Modify** `proxy/src/worker.js` — import the parser; add the `GET /references` route + a `REFERENCES_CACHE` and a `buildReferences()` helper.
- **Modify** `web/app.js` — make `REF_LAYERS`/`REF` mutable; rebuild them from `/references` in `DB.listReferences()`; seed `state.layers` dynamically; retire `MOCK_REFS` (declaration + init cached-render path); guard `renderLayers()`/`eventsByDate()` for async-arriving layer ids.

---

## Task 1: Pure iCal parser module

**Files:**
- Create: `proxy/src/ical.js`
- Modify: `proxy/package.json`
- Test: `proxy/test/ical.test.js`

- [ ] **Step 1: Add `"type": "module"` + test script to `proxy/package.json`**

Change the file to:

```json
{
  "name": "est-planning-proxy",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "wrangler dev",
    "deploy": "wrangler deploy",
    "test": "node --test"
  },
  "devDependencies": {
    "wrangler": "^3"
  }
}
```

- [ ] **Step 2: Write the failing test**

Create `proxy/test/ical.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { unfoldLines, icalDateToYMD, unescapeText, parseVEvents } from '../src/ical.js';

test('unfoldLines rejoins RFC5545 continuation lines (space or tab)', () => {
  const raw = 'SUMMARY:Hello\r\n World\r\nDTSTART:20260101';
  assert.equal(unfoldLines(raw), 'SUMMARY:Hello World\nDTSTART:20260101');
});

test('icalDateToYMD handles all-day VALUE=DATE', () => {
  assert.deepEqual(icalDateToYMD('DTSTART;VALUE=DATE:20260907'), { date: '2026-09-07', allDay: true });
});

test('icalDateToYMD handles UTC timed DTSTART', () => {
  assert.deepEqual(icalDateToYMD('DTSTART:20260911T230000Z'), { date: '2026-09-11', allDay: true });
});

test('icalDateToYMD handles TZID timed DTSTART', () => {
  assert.deepEqual(icalDateToYMD('DTSTART;TZID=America/Chicago:20260911T180000'), { date: '2026-09-11', allDay: true });
});

test('unescapeText unescapes commas, semicolons, newlines, backslashes', () => {
  assert.equal(unescapeText('Erev\\, Rosh\\; Hashanah\\nfun\\\\'), 'Erev, Rosh; Hashanah fun\\');
});

test('parseVEvents extracts summary + date from folded, escaped VEVENTs', () => {
  const ics = [
    'BEGIN:VCALENDAR',
    'BEGIN:VEVENT',
    'DTSTART;VALUE=DATE:20260907',
    'SUMMARY:Labor',
    '  Day',
    'END:VEVENT',
    'BEGIN:VEVENT',
    'DTSTART:20260921T120000Z',
    'SUMMARY:Yom Kippur\\, 5787',
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');
  assert.deepEqual(parseVEvents(ics), [
    { title: 'Labor Day', date: '2026-09-07', allDay: true },
    { title: 'Yom Kippur, 5787', date: '2026-09-21', allDay: true },
  ]);
});

test('parseVEvents skips events missing SUMMARY or DTSTART', () => {
  const ics = 'BEGIN:VEVENT\r\nDTSTART;VALUE=DATE:20260101\r\nEND:VEVENT';
  assert.deepEqual(parseVEvents(ics), []);
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd proxy && node --test`
Expected: FAIL — cannot find module `../src/ical.js` (or unresolved exports).

- [ ] **Step 4: Write the parser**

Create `proxy/src/ical.js`:

```js
/**
 * Minimal RFC 5545 iCalendar parsing — pure, no network, no Worker globals.
 *
 * Scoped to exactly what the reference-calendar feature needs: SUMMARY + the
 * date of DTSTART, emitted all-day. Verified sufficient because Google's public
 * .ics feeds contain 0 RRULE (recurrences are pre-expanded into dated VEVENTs).
 * If a future feed uses RRULE, its recurring events will be missing — add
 * expansion (or ical.js) then.
 */

// RFC 5545 line folding: a CRLF followed by a single space or tab continues the
// previous line. Unfold first, normalize to \n, so each property is one line.
export function unfoldLines(raw) {
  return String(raw).replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n[ \t]/g, '');
}

// Unescape TEXT values per RFC 5545 (\\ \, \; \n \N). Newlines -> a space
// (ref events render as a single-line chip title).
export function unescapeText(s) {
  return String(s)
    .replace(/\\n/gi, ' ')
    .replace(/\\,/g, ',')
    .replace(/\\;/g, ';')
    .replace(/\\\\/g, '\\');
}

// A DTSTART property line -> { date:'YYYY-MM-DD', allDay:true } or null.
// Handles `DTSTART;VALUE=DATE:20260907`, `DTSTART:20260911T230000Z`, and
// `DTSTART;TZID=...:20260911T180000`. We keep only the date part (v1 renders
// ref events all-day), so time zones don't shift the day for our purposes.
export function icalDateToYMD(line) {
  const v = String(line).slice(String(line).indexOf(':') + 1).trim();
  const m = v.match(/^(\d{4})(\d{2})(\d{2})/);
  if (!m) return null;
  return { date: `${m[1]}-${m[2]}-${m[3]}`, allDay: true };
}

// Parse a whole .ics document into [{ title, date, allDay:true }], skipping any
// VEVENT missing SUMMARY or a parseable DTSTART.
export function parseVEvents(raw) {
  const lines = unfoldLines(raw).split('\n');
  const out = [];
  let cur = null;
  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') { cur = {}; continue; }
    if (line === 'END:VEVENT') {
      if (cur && cur.summary && cur.dt) {
        const d = icalDateToYMD(cur.dt);
        if (d) out.push({ title: unescapeText(cur.summary).trim(), date: d.date, allDay: true });
      }
      cur = null;
      continue;
    }
    if (!cur) continue;
    if (line.startsWith('SUMMARY')) cur.summary = line.slice(line.indexOf(':') + 1);
    else if (line.startsWith('DTSTART')) cur.dt = line;
  }
  return out;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd proxy && node --test`
Expected: PASS — all 7 tests (`# pass 7`, `# fail 0`).

- [ ] **Step 6: Commit**

```bash
git add proxy/src/ical.js proxy/test/ical.test.js proxy/package.json
git commit -m "feat(proxy): pure iCal VEVENT parser + unit tests"
```

---

## Task 2: Proxy `GET /references` route

**Files:**
- Modify: `proxy/src/worker.js` (import at top; cache const near line 27; route near the `/ref` block ~line 143; helper near `readAllRows` ~line 199)

- [ ] **Step 1: Import the parser at the top of `worker.js`**

Add immediately after the file's opening block comment (before `const REF_CACHE`):

```js
import { parseVEvents } from './ical.js';
```

- [ ] **Step 2: Add the references cache constant**

Below `const REF_CACHE = new Map();` (~line 27) add:

```js
let REFERENCES_CACHE = null;   // per-isolate { data:{layers,events}, exp } — one global key (config is one table)
const REFERENCES_TABLE = 'grid-vg-fRbtoyr';   // Reference Calendars SRC (council-managed)
```

- [ ] **Step 3: Add the `buildReferences` helper**

Add after `readAllRows` (~after line 215):

```js
// Coerce a Coda cell that may be a plain URL string or a { url } urlref object.
function cellUrl(v) {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return cellUrl(v[0]);
  if (typeof v === 'object' && v.url) return String(v.url);
  return '';
}

// Slug a calendar name into a stable, url-safe layer id.
function slugId(name) {
  return String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'ref';
}

// Read the config table, fetch + parse each enabled feed, return {layers, events}.
// One bad feed is skipped (logged) so it can't break the rest. Events are bounded
// to ~6 months back .. ~18 months ahead to keep payloads sane.
async function buildReferences(base, docId, auth) {
  const out = await readAllRows(`${base}/docs/${docId}/tables/${REFERENCES_TABLE}/rows`, auth);
  if (!out.ok) throw new Error('references config read failed');

  const now = new Date();
  const lo = new Date(now.getFullYear(), now.getMonth() - 6, 1).toISOString().slice(0, 10);
  const hi = new Date(now.getFullYear(), now.getMonth() + 18, 1).toISOString().slice(0, 10);

  const layers = [];
  const events = [];
  const seen = new Set();
  for (const row of out.items) {
    const v = row.values || {};
    if (v['Enabled'] !== true) continue;
    const name = row.name || v['Name'] || '';
    const url = cellUrl(v['iCal URL']);
    if (!name || !url) continue;
    let id = slugId(name);
    while (seen.has(id)) id = `${id}-x`;
    seen.add(id);
    layers.push({ id, name, color: v['Color'] || '#888', defaultOn: v['Default on'] === true });
    try {
      const r = await fetch(url);
      if (!r.ok) { console.log(`references: ${name} feed HTTP ${r.status}, skipped`); continue; }
      const parsed = parseVEvents(await r.text());
      for (const ev of parsed) {
        if (ev.date < lo || ev.date > hi) continue;
        events.push({
          id: `${id}-${ev.date}-${slugId(ev.title).slice(0, 8)}`,
          source: 'ref', refLayer: id, program: 'oth',
          title: ev.title, date: ev.date, allDay: true,
          readOnly: true, status: 'ref', leads: [],
        });
      }
    } catch (e) {
      console.log(`references: ${name} feed error ${(e && e.message) || e}, skipped`);
    }
  }
  return { layers, events };
}
```

- [ ] **Step 4: Add the route**

In the `fetch` handler, after the `if (parts[0] === 'ref' ...) { ... }` block closes (~line 143) and before `if (parts[0] === 'me' ...)`, insert:

```js
if (parts[0] === 'references' && request.method === 'GET') {
  // Public reference calendars: read the config table, fetch + parse each
  // enabled .ics server-side (browser fetch is CORS-blocked). No auth (public
  // data), GET only — same posture as /rows and /ref. Cached ~1h per isolate.
  if (REFERENCES_CACHE && REFERENCES_CACHE.exp > Date.now())
    return json(REFERENCES_CACHE.data, 200, cors);
  const data = await buildReferences(base, docId, auth);
  REFERENCES_CACHE = { data, exp: Date.now() + 3600_000 };
  return json(data, 200, cors);
}
```

- [ ] **Step 5: Syntax-check the Worker**

Run: `node --check proxy/src/worker.js`
Expected: no output (exit 0).

- [ ] **Step 6: Smoke-test locally against real Coda**

Reads are unauthenticated and hit real Coda through the token in `.dev.vars`. Start the Worker and curl the route:

```bash
cd proxy && npx wrangler dev --port 8787 &
sleep 6 && curl -s http://localhost:8787/references | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);console.log('layers',j.layers.length,'events',j.events.length);console.log(j.layers.map(l=>l.id+':'+l.defaultOn).join(' '));})"
```

Expected: `layers 10 events <many>`; exactly one layer with `:true` (Jewish Holidays). Kill the dev server afterward (`kill %1`).

- [ ] **Step 7: Commit**

```bash
git add proxy/src/worker.js
git commit -m "feat(proxy): GET /references — read config table, fetch+parse feeds, cache 1h"
```

---

## Task 3: App — dynamic reference layers, retire MOCK_REFS

**Files:**
- Modify: `web/app.js` (REF_LAYERS/REF ~24-30; MOCK_REFS ~247; listReferences ~335; state.layers ~359; renderLayers ~565; eventsByDate ~391; init cached-render ~1204)

- [ ] **Step 1: Make `REF_LAYERS`/`REF` mutable + add a rebuild helper**

Replace lines ~24-30 (the `const REF_LAYERS = [...]` block and `const REF = ...`) with:

```js
/* reference layers — muted context, read-only. Populated live from
   /references (Reference Calendars SRC in Coda); starts empty. */
let REF_LAYERS = [];
let REF = {};
function rebuildRefs(layers){
  REF_LAYERS = layers.map(l=>({ id:l.id, name:l.name, color:l.color, on:!!l.defaultOn }));
  REF = Object.fromEntries(REF_LAYERS.map(r=>[r.id,r]));
  for(const l of REF_LAYERS){ if(!(l.id in state.layers)) state.layers[l.id] = l.on; }
}
```

Note: `rebuildRefs` reads `state`, which is declared later in the file. That is
safe because `rebuildRefs` is only *called* at fetch time (well after load), not
at definition time — same pattern as other helpers that touch `state`.

- [ ] **Step 2: Delete `MOCK_REFS`**

Remove the entire `const MOCK_REFS = [ ... ];` block (~lines 247-265). Keep the
`refEv(...)` helper on line 246 — it documents the ref-event shape and is
harmless if unused, but the proxy now emits this shape server-side. (Deleting
`refEv` too is fine; if you do, confirm no other reference to it: `grep -n refEv web/app.js`.)

- [ ] **Step 3: Rewrite `DB.listReferences()`**

Replace line ~335 (`async listReferences(){ return MOCK_REFS.slice(); },`) with:

```js
  async listReferences(){
    try{
      const r = await fetch(`${this.base}/references`, { headers:{ 'Accept':'application/json' } });
      if(!r.ok) return [];
      const j = await r.json();
      rebuildRefs(j.layers || []);
      renderLayers();
      cacheSet('references', j);                       // instant repaint on next reload
      return j.events || [];
    }catch(_){ return []; }
  },
```

- [ ] **Step 4: Remove mock ref keys from `state.layers`**

Change line ~359 from:

```js
  layers: { planning:true, us:true, jew:true, part:false, shab:false },
```

to:

```js
  layers: { planning:true },   // ref-layer keys added dynamically from /references
```

- [ ] **Step 5: Guard `eventsByDate()` for async layer ids**

In `eventsByDate()` (~line 391) the ref branch is `if(!state.layers[e.refLayer]) continue;`.
A ref event whose layer key hasn't loaded yet would be `undefined` → falsy →
correctly hidden until layers load. No change needed, but confirm the else
branch reads (line ~391):

```js
    else { if(!state.layers[e.refLayer]) continue; }
```

This is already correct — undefined layer id hides the event. Leave as-is.

- [ ] **Step 6: Fix the init cached-render path**

Line ~1204 references `MOCK_REFS`. Replace:

```js
  if(cachedRows && cachedRows.length){ state.events = [...cachedRows.map(planningRowToEvent), ...MOCK_REFS]; applyView(); layoutSticky(); }
```

with (hydrate refs from cache too, so a warm reload paints reference layers instantly):

```js
  const cachedRefs = cacheGet('references');
  if(cachedRefs && cachedRefs.layers){ rebuildRefs(cachedRefs.layers); renderLayers(); }
  if(cachedRows && cachedRows.length){ state.events = [...cachedRows.map(planningRowToEvent), ...((cachedRefs&&cachedRefs.events)||[])]; applyView(); layoutSticky(); }
```

- [ ] **Step 7: Syntax-check the app**

Run: `node --check web/app.js`
Expected: no output (exit 0).

- [ ] **Step 8: Confirm no dangling `MOCK_REFS` references**

Run: `grep -n "MOCK_REFS" web/app.js`
Expected: no matches.

- [ ] **Step 9: Commit**

```bash
git add web/app.js
git commit -m "feat(app): dynamic reference layers from /references, retire MOCK_REFS"
```

---

## Task 4: End-to-end verification (browser)

**Files:** none (verification only)

- [ ] **Step 1: Confirm the proxy is deployed**

The app's `PROXY_BASE` points at the live Worker. Deploy the proxy so `/references`
is live: push the branch and let CI deploy, OR `cd proxy && npx wrangler deploy`.
Then:

```bash
curl -s https://est-planning-proxy.eastsidetribe.workers.dev/references | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);console.log('layers',j.layers.length,'events',j.events.length);})"
```

Expected: `layers 10 events <many>`.

- [ ] **Step 2: Serve the app locally and open it**

Run: `npx -y live-server web --port=8080 --no-browser` (a server may already be running).
Open `http://localhost:8080` via the Browser pane (`preview_start` with `{url}`).

- [ ] **Step 3: Verify layers render**

Use `read_page` / `read_console_messages`:
- 10 reference-layer toggles appear in the layers box, each with its hex color swatch.
- **Jewish Holidays** starts ON; the other 9 start OFF.
- No console errors.

- [ ] **Step 4: Verify events + toggling**

- Navigate to fall 2026 (Rosh Hashanah / Yom Kippur / Sukkot are in the Jewish
  Holidays feed and should appear on their real dates).
- Toggle another layer (e.g. East Side Tribe) ON → its events appear; toggle OFF → they disappear.
- Sparse feeds (Jewish Observer = 1 event) showing few/no events in-window is expected, not a bug.

- [ ] **Step 5: Screenshot proof**

`computer {action:"screenshot"}` showing the reference layers + events on the calendar. Share with the user.

- [ ] **Step 6: Final commit / PR**

If any verification-driven fixes were made, commit them. Then open a PR into `main`:

```bash
git push -u origin feat/reference-calendars
gh pr create --title "Real reference calendars" --body "Replaces MOCK_REFS with live public calendars fetched+parsed by the proxy from the council-managed Reference Calendars SRC table. See docs/superpowers/plans/2026-08-21-reference-calendars.md."
```

---

## Self-Review

**Spec coverage** (against the handoff §"TO BUILD"):
- Proxy `GET /references`: read config table ✓ (Task 2.3), enabled-only ✓, stable slug id ✓, skip bad feed ✓, minimal VEVENT parse ✓ (Task 1), normalized ref-event shape ✓ (matches `refEv()`), 6mo/18mo window ✓, `{layers,events}` ✓, ~1h cache ✓, no-auth GET ✓, `node --check` ✓.
- App: dynamic `REF_LAYERS`/`REF` ✓ (Task 3.1), `listReferences` fetch ✓ (3.3), `state.layers` dynamic seed ✓ (3.1 + 3.4), retire `MOCK_REFS` ✓ (3.2, 3.6, 3.8), hex colors work unchanged ✓ (existing interpolation), ref-editor view uses `REF[...]` ✓ (populated after load), `node --check` ✓.
- Verification: proxy curl ✓, app 10 toggles / Jewish default-on / dates / toggle behavior ✓.

**Placeholder scan:** No TBD/TODO; every code step shows full code; every command has expected output.

**Type consistency:** `rebuildRefs(layers)` consumes `{id,name,color,defaultOn}` (what the proxy emits in `layers`) and produces `REF_LAYERS` items `{id,name,color,on}` (what `renderLayers()` reads). `cacheSet('references', j)` stores `{layers,events}`; the init path reads `cachedRefs.layers`/`cachedRefs.events` — consistent. Proxy event shape matches the app's `source:'ref'` consumers (`eventsByDate`, `qchip ref`, editor). Consistent throughout.
