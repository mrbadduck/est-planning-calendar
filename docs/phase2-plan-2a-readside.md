# Phase 2 · Plan 2a — read-side polish (schema retype + reference endpoints + refresh)

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Correct the live planning table to proper types + People-relation attribution, expose reference-read endpoints for the (future) editor pickers, and make the app refresh (button + tab-focus + ~60s poll) — all still **read-only**. Auth/permissions are Plan 2b.

**Architecture:** Builds on Plan 1. Schema edits are applied to the live table `EST Planning Events SRC` (`grid--gYIvdD-cE`) via the Superhuman Docs MCP; the Worker gains read-only reference routes; the app updates its read mapping (native time, Month-via-Date) and adds refresh. No writes, no auth.

**Verification model:** MCP `table_columns_read`/`table_rows_read` for schema; `node --check` on the extracted `<script>`; `curl` against the deployed Worker; browser render at plan.eastsidetribe.org. Same empirical loop as Plan 1.

**Branch:** `phase2a-readside`.

---

### Task 1: Retype the live table (Superhuman Docs MCP)

**Files:** none in repo — schema edits on `superhuman://docs/DYAz_wCVfv/tables/grid--gYIvdD-cE`. Additive/edit only; never touch other tables. Load `table_columns_manage`, `table_columns_delete`, `table_rows_manage`, `table_columns_read`, `table_rows_read` (+ `tool_guide`) via ToolSearch; read schemas before calling.

Column ids (from Plan 1): Start `c-MSm0b33TYA`, End `c-89OL6HGJWW`, Target month `c-pgHAlKz903`, Created by `c-ueS3RrH9ie`, Edited by `c-kcwcBPZYaH`, Approved by `c-FLp0tKwJg6`, Date `c-TOKaRG28oJ`. Month-scheduled seed row = `i-UwJjFNY1Eo` (Adult beginner Hebrew).

- [ ] **Step 1: Preserve the Month row's date before dropping Target month.** Set row `i-UwJjFNY1Eo` `Date` = `2026-11-01` (Month scheduling now lives in `Date` = the 1st).
- [ ] **Step 2: Drop the `Target month` column** (`c-pgHAlKz903`) via `table_columns_delete`.
- [ ] **Step 3: Retype `Start` and `End` to native time.** Set `c-MSm0b33TYA` / `c-89OL6HGJWW` to a native **time** format, then (re)write the seed values so they store as times: row `i-zdsc2Dfuvo` Start `18:30` End `20:00`; row `i-uW_lVyUKsO` Start `16:00` End `19:00`.
- [ ] **Step 4: Retype `Created by` / `Edited by` / `Approved by` to relations** → `EST People SRC` (`grid-X316Eql8dE`), single, left empty (populated in Plan 2b). Keep `Approved at` as-is (date).
- [ ] **Step 5: Verify.** `table_columns_read` (formats): `Start`/`End` are `time`; `Target month` is gone; the three `…by` columns are single lookups → `grid-X316Eql8dE`. `table_rows_read`: the Month row has `Date` = 2026-11-01; Start/End times are set. Report the final column list + a note if any retype needed delete+recreate.

---

### Task 2: Reference-read endpoints on the proxy

**Files:** Modify `proxy/src/worker.js`.

Add read-only routes so the Plan-2b editor can populate relation pickers, without exposing arbitrary tables. Map a fixed allowlist of names → table ids and reuse the existing paginated read.

