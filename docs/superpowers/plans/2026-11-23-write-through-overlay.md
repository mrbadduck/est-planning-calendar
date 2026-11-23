# Write-through overlay — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every read through the Worker sees the Worker's own writes at once, so a lead's edit
is saved in about a second and gather shows a new claim on reload. Coda stays the source of
truth. New events still take about half a minute, and the app says so straight away.

**Architecture:** A SQLite-backed, fetch-style Durable Object (`WriteOverlay`) remembers each
Worker write to the planning, slots, claims and venues tables, stored as written, until Coda
applies it and for a short, age-aware window after. One helper writes (`codaWrite`), one helper
merges the overlay into reads (`overlayRead`, a pure `mergeRows` underneath). The DO's alarm
polls Coda's `mutationStatus`, and `/mutation/:id` asks the DO first, so the app keeps its one
confirm channel. The app treats `overlaid: true` as saved and confirms in the background. The
whole thing sits behind `OVERLAY_MODE` (default `off`).

**Tech Stack:** Cloudflare Workers, Durable Objects (fetch-style class, transactional storage,
alarms), KV, Coda API v1, vanilla JS app, `node --test`.

**Spec:** `docs/superpowers/specs/2026-11-23-write-through-overlay-design.md`
**Review:** `docs/superpowers/plans/2026-11-23-write-through-overlay.wise/ruling.md` (wise-up
ruling; it overrides anything here it contradicts).

**PRs:** two, stacked on #41 (which stacks on #40).
- **PR A** (branch `feat/overlay-save`, Tasks 1–6): the DO, the merge, the helpers, DO-first
  `/mutation`, the planning routes and their row reads, the app save path, transitions, the
  create hint, help and docs. `OVERLAY_MODE` ships `off`; Eric flips it to `live` after merge.
- **PR B** (branch `feat/overlay-gather`, stacked on PR A, Task 7): gather's raw-row
  snapshot, claims and slots, the `/claims/:id` 409, removing the double bust, venues, and their
  help and docs.

## Global Constraints

- **Coda stays the source of truth (0001, D1).** An applied entry is merged only into snapshots
  taken before `appliedAt + APPLY_MARGIN_MS` (`APPLY_MARGIN_MS = 30_000`). An unapplied entry is
  merged for at most `FAIL_AFTER_MS = 120_000` after it was written. The DO deletes everything
  by `KEEP_MS = 300_000 + APPLY_MARGIN_MS` (5.5 min: `swrGet`'s 5 min hard limit plus the
  margin). Nothing in the overlay outlives ~5.5 min.
- **"Saved" (D2).** Coda accepted the write **and** the overlay holds it (`overlaid: true`).
  When the overlay is off or unreachable, "Saved" means Coda applied it, as today
  (`waitApplied`). New events always wait for the insert to apply, show
  **Creating… (about half a minute)** at once, and stay editable (edits queue behind
  `afterCreate`, as today).
- **One failure channel (D3).** `/mutation/:id` asks the DO first (`pending | applied | failed`,
  no Coda call), then falls through to Coda on a miss. At 120 s an unapplied entry is `failed`:
  the DO stops merging it, `/mutation` reports it, and the app shows **Save failed — retry** or
  the existing toasts. No `/me/writes`, no poller, no unconfirmed/lost states, no new failure
  copy, no `overlay-lost` Publish Log action.
- **Entries are stored as written (D4).** Each entry keeps the column key the write used plus
  `keying: 'name' | 'id'` (per cell: `/^c-/` is an id, anything else a name). The merge
  translates only when the reader's keying differs. The `{id ↔ name}` map exists **for the
  planning table only**: KV-cached, refreshed from one `/columns?limit=200` call at most
  hourly, and counted in that route's call budget. Slots, claims and venues are id-keyed on both
  sides and need no map.
- **Gather caches raw rows (D5).** The gather KV value is `{events, slots, claims}` raw rich
  rows under a new key (`gather-snap-v2`). The merge runs before `gatherSnapshot`.
- **The merge is age-aware (D6).** `overlayRead` takes the snapshot's `at`; fresh Coda reads
  pass `now`. There is no fixed grace and no apply-time bust. The double bust
  (`bustEventCachesNowAndAfterApply`) is removed in PR B, not PR A.
- **Fetch-style DO behind a kill switch (D7).** `WriteOverlay` has `fetch()` with JSON paths
  `/record`, `/read`, `/status`, plus `alarm()`. It imports nothing from `cloudflare:workers`,
  so node tests that import `worker.js` keep working. `OVERLAY_MODE = "off"` is the default in
  `wrangler.toml`. With `off`, `codaWrite` returns `overlaid: false` and makes no DO call,
  `overlayRead` returns rows unchanged, and `/mutation` goes straight to Coda.
- **Sync runners are untouched (D8).** `eb-sync-run.js` and `gcal-run.js` keep writing and
  reading Coda directly. `SWEEP_MAX_EVENTS` stays 8. The `ebpending:`, `eb-row:importing` and
  calendar-tombstone markers stay. The `check.sh` rule allowlists both runners.
- **Venues and claims (D9).** Add venue keeps its wait (a new venue has to be created before an
  event can use it). Save address is instant. Editing or removing a claim whose insert is still
  pending answers 409 `Your sign-up is still being saved. Try again in a few seconds.`
- **Copy (D10, P3). These are the only new or changed on-screen strings:**
  - panel primary while creating: `Creating… (about half a minute)`
  - toast on Create: `Creating… this takes about half a minute`
  - toast `Created`: moves to when `trackCreate`'s apply resolves (not on the 202)
  - `SLOW_TIP = 'This is taking longer than usual; your change is safe'`
  - save.js:81 toast: `The change didn't confirm. Check again in a minute.` (no "Coda")
  - No other new strings. No "Mission Control" on screen. In help, new on-screen text goes inside
    `[[ ]]` (e.g. `[[Creating… (about half a minute)]]`) so the help guard protects it; bold
    isn't checked (guide.md:13-14).
  - Existing strings reused as they are: **Saving…**, **Still saving…**,
    **Save failed — retry**, the save.js:128 toast, and
    `Your last update is still being saved. Try again in a few seconds.` (web/eventbrite.js:174).
- **`/mutation` keeps its `canWrite` gate (D11).** gather doesn't poll it (it uses
  `rememberOp`, gather/app.js:317). Entries carry no `actorId`.
- **Two PRs (D12).** Help and docs ship in each, per the checklist items placed in Task 6
  (PR A) and Task 7 (PR B).
- **Free plan; ≤ 50 outbound calls per invocation.** Count each DO call as one call until the
  deferred check settles it. App-facing routes add one DO call per write and one per read,
  plus the hourly `/columns` call where a planning read needs translation. The DO alarm is its
  own invocation and polls at most 10 requestIds per run.
