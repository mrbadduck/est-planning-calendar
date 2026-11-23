# Write-through overlay — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every read through the Worker sees the Worker's own writes at once, so app edits and
gather claims are saved in about a second. Coda stays the source of truth.

**Architecture:** A SQLite-backed Durable Object (`WriteOverlay`) remembers each Worker write to the
planning, slots, claims and venues tables until Coda applies it, plus 60 s. One helper writes
(`codaWrite`), and one helper merges the overlay into reads (`overlayRead`). The DO's alarm
polls Coda's `mutationStatus` and clears entries. The app treats `overlaid: true` writes as saved.
New events still wait, with an immediate hint.

**Tech Stack:** Cloudflare Workers, Durable Objects (RPC + transactional storage + alarms), KV,
Coda API v1, vanilla JS app, `node --test`.

**Spec:** `docs/superpowers/specs/2026-11-23-write-through-overlay-design.md`

## Global Constraints

- Coda stays the source of truth (0001). No overlay entry is merged later than 60 s after Coda
  applies it, or 10 min after the write if Coda never confirms it.
- **"Saved" means one of two things.** Either Coda accepted the write and the overlay holds it
  (`overlaid: true`), or, when the overlay is unreachable, Coda applied it (today's wait).
  Creating a new event always waits, and the hint appears immediately: *Creating the event in
  Mission Control — this takes about half a minute.*
- **Free plan; ≤ 50 outbound calls per invocation.** Count every Durable Object call as a
  subrequest. Overlay records are batched once per sweep run. `SWEEP_MAX_EVENTS` goes from 8
  to 7.
- **Overlay keys are column ids, never names.** Relations are stored as written (row ids) and
  converted to the reader's format through KV caches the Worker already keeps.
- **Notices go only to the person who wrote, via `GET /me/writes`.** Never put them in `/rows`
  or the gather snapshot, which are shared.
- **Timings:** alarm every ~5 s while anything is pending; unconfirmed after 120 s; lost after
  10 min; 60 s grace after applied.
- **Tests run under the lock,** touched specs only:
  `cd proxy && until mkdir /tmp/jest.lock 2>/dev/null; do sleep 5; done; trap 'rmdir /tmp/jest.lock' EXIT; node --test test/<f>.test.js`.
  `./scripts/check.sh` must pass before every commit.
- **Help ships with lead-visible changes.**
- **No deploys, no prod writes from a session.** Wrangler is denied in-session; note
  `wrangler deploy --dry-run` for Eric in each PR.
- **Commits end with the two attribution lines.**

## Review Focus

1. **Two quick edits to the same cell, a second apart.** Every read returns the second value
   until Coda applies both, then Coda's value. Test in Task 2: newest `writtenAt` wins.
2. **The overlay is unreachable on a save.** The response says `overlaid: false`, the app waits
   as today, and nothing shows Saved early. Tests in Task 3 (Worker) and Task 6 (app).
3. **A new event.** The hint appears at once. Edits wait until Coda creates the row. Nothing
   writes to the row before then. Test in Task 6.
4. **Coda applies, then someone edits the same cell in Coda.** After the 60 s grace the Coda
   edit shows. The overlay never resurrects the old value. Test in Task 1: an entry past its
   grace isn't returned.
5. **A delete Coda never confirms.** The row comes back after 10 min, and the writer gets a
   notice without "Try again". Test in Task 1 (lost state) and Task 6 (notice copy).

---

## PR 1 — Overlay core, no behaviour change (branch `feat/overlay-core`, stacked on `docs/overlay`)

### Task 1: The Durable Object

**Files:**
- Create: `proxy/src/overlay-do.js`
- Modify: `proxy/wrangler.toml`: the `[[durable_objects.bindings]] name="OVERLAY" class_name="WriteOverlay"`
  binding, and `[[migrations]] tag="v1" new_sqlite_classes=["WriteOverlay"]`
- Modify: `proxy/src/worker.js`: `export { WriteOverlay } from './overlay-do.js'`
- Test: `proxy/test/overlay-do.test.js`, with a fake `ctx.storage` (Map-backed `get`, `put`,
  `delete`, `list({prefix})`, `setAlarm`, `getAlarm`) and a stubbed `fetch`

**Interfaces:**
- Produces, as RPC methods on `WriteOverlay`:
  - `record(entries: Entry[]) -> {ok:true}`. `Entry = {tableId, rowId, colId, value, op:'set'|'insert'|'delete', requestId, writtenAt, actorId}`.
    The storage key is `e:${tableId}:${rowId}:${colId}:${writtenAt}`. It sets the alarm if none is set.
  - `read(tableId, now) -> Entry[]`. Returns the entries in state `pending`, `unconfirmed`, or
    `applied` with `now - appliedAt < 60000`.
  - `mine(actorId, now) -> {unconfirmed: Entry[], lost: Entry[]}`. `lost` covers the last
    10 min.
  - `alarm()` works through the pending entries:
    - It polls `GET {CODA_API_BASE}/mutationStatus/{requestId}` (Bearer `CODA_API_TOKEN`) for
      up to 10 requestIds.
    - `completed` → `applied`, `appliedAt = now`.
    - After more than 120 s → `unconfirmed`. An unconfirmed entry is still polled.
    - After more than 10 min → `lost`. This also writes one Publish Log record via
      `logPublishMany` with action `overlay-lost`.
    - It deletes applied entries past their grace, and lost entries after another 10 min.
    - When anything newly applied, it calls `bustEventCaches(env)`.
    - It re-arms itself in 5 s while any entry is pending or unconfirmed.

- [ ] **Step 1: Write the failing tests**
  - `record` then `read` returns the entry.
  - `alarm` with mutationStatus `completed` makes it `applied`. It's still returned at
    now + 59 s and not at now + 61 s (**Review Focus 4**).
  - An entry 121 s old and not completed is `unconfirmed` and still returned by `read`.
  - At 10 min + 1 s it's `lost`, `read` no longer returns it, `mine(actor)` lists it under
    `lost`, and exactly one Publish Log POST is made (**Review Focus 5**).
  - `alarm` re-arms while anything is pending, and doesn't once everything is cleared.
- [ ] **Step 2: Run them** with `node --test test/overlay-do.test.js`. They should fail.
- [ ] **Step 3: Implement** `WriteOverlay`, extending `DurableObject` from `cloudflare:workers`.
  For node tests, export the logic class separately (`OverlayCore`), taking `(storage, env, fetchFn)`.
  The DO wraps it, so the tests need no Workers runtime.
- [ ] **Step 4: Run** the tests, then `./scripts/check.sh`. Both should pass.
- [ ] **Step 5: Commit** as `feat(proxy): the write overlay Durable Object`.

### Task 2: Merge and read shapes (pure)

**Files:**
- Create: `proxy/src/overlay.js`
- Test: `proxy/test/overlay.test.js`

**Interfaces:**
- Consumes: `Entry` (Task 1). Also `stripRich` and the `plain`/`relId` patterns from `gather.js`,
  and `hhmm` from `publish.js`.
- Produces:
  - `mergeRows(rows, entries, {keying:'id'|'name'|'rich', colNames?: Record<colId,string>, names?: {people, programs, venues, venueTypes}}) -> {rows, stale: string[]}`.
    - **Set:** a `set` replaces the cell. When several entries touch one cell, the newest
      `writtenAt` wins.
    - **Insert:** an `insert` adds the row when it's missing.
    - **Delete:** a `delete` drops the row.
    - **Relations:** row ids are converted to names (name keying) or to `{rowId, name}`
      (rich keying), using `names`. An id missing from `names` adds the row id to `stale` and
      leaves the cell as Coda had it.
    - **Text:** text cells get the reader's format, which means fenced for rich.
    - **Times:** written `HH:MM` becomes the ISO time form the reader parses.
  - `RELATION_COLS`: the planning-, slot- and claim-table column ids that are relations.
    Read this from `coda-columns.js` and add any missing ids.

- [ ] **Step 1: Write the failing tests**
  - Two `set`s on one cell return the newer one (**Review Focus 1**).
  - An insert appears and a delete hides.
  - Name keying turns a Leads row id into the person's name.
  - Rich keying gives `{rowId, name}`.
  - An unknown venue id ends up in `stale`.
  - A Start `"19:00"` read through `hhmm` gives back `"19:00"`.
  - Rows without entries come back unchanged.
- [ ] **Step 2: Run them.** They should fail.
- [ ] **Step 3: Implement** `mergeRows`. It's pure, with no I/O.
- [ ] **Step 4: Run** the tests. They should pass.
- [ ] **Step 5: Commit** as `feat(proxy): merge the overlay into reads`.

### Task 3: `codaWrite` and `overlayRead`

**Files:**
- Modify: `proxy/src/worker-io.js`
- Test: `proxy/test/worker-io.test.js`

**Interfaces:**
- Consumes: `OVERLAY` binding (Task 1), `mergeRows` (Task 2).
- Produces:
  - `codaWrite(env, {tableId, op:'insert'|'update'|'delete', rowId?, cells, actorId, keyColumns?, defer?: Entry[]}) -> {ok, status, requestId, addedRowIds?, overlaid: boolean, resp}`.
    1. Sends the Coda request exactly as the call sites do today.
    2. On a 2xx, builds Entries (`insert` takes `addedRowIds[0]`; an upsert with `keyColumns` is
       never overlaid).
    3. Calls `OVERLAY.record` once, or pushes the Entries onto `defer` when it's given (the
       sweeps).
    4. `overlaid: false` when the record call throws. Log one console line for it.
  - `overlayRead(env, tableId, rows, opts) -> {rows, stale}`. One `OVERLAY.read` call, then
    `mergeRows`. If the call throws, it returns the rows unchanged with `stale: ['*']` and one
    console line.
  - `overlayRecordMany(env, entries) -> boolean`.
  - `overlayNames(env) -> names`, built from the existing KV caches (`PEOPLE_KV_KEY`, the
    `/ref` program, venue and venue-type caches). KV reads only.

