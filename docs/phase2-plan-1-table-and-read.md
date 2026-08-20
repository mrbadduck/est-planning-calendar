# Phase 2 · Plan 1 — Planning table + read-only go-live

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create the `EST Planning Events SRC` table in Mission Control, back the live app with it (read-only), and verify the calendar renders real planning rows at plan.eastsidetribe.org.

**Architecture:** Additive/parallel per [docs/phase2-planning-table.md](phase2-planning-table.md). A new Coda table originates planning events; the existing Cloudflare Worker (unchanged auth, still **read-only**, read-scoped token) is repointed from `EST Events SRC` to the new table; the app swaps its Phase-1 `eventsSrcRowToEvent` adapter for a planning-table mapping. No writes, no auth, no impact on `EST Events SRC` or its metrics. Editor + auth + writes are **Plan 2**.

**Tech stack:** Coda/Superhuman Docs MCP (table + rows), Cloudflare Worker (`proxy/`, wrangler), vanilla JS single-file app (`web/index.html`), GitHub Pages.

**Verification model (this project has no unit-test framework):** JS is checked with `node --check` on the extracted `<script>`; the data pipe is checked with `curl` against the deployed Worker (as in Phase 1); the render is checked in the browser at the live domain. Follow this, not pytest.

**Branch:** `phase2-planning-table` (already checked out; the design spec lives here).

---

### Task 1: Create the `EST Planning Events SRC` table (Coda MCP)

**Files:** none in repo — this creates a table in Mission Control doc `superhuman://docs/DYAz_wCVfv`. Additive and reversible (the table can be deleted). Uses the Coda MCP (owner-authenticated); load `table_create` + `table_columns_manage` + `table_columns_read` via ToolSearch first.

Create a table named **`EST Planning Events SRC`** with these columns (relation targets are existing tables — do not duplicate them):

| Column | Coda type | Target / options |
|---|---|---|
| Title | text | display column |
| Program(s) | relation (multiple) | `grid-g87NFbtqN8` (EST Programs SRC) |
| Leads | relation (multiple) | `grid-X316Eql8dE` (EST People SRC) |
| Venue Type | relation (single) | `grid-idEVRQX7SL` (Venue Types) |
| Venue | relation (single) | `grid-foC40iAOaX` (EST Venues SRC) |
| Venue (other) | text | — |
| Event Description | text | public promo copy |
| Planning Notes | text | internal notes |
| Scheduling | select | `Exact`, `Range`, `Month` |
| Date | date | — |
| Start | text | `HH:MM` |
| End | text | `HH:MM` |
| All day | checkbox | — |
| Window start | date | — |
| Window end | date | — |
| Target month | text | `YYYY-MM` |
| Status | select | `Idea`, `Draft`, `Confirmed`, `Approved` |
| Created by | text | (becomes real identity in Plan 2) |
| Edited by | text | — |
| Approved by | text | — |
| Approved at | date | — |
| Published? | checkbox | — |
| Eventbrite Event | relation (single) | `grid-sync-20456-Event` (Events EVENTBRITE) |
| gCal Event | relation (single) | `grid-sync-1003-Event` (Events GCAL) |
| Linked EST Events SRC row | relation (single) | `grid-9TAt5vMMKH` (EST Events SRC) |

- [ ] **Step 1: Create the table + columns** via `table_create` / `table_columns_manage` with the spec above.
- [ ] **Step 2: Verify** with `table_columns_read` on the new table URI. Expected: all 25 columns present; `Program(s)`/`Leads` are multi relations to the right target ids; `Status`/`Scheduling` are selects with the exact options above.
- [ ] **Step 3: Record the new table id** (the `grid-…` id) — it's needed in Task 3. Note it in the PR/handoff.

---

### Task 2: Seed sample planning rows (Coda MCP)

**Files:** none in repo — inserts rows into the new table. Load `table_rows_manage` + `name_match` (to resolve Program/People relation row ids) via ToolSearch.

Seed **4 rows** exercising each scheduling mode and a spread of statuses (resolve `Program(s)`/`Leads` to real row ids in `EST Programs SRC`/`EST People SRC` via `name_match`):