- **Every Worker write to planning/slots/claims/venues goes through `codaWrite`; every read of
  them through `overlayRead`.** `scripts/check.sh` enforces it (Task 6), with the sync runners
  allowlisted until the follow-up.
- **Tests run under the lock,** touched specs only:
  `cd proxy && until mkdir /tmp/jest.lock 2>/dev/null; do sleep 5; done; trap 'rmdir /tmp/jest.lock' EXIT; node --test test/<f>.test.js`.
  `./scripts/check.sh` must pass before every commit. No full proxy suite from a subagent;
  CI runs it on the PR.
- **Help ships with lead-visible changes, in the same branch.** Task 5 and Task 7 touch
  `web/*.js`; the help lands in Task 6 (PR A) and Task 7 (PR B), and
  `node scripts/check-help.mjs --branch HEAD` passes before each PR opens.
- **No deploys, no prod writes from a session.** Wrangler deploy is denied in-session; note
  `wrangler deploy --dry-run` for Eric in each PR. The one Coda call a builder makes (Task 2's
  Leads dry check) is a read.
- **`web/*.js` stays ≤ 800 lines; `worker.js` grows by no more than ~30 lines per PR** (put
  logic in `worker-io.js`, `overlay.js` or a new `overlay-routes.js`).
- **Commits end with the two attribution lines.**

## Review Focus

1. **Two quick edits to the same cell, a second apart.** Every read returns the second value
   until Coda applies both, then Coda's value. Test in Task 2: newest `writtenAt` wins.
2. **The overlay is off or unreachable on a save.** The response says `overlaid: false`, the app
   waits as today, and nothing shows Saved early. Tests in Task 3 (Worker) and Task 5 (app).
3. **A new event.** **Creating… (about half a minute)** shows at once in the panel primary and
   `#epPhoneBar`, the toast says `Creating… this takes about half a minute`, and `Created`
   shows only when the insert applies. The event stays editable; edits queue behind
   `afterCreate`, as today. Test in Task 5.
4. **Coda applies, then someone edits the same cell in Coda.** A snapshot taken more than 30 s
   after `appliedAt` doesn't get the entry merged, so the Coda edit shows. A snapshot taken
   before `appliedAt` and served 4 min later still shows the write. Tests in Task 2.
5. **An overlaid write Coda never confirms.** At 120 s the DO stops merging it, `/mutation`
   returns `failed`, and the app shows **Save failed — retry** or the save.js:81/:128 toast.
   Nothing else. Tests in Task 1 (DO state), Task 4 (`/mutation`) and Task 5 (app).
6. **A claim edited or removed right after it was made** (PR B). The ownership read sees the
   pending insert and answers 409 with the existing "still being saved" wording, not 404.
   Test in Task 7.

---

## PR A — A lead's save is instant (branch `feat/overlay-save`, stacked on #41)

### Task 1: The Durable Object (fetch-style, behind `OVERLAY_MODE`)

**Files:**
- Create: `proxy/src/overlay-do.js`
- Modify: `proxy/wrangler.toml`: `[[durable_objects.bindings]] name = "OVERLAY"
  class_name = "WriteOverlay"`, `[[migrations]] tag = "v1" new_sqlite_classes = ["WriteOverlay"]`,
  and `OVERLAY_MODE = "off"` under `[vars]` beside `EB_SYNC_MODE`/`GCAL_MODE`, with a one-line
  comment (`off | live`)
- Modify: `proxy/src/worker.js`: `export { WriteOverlay } from './overlay-do.js';`
- Test: `proxy/test/overlay-do.test.js`, with a fake storage (Map-backed `get`, `put`, `delete`,
  `list({prefix})`, `setAlarm`, `getAlarm`, `deleteAlarm`), a stubbed `fetch` and an injected
  clock

**Interfaces:**
- Produces, exported from `overlay-do.js`:
  - Constants: `APPLY_MARGIN_MS = 30_000`, `FAIL_AFTER_MS = 120_000`, `SWR_HARD_MS = 300_000`,
    `KEEP_MS = SWR_HARD_MS + APPLY_MARGIN_MS`, `ALARM_EVERY_MS = 5_000`, `POLLS_PER_ALARM = 10`.
  - `Entry = {tableId, rowId, key, keying:'name'|'id', value, op:'set'|'insert'|'delete', requestId, writtenAt}`.
    The DO adds `state: 'pending'|'applied'|'failed'` and `appliedAt`. A delete has `key: ''`.
    An insert is one entry per cell, all with `op: 'insert'`.
  - `class OverlayCore { constructor(storage, env, fetchFn, now) }`, with:
    - `record(entries) -> {ok:true}`. Storage key
      `e:${tableId}:${rowId}:${key}:${writtenAt}`, plus `q:${requestId} -> {state, writtenAt, appliedAt}`.
      Sets the alarm to `now + ALARM_EVERY_MS` if none is set.
    - `read(tableId) -> Entry[]`: every stored entry for the table, with its `state` and
      `appliedAt`. The merge (Task 2) decides what is live.
    - `status(requestId) -> 'pending'|'applied'|'failed'|null`.
    - `alarm()`:
      - Polls `GET {CODA_API_BASE}/mutationStatus/{requestId}` (Bearer `CODA_API_TOKEN`) for up
        to `POLLS_PER_ALARM` pending requestIds, oldest first. A fetch error leaves it pending.
      - `completed` → every entry of that requestId becomes `applied`, `appliedAt = now`.
      - Not completed and `now - writtenAt >= FAIL_AFTER_MS` → `failed`; it is not polled again.
      - Deletes entries and `q:` records older than `KEEP_MS` (from `appliedAt` for applied,
        from `writtenAt` otherwise).
      - Re-arms in `ALARM_EVERY_MS` while anything is pending. Otherwise, if anything is still
        stored, arms at the earliest deletion time. Nothing stored → no alarm.
      - **No cache bust and no Publish Log write** (A5, P8, P1).
  - `class WriteOverlay { constructor(state, env); fetch(request); alarm() }`: a thin wrapper
    over `OverlayCore(state.storage, env, fetch, Date.now)`. JSON paths: `POST /record
    {entries}`, `POST /read {tableId}` → `{entries}`, `POST /status {requestId}` → `{state}`.
    No `cloudflare:workers` import.
- Code comments: the file header names the three paths, the states and the constants, and says
  "Coda is the truth; this only covers the apply gap (0012)".

