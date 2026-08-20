# Phase 2 · Plan 2b-ii-a — real programs + colors + multi-program picker

> Executes as part of Plan 2b-ii. App-only (no Worker change). Steps use `- [ ]`.

**Goal:** Replace the 8 hardcoded programs with the real 15 from `/ref/programs`, give each a generated color (fixes the "everything one hue" issue), and let leaders pick **multiple** programs in the editor — persisted as the `Program(s)` relation, with crossover indication.

**Design decisions:**
- Load `/ref/programs` on startup (unauthenticated read). Each row → `{id: row.id, name: row.name}`. Append a synthetic `{id:'oth', name:'Other', color:#888}` fallback so `PROG['oth']` always exists.
- Colors: evenly-spaced HSL by index — `hsl(round(i*360/N), 50%, 55%)` — stable in `/ref` order.
- `PROGRAMS` / `PROG` / `progIdByName` become reassignable (`let`) and are rebuilt by `loadPrograms()`, which runs **before** `loadEvents()` so `planningRowToEvent` maps names→ids correctly.
- Editor: `Program(s)` becomes a multi-select chip picker (reusing `.leadchip` styling), pre-selected from `event.programs`, enabled when `canWrite`.
- Write: `eventToCodaCells` adds `{column:'Program(s)', value: <array of program row ids>}` (empty array if none). Primary program (`programs[0]`) drives the color.
- Crossover: color by primary program; chips get a `title` listing all programs + a `+` marker when >1.

**Verify:** `node --check`; browser at plan.eastsidetribe.org (distinct program colors; multi-select in editor; sign in and change an event's programs → persists as a relation, confirmed via MCP).

**Branch:** `phase2b-ii-a-programs`.

---

### Task 1: Load real programs + colors
- [ ] Make `PROGRAMS`/`PROG`/`progIdByName` `let`. Add `genColor(i,n)` + `rebuildPrograms(list)` (rebuild PROG/progIdByName, always include the `oth` fallback).
- [ ] Add `async function loadPrograms()` → `GET ${PROXY_BASE}/ref/programs`; on success rebuild from `{id,name}`; on failure keep current (catch, no throw).
- [ ] In `init()`, `await loadPrograms()` **before** `await loadEvents()`. (Don't reload on every `refresh()`.)
- [ ] `node --check`, commit.

### Task 2: Multi-program editor picker + write
- [ ] Replace the single disabled `#f_prog` `<select>` with a `#f_progs` chip multi-select over `PROGRAMS` (exclude `oth`), pre-pressed from `ev.programs`, gated by `dis`; wire chip toggles like leads.
- [ ] `readForm`: collect pressed `#f_progs` ids → `programs`; set `program = programs[0] || 'oth'`.
- [ ] `eventToCodaCells`: add `{column:'Program(s)', value: (e.programs||[]).filter(id=>id&&id!=='oth')}`.
- [ ] Remove the Plan-2b-i "Program & leads: set in Coda" note's program part (leads still deferred to 2b-ii-b).
- [ ] `node --check`, commit.

### Task 3: Crossover coloring
- [ ] Where planning chips render, add `title` = all program names and a trailing `+` (or small marker) when `event.programs.length > 1`. Color still by `program` (primary).
- [ ] `node --check`, commit.

### Task 4: Ship + verify
- [ ] Merge to `main`, confirm Pages deploy, browser-verify (colors distinct; sign in → edit programs → persists). Verify one write via MCP (`Program(s)` relation set). Tick 2b-ii-a in the docs.

---

## Self-review
Covers: real programs + generated colors (Task 1), multi-program picker + relation write (Task 2), crossover indication (Task 3), ship/verify (Task 4). Deferred to **2b-ii-b**: leads typeahead, venue-type→venue cascade, Planning Notes template, lightweight `/ref` projection. No placeholders — the one runtime detail (`/ref/programs` row shape) is already confirmed: `row.id` + `row.name`.