- [ ] **Step 1: Write the failing tests** (stubbed fetch, stubbed `OVERLAY` stub object):
  - An update records one Entry per cell and returns `overlaid: true`.
  - When the record call throws, it returns `overlaid: false` with the Coda result intact
    (**Review Focus 2**).
  - An upsert with `keyColumns` isn't recorded.
  - With `defer`, nothing is recorded and the entries are appended.
  - `overlayRead` merges, and when the overlay throws it returns `stale: ['*']`.
- [ ] **Step 2: Run them.** They should fail.
- [ ] **Step 3: Implement** the helpers.
- [ ] **Step 4: Run** the tests, then `./scripts/check.sh`. Both should pass.
- [ ] **Step 5: Commit** as `feat(proxy): write and read through the overlay`. Open PR 1
  (no wiring yet, so no behaviour change).

## PR 2 — Worker reads and writes go through the overlay (branch `feat/overlay-wire`, stacked on PR 1)

The app still waits here, so the PR is safe on its own. It only makes Worker reads fresher.

### Task 4: App-facing and lead routes

**Files:**
- Modify: `proxy/src/worker.js`, `proxy/src/venues.js` (if its writes live there)
- Test: `proxy/test/overlay-routes.test.js`, testing a pure helper that picks the keying and
  table for each route, plus the existing tests