- [ ] **Step 1: Write the failing tests**
  - `record` then `read` returns the entry with `state: 'pending'`, and `status` says `pending`.
  - `alarm` with mutationStatus `completed` makes every entry of that requestId `applied` with
    `appliedAt = now`, and `status` says `applied`.
  - An entry 121 s old and not completed is `failed`, `status` says `failed`, and the next alarm
    doesn't poll it (**Review Focus 5**).
  - `status` of an unknown requestId is `null`.
  - A mutationStatus fetch that throws leaves the entry `pending`.
  - With 12 pending requestIds, one alarm polls exactly 10.
  - An applied entry is gone after `appliedAt + KEEP_MS`; a failed one after
    `writtenAt + KEEP_MS`.
  - The alarm re-arms in 5 s while anything is pending, arms at the earliest deletion once
    nothing is pending, and sets nothing once storage is empty.
  - The alarm makes no KV call and no Publish Log POST.
  - `WriteOverlay.fetch` routes `/record`, `/read` and `/status`, and answers 404 otherwise.
  - `import('../src/worker.js')` still works under node (the class has no `cloudflare:` import).
- [ ] **Step 2: Run them** with `node --test test/overlay-do.test.js` (under the lock). They
  should fail.
- [ ] **Step 3: Implement** `OverlayCore` and `WriteOverlay`, the binding, the migration, the
  export and `OVERLAY_MODE = "off"`.
- [ ] **Step 4: Run** `overlay-do.test.js` and `gcal-run.test.js` (it imports `worker.js`), then
  `./scripts/check.sh`. All should pass.
- [ ] **Step 5: Commit** as `feat(proxy): the write overlay Durable Object, off by default`.

### Task 2: Merge (pure, keying tag, age-aware)

**Files:**
- Create: `proxy/src/overlay.js`
- Modify: `proxy/src/coda-columns.js`: add `venueType` to `PLANNING_COLS` (its id comes from the
  planning table's `/columns`, read once by hand; note the id and where it came from in the
  commit)
- Test: `proxy/test/overlay.test.js`, `proxy/test/coda-columns.test.js` (if it asserts the column
  list)

**Interfaces:**
- Consumes: `Entry` and the constants (Task 1). `stripRich` and the `relId`/`plain` patterns from
  `gather.js`, `hhmm` from `publish.js`.
- Produces:
  - `isLive(entry, {snapshotAt, now}) -> boolean`:
    `pending` → `now - writtenAt < FAIL_AFTER_MS`;
    `applied` → `snapshotAt < appliedAt + APPLY_MARGIN_MS`;
    `failed` → `false`.
  - `mergeRows(rows, entries, {shape:'name'|'id'|'rich', snapshotAt, now, colMap?: {idToName, nameToId}, names?: {people, programs, venues, venueTypes}}) -> {rows, stale: string[]}`.
    `rows` are Coda items (`{id, values}`). Only live entries are applied.
    - **Set:** replaces the cell. When several live entries touch one cell, the newest
      `writtenAt` wins.
    - **Insert:** adds the row when Coda's read doesn't have it.
    - **Delete:** drops the row.
    - **Keying:** an entry whose `keying` matches the reader's (`name` for `shape:'name'`, `id`
      for `id`/`rich`) is used as is. Otherwise it is translated through `colMap`. A key missing
      from `colMap` adds the row id to `stale` and leaves the cell as Coda had it.
    - **Relations:** written as row ids. `shape:'name'` gets display names and `shape:'rich'`
      gets `{rowId, name}` objects, both via `names`. An id missing from `names` adds the row id
      to `stale` and leaves the cell as Coda had it.
    - **Text:** fenced for `rich` the way Coda fences it (so `stripRich` reads it back).
    - **Times:** a written `HH:MM` becomes the ISO time form the reader parses.
    - Formula, lookup and button columns and the row's display name aren't overlaid (nothing
      writes them).
  - `RELATION_COLS`: the relation column ids of the planning, slot and claim tables, read from
    `coda-columns.js` (adding any missing ids there).
- Code comments: the file header states the four rules (live, newest wins, keying, shapes) and
  points at 0012.

- [ ] **Step 1: Leads dry check (read-only).** Read one real planning row with a Leads value
  twice, with `useColumnNames=true&valueFormat=simpleWithArrays` and with `valueFormat=rich`,
  and compare the display value with that person's `name` in the People slim cache. Record the
  result (match or not, and what the display value is) for the PR description. If it doesn't
  match, stop and raise it: the relation → name conversion depends on it.
- [ ] **Step 2: Write the failing tests**
  - Two `set`s on one cell return the newer one (**Review Focus 1**).
  - An insert appears and a delete hides.
  - A name-keyed planning write read with `shape:'rich'` is translated through `colMap`; a key
    missing from `colMap` lands in `stale`.
  - One write with mixed keys (`'Publish status'` and `PLANNING_COLS.lastEbPushAt`) merges both
    into a name-keyed read.
  - Name shape turns a Leads row id into the person's name; rich shape gives `{rowId, name}`.
  - An unknown venue id ends up in `stale`.
  - A Start `"19:00"` read back through `hhmm` gives `"19:00"`; a rich text cell reads back
    through `stripRich` unchanged.
  - **Age-aware:** a snapshot stamped before `appliedAt` and served 4 min later still shows the
    write. A snapshot stamped 31 s after `appliedAt` doesn't merge it, so a later Coda-side edit
    wins (**Review Focus 4**).
  - A pending entry 121 s old and a `failed` entry don't merge (**Review Focus 5**).
  - Rows without entries come back unchanged.
- [ ] **Step 3: Run them.** They should fail.
- [ ] **Step 4: Implement** `isLive` and `mergeRows`. Pure, no I/O. Add `venueType`.
- [ ] **Step 5: Run** the tests, then `./scripts/check.sh`. Both should pass.
- [ ] **Step 6: Commit** as `feat(proxy): merge the overlay into reads`.

### Task 3: `codaWrite`, `overlayRead`, the planning column map, DO-first `/mutation`

**Files:**
- Modify: `proxy/src/worker-io.js`
- Modify: `proxy/src/worker.js`: `swrGetAt` beside `swrGet`; the `/mutation` route
- Test: `proxy/test/worker-io.test.js`, `proxy/test/overlay-routes.test.js` (new; the
  `/mutation` cases)