- [ ] **Step 1: Add a reference-table map + routes.** In `worker.js`, add near the top of `fetch` handling (after the `rows` block), a `const REF = { programs:'grid-g87NFbtqN8', people:'grid-X316Eql8dE', venues:'grid-foC40iAOaX', 'venue-types':'grid-idEVRQX7SL' };` and handle `GET /ref/:name` (name in REF) by reading that table's rows with the same `useColumnNames=true&valueFormat=simpleWithArrays` pagination the `/rows` handler uses, returning `{ items }`. Non-GET or unknown name → 404. Writes remain gated by the existing `ALLOW_WRITES` check (these are GET-only anyway).
- [ ] **Step 2: `node --check`.** Copy `proxy/src/worker.js` to a `.mjs` and `node --check` it. Expected: no errors.
- [ ] **Step 3: Commit.** `git add proxy/src/worker.js && git commit -m "feat(proxy): read-only /ref/:name endpoints for editor pickers"`
- [ ] **Step 4: [USER] redeploy** `cd proxy && npm run deploy` (still read-only).
- [ ] **Step 5: Verify + capture the native time format.** curl `/ref/programs`, `/ref/venue-types` (expect `{items:[…]}`), and curl `/rows` to see how the **native `Start`/`End` time** now serializes under `simpleWithArrays` (e.g. `"18:30:00"` vs `"6:30 PM"` vs ISO). Record the exact shape — Task 3's parser depends on it.

---

### Task 3: App — mapping for native time + Month-via-Date, and the refresh mechanism

**Files:** Modify `web/index.html`.

- [ ] **Step 1: Update `planningRowToEvent`.** (a) `Start`/`End`: normalize the native-time serialization observed in Task 2 Step 5 to `HH:MM` via a small `toHM()` helper (handle `HH:MM[:SS]` and `h:MM AM/PM`). (b) Month: when `Scheduling === 'month'`, derive `targetMonth` from `Date` as `YYYY-MM` (`date.slice(0,7)`) and leave `date` empty so it renders as an undated month idea; keep `rangeStart/rangeEnd` for Range. (c) Attribution reads become relation arrays: `createdBy = _asList(v['Created by'])[0] || ''`, same for `editedBy`.
- [ ] **Step 2: Add refresh.** A `refresh()` that re-runs the load (re-fetch `listPlanning` + `listReferences`, re-render), wired to: a **Refresh button** in the header; `document.addEventListener('visibilitychange', …)` when the tab becomes visible; and `setInterval(refresh, 60000)` guarded to skip while hidden and to no-op if a fetch is already in flight. Show a subtle "updated" state or at least avoid flicker (re-render only on changed data if easy; otherwise a plain re-render is fine).
- [ ] **Step 3: `node --check`** the extracted script. Expected: `APP OK`.
- [ ] **Step 4: Commit.** `git add web/index.html && git commit -m "feat(app): native-time mapping, Month-via-Date, refresh (button/focus/60s)"`

---

### Task 4: Ship + verify

- [ ] **Step 1: Land on main** — `git checkout main && git merge --ff-only phase2a-readside && git push origin main`.
- [ ] **Step 2: Confirm Pages deploy** — `gh run list --workflow=deploy-pages.yml --limit 1` → `completed  success`.
- [ ] **Step 3: Browser-verify** at `https://plan.eastsidetribe.org`: the 4 rows still render correctly (Kabbalat Shabbat 9/18 with 6:30 PM time; Adult beginner Hebrew now a **November** idea via Date=1st; Sukkah range; Hanukkah 12/6). Click **Refresh** → no errors; make a small edit in Coda, wait/refresh → it appears. Check console: no errors.
- [ ] **Step 4: Update docs** — tick Plan 2a done in `docs/phase2-planning-table.md` rollout + `CLAUDE.md` status.

---

## Self-review

**Spec coverage:** schema retype (Start/End→time, drop Target month, attribution→People relations) → Task 1; reference-read endpoints → Task 2; native-time mapping + Month-via-Date + refresh (button/focus/60s) → Task 3; ship + verify → Task 4. Deferred to **Plan 2b** (correct): Google auth, email→person match, leadership-role gating, `ALLOW_WRITES`, editor UI, writes.

**Placeholder note:** the exact `Start`/`End` parse in Task 3 is intentionally finalized from the observed serialization in Task 2 Step 5 (empirical, not a cop-out — the format is unknown until the retyped column is served through the proxy). `toHM()` handles the two plausible shapes.

**Type consistency:** `planningRowToEvent` keeps its normalized output shape; `_asList` reused for attribution; `/ref/:name` returns the same `{items}` envelope as `/rows`.