**Interfaces:**
- Consumes: Task 3 helpers.
- Produces:
  - **Writes:** every Coda write in these routes goes through `codaWrite`:
    - `/rows` POST, PUT and DELETE
    - `/venues` POST and PUT
    - `/claims` POST, PUT and DELETE
    - `/slots` POST, PUT and DELETE
    - the notes-doc route
    - publish, cancel, unpublish

    Responses gain `overlaid`. The `/rows` POST still returns `addedRowIds`.
  - **Reads:** every Coda read of the four tables in these routes merges via `overlayRead`:
    - `/rows` GET, merged *after* `swrGet` so the KV snapshot never hides a write
    - the single-row reads in publish, cancel, unpublish, delete and eventbrite status/preview
    - `/venues/:id`, `/ref/venues`
    - the gather `buildMemberEvents` snapshot (rich), `buildMyClaims`, the roster

    A read whose `stale` includes the row (or `*`) behaves as today. For the publish route,
    that means it does what the pending-save rules already make it do.
  - **New route:** `GET /me/writes` (signed-in, plan or gather) → `{unconfirmed, lost}` via
    `OVERLAY.mine(personId)`, each item being `{tableId, rowId, columns: string[], op, at}`.
  - **Removed:** `bustEventCachesNowAndAfterApply`'s delayed second bust is no longer needed.
    Replace it with `bustEventCaches`. The DO's alarm busts on apply.
  - `worker.js` doesn't grow by more than about 30 lines. Put the logic in `worker-io.js` or a
    new `overlay-routes.js`.

- [ ] **Step 1: Write the failing tests.**
  - A pure helper `routeReadSpec(path) -> {tableId, keying}` covers each route above.
  - With stubbed fetch and overlay, `/rows` GET after a recorded PUT returns the new value
    although the stubbed Coda still has the old one.
  - `/me/writes` returns only the caller's entries.
- [ ] **Step 2: Run them.** They should fail.
- [ ] **Step 3: Wire** the routes.
- [ ] **Step 4: Run** the full proxy suite once, then `./scripts/check.sh`. Both should pass.
- [ ] **Step 5: Commit** as `feat(proxy): app and lead routes read their own writes`.

### Task 5: Sync runners

**Files:**
- Modify: `proxy/src/eb-sync-run.js`, `proxy/src/gcal-run.js`
- Test: `proxy/test/eb-sync-run.test.js`, `proxy/test/gcal-run.test.js`