**Interfaces:**
- Consumes: the `OVERLAY` binding and `OVERLAY_MODE` (Task 1), `mergeRows` (Task 2).
- Produces:
  - `overlayOn(env) -> boolean`: `env.OVERLAY_MODE === 'live' && !!env.OVERLAY`.
  - `codaWrite(env, {url, method:'POST'|'PUT'|'DELETE', body?, tableId, op:'insert'|'update'|'delete', rowId?, auth}) -> {ok, status, resp, requestId, addedRowIds, overlaid}`.
    1. Sends the Coda request exactly as the call site does today.
    2. On a 2xx with overlay on, builds Entries from the cells as written (key and per-cell
       `keying`; `insert` takes `addedRowIds[i]`). A body with `keyColumns` (an upsert) is never
       overlaid.
    3. One `POST /record` to the DO.
    4. `overlaid: false` when the overlay is off, the record call throws or answers non-2xx, or
       Coda returned no `requestId`. One console line when it was on and failed.
  - `passWrite(result, cors) -> Response`: Coda's body with `overlaid` added (so `/rows` POST
    still returns `addedRowIds` and `requestId`).
  - `overlayRead(env, tableId, rows, {shape, snapshotAt, now, colMap?, names?}) -> {rows, stale}`.
    Overlay off → rows unchanged, `stale: []`. Otherwise one `POST /read`, then `mergeRows`. If
    the call throws: rows unchanged, `stale: ['*']`, one console line.
  - `overlayStatus(env, requestId) -> 'pending'|'applied'|'failed'|null` (one DO call; `null`
    when off or on error).
  - `planningColMap(env, base, docId, tableId, auth) -> {idToName, nameToId}`: KV key
    `planning-cols-v1`, refreshed from one `/columns?limit=200` call when older than 1 h.
    Callers only fetch it when a planning entry's keying differs from the reader's.
  - `overlayNames(env) -> {people, programs, venues, venueTypes}` from the existing KV caches
    (`PEOPLE_KV_KEY`, the `/ref` program, venue and venue-type caches). KV reads only.
  - `swrGetAt(env, ctx, key, softMs, hardMs, fetcher) -> {data, at}` in `worker.js`: `swrGet`'s
    logic, also returning the snapshot's `at` (`Date.now()` for a fresh fetch). `swrGet` becomes
    `(...) => (await swrGetAt(...)).data`.
  - **`/mutation/:id`** (worker.js:130): after the unchanged `canWrite` gate, if `overlayOn`,
    ask `overlayStatus`. `pending` → `{completed:false}`; `applied` → `{completed:true}`;
    `failed` → `{completed:false, failed:true}`; all with no Coda call. `null` → today's Coda
    call and `mutationResult`.
- Code comments:
  - `worker-io.js:1-5`: the header lists the new helpers.
  - `worker.js:128-129`: the `/mutation` comment says DO first, then Coda, and what `failed`
    means.

- [ ] **Step 1: Write the failing tests** (stubbed fetch, stubbed `OVERLAY` with a `fetch`):
  - An update records one Entry per cell with the key as written and the right `keying`, and
    returns `overlaid: true`.
  - With `OVERLAY_MODE` unset or `off`, nothing is recorded and `overlaid` is `false`.
  - When the record call throws, it returns `overlaid: false` with the Coda result intact
    (**Review Focus 2**).
  - A body with `keyColumns` isn't recorded.
  - An insert records its cells under `addedRowIds[0]`.
  - `overlayRead` merges; when the overlay throws it returns `stale: ['*']`.
  - `planningColMap` makes one `/columns` call, serves KV for an hour, then refreshes.
  - `/mutation` with the DO answering `pending`, `applied` and `failed` gives
    `{completed:false}`, `{completed:true}` and `{completed:false, failed:true}` with zero Coda
    calls; a DO miss makes exactly one Coda call; a caller without `canWrite` still gets 403.
- [ ] **Step 2: Run them.** They should fail.
- [ ] **Step 3: Implement** the helpers, `swrGetAt` and the `/mutation` change.
- [ ] **Step 4: Run** `worker-io.test.js` and `overlay-routes.test.js`, then `./scripts/check.sh`.
  Both should pass.
- [ ] **Step 5: Commit** as `feat(proxy): write and read through the overlay; /mutation asks it first`.

### Task 4: Planning routes and their row reads

**Files:**
- Modify: `proxy/src/worker.js`; create `proxy/src/overlay-routes.js` for the route glue if
  `worker.js` would grow past ~30 lines
- Test: `proxy/test/overlay-routes.test.js`, plus the existing `publish.test.js` and
  `eventbrite.test.js` if they cover the touched routes