1. `Kabbalat Shabbat` — Program(s)=[Kabbalat Shabbat], Status=`Confirmed`, Scheduling=`Exact`, Date=2026-09-18, Start=18:30, End=20:00, Venue (other)="The Skillery".
2. `Sukkah build day` — Status=`Idea`, Scheduling=`Range`, Window start=2026-09-27, Window end=2026-10-01.
3. `Adult beginner Hebrew` — Status=`Idea`, Scheduling=`Month`, Target month=`2026-11`.
4. `Hanukkah party (crossover)` — Program(s)=[two programs, to exercise crossover], Status=`Draft`, Scheduling=`Exact`, Date=2026-12-06, Start=16:00, End=19:00.

- [ ] **Step 1: Insert the 4 rows** via `table_rows_manage`.
- [ ] **Step 2: Verify** with `table_rows_read` (useColumnNames). Expected: 4 rows; relations resolve to names; selects show the set statuses/scheduling.

---

### Task 3: Repoint the proxy to the new table + redeploy

**Files:**
- Modify: `proxy/wrangler.toml` (the `CODA_TABLE_ID` var)
- Modify: `proxy/.dev.vars.example` (keep the example in sync)

- [ ] **Step 1: Point the table id at the new table.** In `proxy/wrangler.toml`, change:

```toml
CODA_TABLE_ID  = "grid-9TAt5vMMKH"     # EST Events SRC (Phase-1 read target)
```
to (using the id from Task 1, Step 3):
```toml
CODA_TABLE_ID  = "<new EST Planning Events SRC grid id>"   # EST Planning Events SRC
```
Mirror the same value in `proxy/.dev.vars.example`.

- [ ] **Step 2: Commit.**

```bash
git add proxy/wrangler.toml proxy/.dev.vars.example
git commit -m "feat(proxy): point read at EST Planning Events SRC"
```

- [ ] **Step 3: [USER] Redeploy the Worker.** The proxy stays read-only (no token/auth change — the existing read-scoped token already covers the whole doc).

```bash
cd proxy && npm run deploy
```

- [ ] **Step 4: Verify the pipe** (curl bypasses CORS, as in Phase 1). Expected: `HTTP 200` and the 4 seed rows, with `Program(s)`/`Leads` as name arrays and `Status`/`Scheduling` populated.

```bash
curl -s --max-time 30 "https://est-planning-proxy.eastsidetribe.workers.dev/rows" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);console.log("items:",j.items.length);for(const it of j.items){console.log(" -",it.values["Title"],"|",it.values["Status"],"|",it.values["Scheduling"],"|",JSON.stringify(it.values["Program(s)"]))}})'
```

---

### Task 4: Swap the app's read adapter to the planning-table mapping

**Files:**
- Modify: `web/index.html` — replace `eventsSrcRowToEvent` with `planningRowToEvent`, and update `CodaSource.listPlanning`.

The app already normalizes to `{ id, program, title, leads, date, start, end, allDay, location, status, description, scheduling, rangeStart, rangeEnd, targetMonth, … }`. Reuse the existing `_nameOf` / `_asList` / `_splitDT` helpers.

- [ ] **Step 1: Replace `eventsSrcRowToEvent` with `planningRowToEvent`.** Delete the `eventsSrcRowToEvent` function and add:

```javascript
// EST Planning Events SRC row (Coda simpleWithArrays + useColumnNames) -> normalized event.
// Read-only in Plan 1; the editor (multi-program, venue cascade, notes) arrives in Plan 2.
function planningRowToEvent(r){
  const v = r.values || {};
  const progs = _asList(v['Program(s)']);          // array of program display names
  const venue = _asList(v['Venue'])[0] || '';
  return {
    id: r.id, source:'planning',
    program: progIdByName[progs[0]] || 'oth',        // primary program drives the color
    programs: progs.map(p => progIdByName[p] || 'oth'), // full list (crossover UI: Plan 2)
    title: v['Title'] || '',
    leads: _asList(v['Leads']),
    date: String(v['Date'] || '').slice(0,10),
    start: v['Start'] || '', end: v['End'] || '', allDay: !!v['All day'],
    location: venue || (v['Venue (other)'] || ''),
    status: String(v['Status'] || 'idea').toLowerCase(),
    description: v['Event Description'] || '',
    planningNotes: v['Planning Notes'] || '',
    createdBy: v['Created by'] || '', editedBy: v['Edited by'] || '',
    eventbriteUrl:'', gcalId:'', readOnly:true,       // writes come in Plan 2
    scheduling: String(v['Scheduling'] || 'Exact').toLowerCase(),
    rangeStart: String(v['Window start'] || '').slice(0,10),
    rangeEnd: String(v['Window end'] || '').slice(0,10),
    targetMonth: v['Target month'] || ''
  };
}
```