**Interfaces:**
- **Eventbrite sweep and webhook.** Row reads go through `overlayRead`: the sweep's full read,
  the webhook's `query` lookup (overlay inserts matching the query are added) and the single-row
  read. Writes go through `codaWrite` with `defer`, then one `overlayRecordMany` at the end of
  the run, in the same `finally` as the batched log. `SWEEP_MAX_EVENTS = 7`. Update the
  worst-case comment to ≤ 50.
- **Calendar sweep.** The same pattern. Writing a gCal id goes through `codaWrite` with `defer`.
  The reserve now includes +2.

- [ ] **Step 1: Write the failing tests.**
  - A sweep run makes exactly one `OVERLAY.record` call (or none when nothing was written) and
    one `OVERLAY.read` per table read.
  - An eight-candidate Eventbrite run processes seven.
  - The calendar budget test still stops at or under 50.
- [ ] **Step 2: Run them.** They should fail.
- [ ] **Step 3: Implement** the changes in both runners.
- [ ] **Step 4: Run** the full suite once, then `./scripts/check.sh`. Both should pass.
- [ ] **Step 5: Commit** as `feat(proxy): sync runners read their own writes`, then open PR 2.

## PR 3 — Saves are instant (branch `feat/overlay-app`, stacked on PR 2)

### Task 6: App save path, create hint, notices, help

**Files:**
- Modify: `web/save.js`, `web/data.js`, `web/editor.js` (or wherever the create flow paints its
  status), `web/listing-readiness.js` (the copy for the create state), `gather/app.js` (the claim
  notice)
- Modify: `web/help/guide.md`, `web/help/whats-new.md`
- Test: `proxy/test/save-queue.test.js` and `proxy/test/listing-readiness.test.js` (the pure parts),
  plus a new pure `noticeText` in `web/listing-readiness.js` with tests

**Interfaces:**
- **Saving.** `DB.update`, `DB.remove` and the Worker-route calls return `overlaid`.
  - `saveQueue`'s write is `r.overlaid ? Promise.resolve() : applied(...)`.
  - `trackWorkerWrite` with `overlaid: true` skips `applied`.
  - `pendingFor` is then false as soon as the request returns.
- **Creating** still goes through `trackCreate` / `afterCreate`, so it waits, as today. The
  status line shows exactly *Creating the event in Mission Control — this takes about half a
  minute.* **immediately**. The event is read-only until the row exists.
- **Notices.** While any of the user's writes in this session returned `overlaid: true` and
  aren't known to be applied, poll `GET /me/writes` every 15 s. Stop when both lists are empty.
  `noticeText({op, columns, state}) -> string` gives:
  - unconfirmed: `Still confirming your change to <fields>…`
  - lost cell edit: `Your change to <fields> didn't save.`, with **Try again**
    (re-sends the user's values) and **Dismiss**
  - lost create or delete: `This change didn't save. Check the event.`, with **Dismiss** only
- **gather.** For a lost claim, show `Your sign-up didn't save — try again.` with the sign-up
  button.
- **Help.** Saves are instant. Explain *Creating the event…*, *Still confirming…* and
  *didn't save*. Add a dated `whats-new` line.

- [ ] **Step 1: Write the failing tests.**
  - The queue resolves without polling when `overlaid: true`. When `overlaid: false` it polls
    (**Review Focus 2**).
  - `noticeText` gives each exact string above.
  - Lost create or delete has no "Try again" (**Review Focus 5**).
  - The create state's status copy is the exact hint (**Review Focus 3**).
- [ ] **Step 2: Run them.** They should fail.
- [ ] **Step 3: Implement.** `web/*.js` stays at or under 800 lines.
- [ ] **Step 4: Run** the tests, `./scripts/check.sh` and
  `node scripts/check-help.mjs --branch HEAD`. All should pass.
- [ ] **Step 5: Commit** as `feat(app): edits save instantly; new events say they take half a minute`.

### Task 7: Decisions and project rules

**Files:** `docs/decisions/0012-write-through-overlay.md` (new), `0005-*.md`, `0008-*.md`,
`docs/decisions/README.md`, `CLAUDE.md` (non-negotiable #5 and the "never act on a read right
after a write" constraint), `docs/GLOSSARY.md` (overlay, unconfirmed, lost), `docs/app-map.md`
(the save model), `docs/deployment.md` (the DO binding and migration, the free-plan DO limits,
and the reminder to run `wrangler deploy --dry-run`).

- [ ] **Step 1:** Write 0012 and amend 0005 and 0008 to the spec's §4 wording. Update
  `CLAUDE.md` to match: "Saved" = accepted and overlaid (or applied when the overlay is
  unavailable), and "reads through the Worker see the Worker's writes; Coda-side readers still
  lag ~28 s".
- [ ] **Step 2:** Run `./scripts/check.sh`. It should pass. Commit as
  `docs: the write-through overlay`, then open PR 3.