**Interfaces:**
- Consumes: Task 3 helpers.
- Produces:
  - **Writes** to the planning table through `codaWrite`:
    - `/rows` POST, PUT and DELETE (worker.js:192, :217)
    - publish's `setRow` (worker.js:516-520)
    - cancel/unpublish's `setRow` (worker.js:757-761)
    - Responses gain `overlaid` (`passWrite`). Publish, cancel and unpublish report
      `overlaid: true` only when every row write in the call was overlaid.
    - The notes-doc route (worker.js:859) runs a Coda **button**. Coda writes the result, so
      there is nothing to overlay. It stays a direct call, allowlisted in the Task 6 rule with
      that reason.
    - `bustEventCaches` on these writes stays as it is.
  - **Reads** of the planning table through `overlayRead`:
    - `/rows` GET via `swrGetAt` (`shape:'name'`, `snapshotAt` = the snapshot's `at`). The
      `?fresh=1` path passes `snapshotAt = now`.
    - The single-row reads in `/rows` DELETE (:168), publish (:463), eventbrite status (:694),
      eventbrite preview (:719), cancel/unpublish (:754): `shape:'name'`, `snapshotAt = now`.
      A Coda 404 stays a 404 (a new event waits for its insert, D2).
    - When a publish, cancel or unpublish read's `stale` includes the row or `'*'`, the route
      answers 409 `Your last update is still being saved. Try again in a few seconds.` (the
      app already shows that text, web/eventbrite.js:174). `stale` is never returned to the
      app.
  - Not here (PR B): gather, slots, claims, venues, the roster, `buildMyClaims`.
- Code comments: each "bust … next read must see this write" comment on a planning write
  (worker.js:218, :519, :760, :860) says the bust refreshes the snapshot and the overlay covers
  the apply gap. `worker.js:673` stays as it is (it describes gcal-run, which is deferred).

- [ ] **Step 1: Write the failing tests.**
  - With stubbed Coda still holding the old value, `/rows` GET after a recorded PUT returns the
    new value.
  - A `/rows` snapshot stamped before `appliedAt` and served 4 min later still has the write.
  - `/rows` PUT returns `overlaid: true`; with the DO throwing it returns `overlaid: false`
    (**Review Focus 2**).
  - `/rows` POST returns `addedRowIds`, `requestId` and `overlaid`.
  - Publish reads a row with a pending Status `Approved` from the overlay although Coda says
    `Proposed`.
  - Publish with `stale: ['*']` answers 409 with the "still being saved" text.
  - With `OVERLAY_MODE=off`, every route behaves exactly as at base.
- [ ] **Step 2: Run them.** They should fail.
- [ ] **Step 3: Wire** the routes.
- [ ] **Step 4: Run** the touched specs, then `./scripts/check.sh`. Both should pass.
- [ ] **Step 5: Commit** as `feat(proxy): planning routes read their own writes`.

### Task 5: App save path, transitions, create hint, copy

**Files:**
- Modify: `web/data.js`, `web/coda-applied.js`, `web/save.js`, `web/state.js`, `web/editor.js`,
  `web/transitions.js`, `web/eventbrite.js` (comments only), `web/status-panel.js`,
  `web/listing-readiness.js`
- Test: `proxy/test/coda-applied.test.js`, `proxy/test/save-queue.test.js`,
  `proxy/test/listing-readiness.test.js`

**Interfaces:**
- **Data.** `DB.update`, `DB.create` and `DB.remove` return `overlaid` from the Worker body.
  `DB.publishEventbrite` and the cancel/unpublish calls pass `overlaid` through.
  `DB.mutationStatus` returns `failed: !!j.failed` too.
- **Confirm.** `CodaApplied.waitApplied` rejects with its existing `Error('save not confirmed')`
  when `r.failed === true`.
- **Saving** (`web/save.js`):
  - `_confirming: Map<id, count>` beside `_applying`: background confirms of overlaid writes.
  - `confirmLater(requestId, id, onFail)`: `applied(requestId, id, {counted:false})`, counted in
    `_confirming` until it settles, then `markRecent`. It never counts in `pendingFor`.
  - `saveQueue`'s write: `r.overlaid ? confirmLater(r.requestId, id, …) : applied(r.requestId, id, {counted:false})`,
    so an overlaid write resolves the queue at once. A background failure toasts the existing
    save.js:128 text for that event and calls `scheduleReconcile`.
  - `trackWorkerWrite(ev, requestId, overlaid)`: overlaid → `confirmLater`; otherwise counted, as
    today. The failure toast becomes `The change didn't confirm. Check again in a minute.`
  - `trackCreate` still awaits the insert's apply (creates always wait). It sets
    `_busyLabel(id) = 'Creating… (about half a minute)'` until the apply settles, toasts
    `Created` when it resolves, and on failure clears the label and sets `_unconfirmed` (pill:
    **Save failed — retry**), as today.
- **State** (`web/state.js` `loadEvents`): `_recent` is held while `_applying` **or**
  `_confirming` counts the event, so a DO blip on a read (`stale` rows) can't revert a change
  shown as saved.
- **Create** (`web/editor.js`): the Create toast (:261) becomes
  `Creating… this takes about half a minute`; `toast('Created','ok')` (:268) moves into
  `trackCreate`. The event page still opens at once and stays editable; edits queue behind
  `afterCreate`.
- **Panel** (`web/status-panel.js`): `busy` is set while `_busy` **or** `_createApply` has the
  event, using `_busyLabel`, so the primary (the in-card button, and `#epPhoneBar` on phones)
  reads **Creating… (about half a minute)**. A named busy label never becomes
  **Still saving…** (already pinned by listing-readiness.test.js:334).
- **Transitions** (`web/transitions.js`): after the Status write, `w.overlaid ? confirmLater(…)
  : await applied(…)`, so Approve → Add to Eventbrite doesn't wait ~28 s.
- **Push** (`web/eventbrite.js` `settledForPush`): no logic change (`pendingFor` drops on its
  own once the request returns).
- **Copy** (`web/listing-readiness.js`): `SLOW_TIP = 'This is taking longer than usual; your change is safe'`.
- **Code comments** (in this task, because it edits these files):
  - [ ] `web/save.js:38-42` (honest saves: Saved = overlaid or applied), `:63-66`
    (`pendingFor`: no longer counts background confirms), `:73-75` (`trackWorkerWrite`). `:86`
    stays true (creates still wait); leave it.
  - [ ] `web/save.js:2-3`: the header's "Saved = applied, D3" becomes "Saved = overlaid or
    applied (D3, 0012)", and it lists `_confirming` and `confirmLater` under Owns.
  - [ ] `web/coda-applied.js:1-11`: the header documents `failed` and that `/mutation` answers
    from the overlay first.
  - [ ] `web/data.js:307-309`: Worker writes return `{requestId, overlaid}`; `applied` runs only
    when not overlaid, or in the background.
  - [ ] `web/data.js:313-315` [judge]: the `mutationStatus` comment says `/mutation` is DO-first
    and can return `failed`.
  - [ ] `web/status-panel.js:12`, `:25-28`: the primary follows `pendingFor` (until the request
    returns, or applies when not overlaid) and shows the create label.
  - [ ] `web/listing-readiness.js:128` (`SLOW_TIP` is fallback-only now), `:301-303` (slow means
    the fallback wait).
  - [ ] `web/eventbrite.js:129-132`: `settledForPush` waits for in-flight requests and, when not
    overlaid, applies; the `150000` deadline comment still says `waitApplied` gives up at 120 s.
  - [ ] `web/transitions.js:26-27`: Approve → Add to Eventbrite reads the Status through the
    overlay; it waits for the apply only when not overlaid.
- **Tests:**
  - [ ] `proxy/test/save-queue.test.js:225`: rename "Honest saves (D3)" to say `saved` waits for
    the write's promise (the 202, then the apply only when not overlaid). Add a case: a write
    that resolves on the 202 (overlaid) fires `saved` at once.
  - [ ] `proxy/test/listing-readiness.test.js:315-318` [judge]: rename the "Coda-is-slow tip"
    test and assert the new `SLOW_TIP` string.

- [ ] **Step 1: Write the failing tests.**
  - `waitApplied` rejects with `save not confirmed` on `{status:200, failed:true}`
    (**Review Focus 5**), and still resolves on `completed` and 404.
  - The save-queue cases above (**Review Focus 2**: `overlaid: false` still waits for the apply).
  - `footerModel` with `busy: 'Creating… (about half a minute)', slow: true` keeps that label
    (**Review Focus 3**).
  - The new `SLOW_TIP` string.
- [ ] **Step 2: Run them.** They should fail.
- [ ] **Step 3: Implement.** `web/*.js` stays ≤ 800 lines.
- [ ] **Step 4: Run** the touched specs and `./scripts/check.sh`. Both should pass. (The help
  guard's branch check passes once Task 6 lands in the same branch.)
- [ ] **Step 5: Hand-check with writes stubbed** (live-server on :8080, record its PID, stop it
  by PID afterwards; `~/.claude/CLAUDE.md` "Machine resources"): an edit's **Saving…** clears in
  about a second; Create shows **Creating… (about half a minute)** in the panel and the phone
  bar, the new toast, then `Created`; a stubbed `failed` from `/mutation` shows
  **Save failed — retry** or the toast.
- [ ] **Step 6: Commit** as `feat(app): edits save instantly; new events say they take half a minute`.

### Task 6: Help, decisions, project docs and the `check.sh` rule (PR A)

**Files:**
- Modify: `web/help/guide.md`, `web/help/whats-new.md`
- Create: `docs/decisions/0012-write-through-overlay.md`
- Modify: `docs/decisions/0005-saved-means-applied.md`, `docs/decisions/0008-coda-apply-latency.md`,
  `docs/decisions/README.md`, `CLAUDE.md`, `docs/GLOSSARY.md`, `docs/app-map.md`,
  `docs/roadmap.md`, `docs/deployment.md`,
  `docs/superpowers/plans/2026-11-19-eventbrite-sync-gcal-one-event-table.md`,
  `docs/superpowers/specs/2026-11-18-eventbrite-sync-gcal-one-event-table-design.md`
- Modify: `scripts/check.sh` (rule 7), with a test in `proxy/test/` if the other `check.sh` rules
  have one (else a self-test fixture run by hand and noted in the PR)

**Help (`web/help/`)**
- [ ] guide.md:103-105: after step 5 [[Create]], add "It takes about half a minute to create;
  the button says [[Creating… (about half a minute)]] meanwhile. You can keep editing."
- [ ] guide.md:126: rewrite. Changes save in about a second. **Still saving…** now means
  something is slow.
- [ ] guide.md:324: rewrite "It says Saving… for a long time". It's rare now. A new event takes
  about half a minute.
- [ ] guide.md:326: check it against the shipped failure copy (it should stay as is).
- [ ] whats-new.md: add a dated line that says plainly it replaces the "Honest saving" (:43) and
  "Quieter saving" (:37) timings.
- [ ] Leave alone, and the PR says so: guide.md:255, :266, :268 and the whats-new 2026-11-22
  sync lines (Eventbrite and Calendar marker timings are unchanged), plus guide.md:202 (notes
  doc, a Google-side delay).
- [ ] Re-read every bold save label in guide.md against the running app. The guard can't check
  them.
- [ ] Write for a non-technical lead (guide.md's writing guide). No "Mission Control", no
  "overlay".

**Decisions**
- [ ] New `docs/decisions/0012-write-through-overlay.md`: the DO; entries as written plus
  `keying`; the age-aware merge (`APPLY_MARGIN_MS`, 5.5 min keep); 120 s → `failed` through
  `/mutation`; `OVERLAY_MODE`; creates still wait; Add venue still waits (one plain line: "a
  new venue has to be created before an event can use it"); runners deferred. Plus one
  paragraph on the rejected alternative: "stop holding Saving… for plain edits and wait only at
  steps that read the row" doesn't give gather reloads read-your-writes and doesn't make
  Approve → Add to Eventbrite instant, because the Worker reads Coda; both are in the core
  outcome, and Eric chose the overlay on 2026-11-20.
- [ ] 0005: rewrite the title (:1) [judge], the **Status** (:3, "in force" → "amended by 0012")
  [judge], the Decision (:6-12, including "Anything that reads Coda after a save waits until
  nothing is pending") [judge], and Consequences (:21-23).
- [ ] 0008: change **Status** (:3) [judge]. Consequences :12 ("so they look slow") [judge] and
  :13-14 ("Reads right after a write can miss it" → "Worker reads don't; Coda-side readers and
  the sync runners still do") [judge]. :18-19 becomes "Adopted: see 0012".
- [ ] `docs/decisions/README.md:13` (0005 row title) and `:16` (0008 row), plus a new 0012 row
  [judge].
- [ ] 0010:36 (tombstone): leave alone, since runners are deferred [judge].

**Project docs**
- [ ] `CLAUDE.md:53` (non-negotiable #5: "Saved" means Coda accepted the write and the overlay
  holds it, or applied it when the overlay is off), `:58-59` (hard constraint: "Worker reads see
  the Worker's writes; Coda-side readers and the sync runners still lag ~28 s"), and a sibling
  to `:67`: "every Worker write to planning/slots/claims/venues goes through `codaWrite`, every
  read through `overlayRead`; sync runners are allowlisted until the follow-up".
- [ ] `docs/GLOSSARY.md:94-95`: rewrite **Saved** and **Saving… / Still saving…**. Add rows:
  **overlay / overlaid** (`codaWrite`, `overlayRead`, `WriteOverlay`) and
  **Creating… (about half a minute)** (`_busyLabel` via `trackCreate`) [judge, second row].
- [ ] `docs/app-map.md:213-217` and `:225-228` (push waits until every edit is *applied* → until
  every request returned), `:321-327` (cache rules plus the overlay merge; the gather snapshot
  part lands in PR B), `:354-360` (`/mutation` meaning, the DO, `overlay.js`). (`:169`, the venue
  dialog, is PR B.)
- [ ] `docs/roadmap.md:12` plus a shipped entry and a "Next" entry: "Sync runners read through
  the overlay and retire `ebpending:`/`eb-row:importing`/tombstones; first verify whether DO
  calls count toward the 50 subrequests."
- [ ] `docs/deployment.md`: the v2 rollback recipe
  (`[[migrations]] tag = "v2" deleted_classes = ["WriteOverlay"]`, after setting
  `OVERLAY_MODE = "off"`), "flip `OVERLAY_MODE = live` after merge", the free-plan DO limits
  (verify at build time and write them down), and the migration-tag note for #40/#41 (the tag
  order has to survive whichever lands first). `:198` stays true because the script writes Coda
  directly. Leave it alone [judge].
- [ ] `docs/superpowers/plans/2026-11-19-eventbrite-sync-gcal-one-event-table.md:26` and
  `docs/superpowers/specs/2026-11-18-eventbrite-sync-gcal-one-event-table-design.md:379`: add a
  one-line pointer to 0012. Older specs and plans are historical, so leave them alone.

**`scripts/check.sh` rule 7**
- [ ] Flag a Coda `PUT|POST|DELETE` to the planning, slots, claims or venues tables in
  `proxy/src/` outside `codaWrite`, and a `readAllRows` or single-row read of those tables
  outside `overlayRead`. Explicit allowlist: `eb-sync-run.js` and `gcal-run.js` with the comment
  "deferred: sync runners still write directly, see roadmap", and the notes-doc button call
  (Coda runs the button; nothing to overlay). Until PR B lands, the gather, slot, claim, venue
  and roster sites are allowlisted too, each with "PR B"; Task 7 removes those entries. The
  allowlist is part of the rule's test: a fixture with a direct write outside it fails, and each
  allowlisted file passes. Add the rule to the header's list of checks.

- [ ] **Step 1:** Write the help, decisions and docs above.
- [ ] **Step 2:** Add rule 7 and its test.
- [ ] **Step 3:** Run `./scripts/check.sh` and `node scripts/check-help.mjs --branch HEAD`. Both
  should pass.
- [ ] **Step 4:** Commit as `docs: the write-through overlay (PR A)`, then open PR A. The PR
  description has: the Leads dry-check result (Task 2), "`wrangler deploy --dry-run` for Eric",
  "flip `OVERLAY_MODE = live` after merge", and the leave-alone list.

---

## PR B — Gather and venues (branch `feat/overlay-gather`, stacked on PR A)

### Task 7: Gather raw-row snapshot, claims and slots, the claim 409, the double bust, venues

**Files:**
- Modify: `proxy/src/worker.js` (gather, `/claims`, `/slots`, roster, `buildMyClaims`, `/venues`,
  `/ref/venues`, the publish route's venue read and `ensureEbVenue` if rule 7 flags them),
  `proxy/src/worker-io.js`, `proxy/src/venues.js` (only if its duplicate-name read moves),
  `proxy/src/gather.js` (only if `gatherSnapshot` needs a small export)
- Modify: `web/venue-form.js`
- Modify: `web/help/guide.md`, `web/help/whats-new.md`, `docs/app-map.md`, `docs/decisions/0012-write-through-overlay.md`
  (if a venue or gather line needs a tweak), `scripts/check.sh` (drop the "PR B" allowlist
  entries)
- Test: `proxy/test/gather.test.js`, `proxy/test/overlay-routes.test.js`,
  `proxy/test/worker-io.test.js`, `proxy/test/venues.test.js`, `proxy/test/roster.test.js`,
  `proxy/test/eb-sync-run.test.js` (its `gather-events-v1` literal at :142 and :158 becomes the
  new key)

**Interfaces:**
- **Gather snapshot (A1).** `GATHER_KV_KEY` becomes `gather-snap-v2`, holding
  `{events, slots, claims}` raw rich rows (the three `readAllRows(..., {rich:true})` lists).
  An old-shape value is never read. Serve: `swrGetAt` → `overlayRead` ×3 (`shape:'rich'`,
  `snapshotAt` = the snapshot's `at`; the planning list gets `planningColMap` when an entry is
  name-keyed) → `gatherSnapshot(events, slots, claims, today)` → the existing filters in
  `buildMemberEvents`. `bustEventCaches` busts the new key.
- **`buildMyClaims` and the roster.** Their raw reads go through `overlayRead` with
  `snapshotAt = now`. The roster keeps its KV cache and `bustRosterForSlot`; its build merges
  before `buildRoster`.
- **Claims and slots writes.** `/claims` POST, `/claims/:id` PUT and DELETE, `/slots` POST, PUT
  and DELETE go through `codaWrite` (id-keyed) and return `overlaid`.
- **The claim 409 (P7).** The `/claims/:id` ownership read (worker.js:1027-1029) goes through
  `overlayRead`. If the claim exists only as a pending overlay insert by the caller (or any
  pending insert, for a `canWrite` caller), answer 409
  `Your sign-up is still being saved. Try again in a few seconds.` (Coda would 404 the
  DELETE/PUT anyway.) A claim Coda has, with a pending edit, proceeds as today.
- **The double bust (P8).** Remove `bustEventCachesNowAndAfterApply` from `worker-io.js` and
  its callers (worker.js:1010, :1034, :1086, :1094); they call `bustEventCaches`. There is no
  apply-time bust to replace it (the merge is age-aware). `trackWorkerWrite` keeps its
  background `applied()` and reworded toast (Task 5).
- **Venues (P5).** `/venues` POST and PUT go through `codaWrite` (id-keyed). `/ref/venues` and
  `/venues/:id` reads go through `overlayRead`. `ensureEbVenue`'s cache-column write and the
  publish route's Venues read (worker.js:486) go through the helpers if rule 7 flags them.
  `web/venue-form.js`: **Save address** returns at once when the response is `overlaid`
  (otherwise `venueApplied`, as today). **Add venue** keeps `venueApplied`, and
  **Adding venue…** stays.
- **Code comments:**
  - [ ] `proxy/src/worker.js` bust comments on claim and slot writes (:1010, :1034, :1086,
    :1094): one bust now; the overlay covers the apply gap.
  - [ ] `proxy/src/worker-io.js:1-5` (header) and `:18-23` (the double-bust comment and
    function go).
  - [ ] `proxy/src/worker-io.js:13`: the `GATHER_KV_KEY` comment says raw rich rows, merged
    before `gatherSnapshot`.
  - [ ] `proxy/src/venues.js:58`: only if the duplicate-name read goes through `overlayRead`
    (then it can see venues made in the last ~28 s through the Worker).
  - [ ] `web/venue-form.js:20-24`: Add venue waits for Coda to apply (an event must never point
    at a venue row Coda hasn't created); Save address is saved once overlaid.
- **Tests:**
  - [ ] `proxy/test/worker-io.test.js:3`, `:34-37`: drop the `bustEventCachesNowAndAfterApply`
    import and test.

- [ ] **Step 1: Write the failing tests.**
  - An event Approved only in the overlay appears in the member list.
  - A claim inserted only in the overlay appears under its slot.
  - A slot inserted only in the overlay appears under its event.
  - `buildMyClaims` lists a claim inserted only in the overlay; the roster counts it.
  - An old `gather-events-v1` value in KV is never read.
  - `/claims/:id` DELETE on the caller's pending insert answers 409 with the exact text
    (**Review Focus 6**); on a claim Coda has, it proceeds.
  - A claim write calls `bustEventCaches` once, with no delayed second bust.
  - `/venues` PUT returns `overlaid: true`; `/ref/venues` shows the new address before Coda
    applies it.
- [ ] **Step 2: Run them.** They should fail.
- [ ] **Step 3: Implement.** Remove the "PR B" entries from rule 7's allowlist; the rule must
  still pass.
- [ ] **Step 4: Help and docs (PR B):**
  - [ ] guide.md:154 and :156: Add venue still waits. Keep the wording, re-verify it, and add a
    short "why" only if it reads naturally ("a new venue has to be created before an event can
    use it").
  - [ ] guide.md:158-160 [judge]: **Save address** becomes instant. No timing is stated today,
    so just re-read it.
  - [ ] `docs/app-map.md:169`: the venue dialog waits for Add venue, not for Save address.
  - [ ] `docs/app-map.md:321-327`: the raw-row gather snapshot, merged before `gatherSnapshot`,
    and the key bump to `gather-snap-v2`.
  - [ ] `web/help/whats-new.md`: one dated line: [[Save address]] now saves at once; adding a
    venue still takes about half a minute (CLAUDE.md: a change a lead could notice gets a line).
- [ ] **Step 5: Run** the touched specs, `./scripts/check.sh` and
  `node scripts/check-help.mjs --branch HEAD`. All should pass.
- [ ] **Step 6: Commit** as `feat(proxy): gather and venues read their own writes`, then open
  PR B, with "`wrangler deploy --dry-run` for Eric" in the description.

---

## Wise-up ledger

| id | ruling | reason |
|---|---|---|
| A1 | KEEP | Gather's KV value is filtered and grouped, so no serve-time merge can restore a just-approved event or place a new claim; cache raw rows under a new key and merge before `gatherSnapshot`. |
| A2 | SIMPLIFY | Writes are name-keyed and the column cache can't translate; store entries as written plus `keying`, and build a column map for the planning table only. |
| A3 | KEEP (merged with P1) | One confirm channel: `/mutation/:id` asks the DO first; no gate relaxation, since gather doesn't poll it. |
| A4 | KEEP (cut Task 5) | Runner wiring changes no outcome now and costs 12.5% of Eventbrite throughput on an unverified premise. |
| A5 | CHANGE | The age-aware merge replaces the 60 s grace and the apply-time bust; the margin is 30 s, not 5 s, because Coda's read-replica lag is unmeasured and a wider margin is harmless. |
| A6 | SIMPLIFY | Transitions, push and venue waits are named; `_recent` is held by the background confirm instead of a `/rows` `stale` flag. |
| A7 | KEEP | A fetch-style DO keeps node tests working, and `OVERLAY_MODE` gives a kill switch; the binding ships in PR A, the first PR that uses it. |
| A8 | KEEP, with corrections | File:line doc checklist plus a `check.sh` rule with an explicit runner allowlist; runner comments that stay true are removed from the stale list. |
| P1 | KEEP (as merged with A3) | The existing failure UI covers a failure Coda has never produced; one channel, `failed` at 120 s. |
| P2 | KEEP | New events stay editable; edits already queue behind `afterCreate`, and help promises it. |
| P3 | KEEP | Reuse the app's words; `Created` moves to when the insert applies; no "Mission Control". |
| P4 | KEEP | The combined doc checklist, placed per task above. |
| P5 | KEEP (PARTIAL) | Save address is a plain cell edit and becomes instant; Add venue keeps its wait. |
| P6 | KEEP | Re-sliced so the lead's fast save ships first: PR A (Tasks 1–6), PR B (Task 7). |
| P7 | KEEP | The claim ownership read goes through the overlay; a pending insert answers 409. |
| P8 | KEEP | The double bust goes in PR B with claims and slots; no apply-time bust; `trackWorkerWrite` keeps its toast. |

**Tasks:** 7 before → 7 after (runners and notices gone; help and docs split per PR).
**PRs:** 3 before → 2 after.

**Prior cuts (still cut, no new evidence):**
- D1 (Cloudflare D1) as the source of truth
- a Coda pack sync table
- Supabase
- a create write queue (to make new events instant)
- `/me/writes` and the notices ladder (unconfirmed → lost)
- the sync-runner wiring (deferred, see below)

## Decisions

- **D1. Coda stays the source of truth.** An applied entry merges only into snapshots taken
  before `appliedAt + 30 s`; an unapplied one merges for at most 120 s; nothing outlives
  ~5.5 min. *Why:* 0001; anything longer makes the overlay a second truth.
- **D2. "Saved" = accepted and overlaid, else applied.** New events always wait, show
  **Creating… (about half a minute)** at once, and stay editable. *Why:* Coda 404s writes to
  rows it hasn't created; the overlay is not a write queue.
- **D3. One failure channel.** `/mutation/:id`, DO-first, then Coda; `failed` at 120 s shows as
  **Save failed — retry** or the existing toasts. *Why:* a second notice system would give a
  lead two names for one failure.
- **D4. Entries as written, with `keying`.** Only planning name ↔ id is translated, through a
  KV-cached hourly column map. *Why:* the planning seam is name-keyed end to end; slots, claims
  and venues are id-keyed both ways.
- **D5. Gather caches raw rich rows under a new key.** The merge runs before `gatherSnapshot`.
  *Why:* the filtered, grouped snapshot can't take a merge.
- **D6. Age-aware merge, no fixed grace, no apply-time bust; the double bust goes in PR B.**
  *Why:* `swrGet` serves snapshots up to 5 min old; only the snapshot's age decides correctly.
- **D7. Fetch-style DO behind `OVERLAY_MODE` (default off), rollback recipe in deployment.md.**
  *Why:* node tests import `worker.js`, and a DO class can't be backed out by a revert.
- **D8. Sync runners untouched.** `SWEEP_MAX_EVENTS` stays 8, the markers stay, the runners are
  allowlisted in `check.sh`, and the follow-up is in the roadmap. *Why:* the markers already
  cover the gap; wiring them costs throughput on an unverified premise.
- **D9. Add venue waits; Save address is instant; a pending claim's edit or remove answers 409.**
  *Why:* a new venue id isn't in the name caches until Coda applies it; Coda would 404 a write to
  a claim it hasn't created.
- **D10. No new vocabulary beyond Creating… (about half a minute) and the reworded `SLOW_TIP`.**
  `Created` fires on apply. No "Mission Control" on screen. *Why:* one vocabulary, and the
  writing guide bans internal names.
- **D11. `/mutation` keeps its `canWrite` gate.** *Why:* gather doesn't poll it (`rememberOp`),
  so relaxing it has no consumer.
- **D12. Two PRs, help and docs in each.** *Why:* PR A delivers the lead's fast save end to end
  and can be shown working.

## Deferred

- **Sync runners read through the overlay, and the markers retire** (`ebpending:`,
  `eb-row:importing`, calendar tombstones; `SWEEP_MAX_EVENTS` and the budget comments revisited
  in the same step). Home: a `docs/roadmap.md` "Next" item (written in Task 6).
- **The "after the flip" help PR** (once `OVERLAY_MODE = live` has held for a while). Help in
  PR A is worded to hold with the overlay off, so it can't yet say saves are fast. Then:
  tighten `web/help/guide.md:126` and `:324` (a change usually saves in a moment; **Still
  saving…** means it's slow), and add a dated whats-new line, for example: "**Saving is
  quicker.** A change usually saves in a moment, and **Still saving…** shows only when one is
  slow. This replaces the half-minute wait in *Honest saving* (2026-11-15); *Quieter saving*
  (2026-11-16) gave the **Saving…** / **Still saving…** wording, which stays." Home: this
  section and `docs/deployment.md` (before the flip, step 5).
- **Verify whether Durable Object calls count toward the 50-subrequest limit** before that
  follow-up, and record the answer in `docs/deployment.md`. Home: the same roadmap "Next" item.