- [ ] **Step 2: Point `CodaSource.listPlanning` at the new mapping** and drop the Phase-1 cancelled/undated filters (undated `Idea`s are valid planning rows now). Change the body to:

```javascript
  async listPlanning(){
    const r = await fetch(`${this.base}/rows`, { headers:{ 'Accept':'application/json' } });
    if(!r.ok) throw new Error(`proxy ${r.status}: ${await r.text()}`);
    const j = await r.json();
    return (j.items || []).map(planningRowToEvent);
  },
```

- [ ] **Step 3: Syntax-check** the extracted script.

```bash
cd /Users/ericmirowitz/Documents/repos/est-planning-calendar
node -e 'const fs=require("fs");const h=fs.readFileSync("web/index.html","utf8");const m=[...h.matchAll(/<script>([\s\S]*?)<\/script>/g)];fs.writeFileSync("/tmp/app.js",m.map(x=>x[1]).join("\n;\n"));'
node --check /tmp/app.js && echo "APP OK"
```
Expected: `APP OK`.

- [ ] **Step 4: Commit.**

```bash
git add web/index.html
git commit -m "feat(app): read EST Planning Events SRC (planningRowToEvent)"
```

---

### Task 5: Ship + browser-verify at plan.eastsidetribe.org

**Files:** none — deploy + verification.

- [ ] **Step 1: Land on `main`** (Pages deploys from `main`).

```bash
git checkout main && git merge --ff-only phase2-planning-table && git push origin main
```

- [ ] **Step 2: Confirm the Pages deploy succeeded.**

```bash
gh run list --workflow=deploy-pages.yml --limit 1
```
Expected: latest run `completed  success`.

- [ ] **Step 3: Browser-verify the render.** Open `https://plan.eastsidetribe.org` (use the browser tools / a real browser — served over HTTPS so the Worker's CORS origin matches). Expected: the 4 seed rows appear — the Confirmed Kabbalat Shabbat on 2026-09-18, the two undated `Idea`s in the ideas gutter/footer (range + month), and the crossover Hanukkah draft colored by its primary program. Status chip treatments differ (idea dashed → draft tint → confirmed solid). Editing still shows the Plan-1 read-only notice.

- [ ] **Step 4: Update project docs.** In `CLAUDE.md`, mark the "where planning rows live" open decision resolved (new table `EST Planning Events SRC`) and update the current status to note Plan 1 shipped. Commit on a branch and push.

---

## Self-review

**Spec coverage (Plan 1 slice):** table schema → Task 1 ✅; seed/parallel-run start → Task 2 ✅; proxy repoint → Task 3 ✅; app read mapping incl. multi-program primary color + venue cascade display (Venue → Venue (other)) + split Event Description → Task 4 ✅; read-only go-live + verify → Task 5 ✅. Deferred to **Plan 2** (correctly out of this slice): editor UI (multi-select, venue cascade input, planning-notes template), reference-read proxy endpoints (`/programs` etc.), Google auth + JWT allowlist, `ALLOW_WRITES`/read+write token, crossover color indicator, publish-out, endpoint decision.

**Placeholder scan:** the only `<…>` is the new table id (genuinely unknown until Task 1 runs; Task 1 Step 3 captures it and Task 3 consumes it). No TODO/TBD.

**Type consistency:** `planningRowToEvent` returns the same normalized shape the renderer already consumes; `_nameOf`/`_asList` reused from the existing file; `CodaSource.listPlanning` signature unchanged. Column names match Task 1's table exactly (`Program(s)`, `Event Description`, `Venue (other)`, `Window start/end`, `Target month`).
