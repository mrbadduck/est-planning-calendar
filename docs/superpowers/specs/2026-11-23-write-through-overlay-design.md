# Design — Write-through overlay for Coda's apply delay

**Status:** design. Nothing built. Revised 2026-11-23 after the wise-up review
(`docs/superpowers/plans/2026-11-23-write-through-overlay.wise/ruling.md`).
**Date:** 2026-11-23.
**Decided with Eric:** Coda stays the source of truth; the ~28 s apply delay is fixed with a
Worker-side write-through overlay (2026-11-20, after weighing D1-as-truth with a Coda pack
sync table and Supabase). Decision 0005 already named this as the intended fix ("fast writes
in the Worker, not weakening this rule").
**Builds on:** PR #40 (Eventbrite sync) and PR #41 (Google Calendar); stacked on #41.

## 1. Why

Coda accepts a write at once but applies it ~28 s later, whatever the doc size (0008). Every
read through the Worker in that window returns the old row. That one fact drives:

- the app's **Saving… → Still saving…** wait of up to two minutes on every edit (0005), and
  Approve → Add to Eventbrite waiting ~28 s because the Worker reads the Status from Coda;
- gather showing a member's claim as missing after a reload, papered over with a second cache
  bust 28 s later (PR #40, Task 6b);
- several KV markers in the Eventbrite and Calendar sync (`eb-row:importing`, `ebpending:`,
  calendar tombstones) whose job is to cover reads that can't yet see a write.

**The fix:** the Worker remembers every write it sends to Coda until Coda has applied it (and
briefly after), and lays those remembered writes over every read it serves. Coda keeps the data;
the Worker only covers the gap.

**Success:**
- A lead's edit shows as saved within about a second, and every app-facing and lead route that
  reads through the Worker sees it straight away (Approve → Add to Eventbrite included).
- A member's gather claim shows on reload at once.
- A new event says at once that it takes about half a minute, and stays editable meanwhile.
- If Coda ever fails to apply a write, the person who made it is told through the failure UI the
  app already has; nothing pretends.

## 2. Goals, non-goals, anti-goals

**Goals**
1. Read-your-writes for every Worker read of the tables the Worker writes from app and lead
   routes: planning events, slots, claims, venues.
2. "Saved" in the app means: Coda accepted the write **and** the overlay holds it, so every read
   through the Worker returns it. Shown within ~1 s. **Creating a new event is the exception**:
   it still waits for Coda to create the row (§3.4), says so at once, and stays editable.
3. A write Coda doesn't apply is surfaced through the existing channel (`/mutation` →
   **Save failed — retry** or the existing toasts), never silently dropped.
4. Stay on the Cloudflare free plan and inside each invocation's 50-call budget.

**Non-goals**
- Making Coda's own UI, formulas, metrics or pack syncs see writes sooner. Coda-side readers keep
  the ~28 s lag.
- **The sync runners, for now.** `eb-sync-run.js` and `gcal-run.js` keep reading and writing
  Coda directly, `SWEEP_MAX_EVENTS` stays 8, and the existing markers (`ebpending:`,
  `eb-row:importing`, calendar tombstones) stay. They already cover the runners' read-after-write
  cases, so wiring the runners changes no outcome now. **Follow-up** (`docs/roadmap.md` "Next"):
  the runners read through the overlay and the markers retire, after first verifying whether
  Durable Object calls count toward the 50 subrequests.
- Writes made directly in Coda by people. They aren't the Worker's, so the overlay doesn't know
  them; they appear when Coda applies them, as today.
- People and Programs tables (gather's find-or-create of a person already has its own cache
  path; leave it).
- Upserts with `keyColumns` (the Eventbrite import): Coda returns no row id, so they keep the
  `importing` marker.

**Anti-goals (failure even if it works)**
- The overlay becoming a second source of truth: anything that lives only in the overlay past
  Coda's apply, or that a Coda-side edit can't override within ~30 s of the apply.
- Showing "Saved" for a write Coda never applies, with no one told.
- A second failure-reporting system beside the one the app has.
- An overlay outage making the app stop working. If the overlay is off or can't be reached, the
  Worker falls back to today's behaviour (wait for Coda to apply), says so in the log, and never
  drops the write.
- Breaking the free-plan call budgets the sweeps were tuned to.

## 3. How it works

### 3.1 Where the overlay lives
A **Cloudflare Durable Object** (`WriteOverlay`), one global instance (`idFromName('overlay')`),
with its own SQLite-backed storage. Durable Objects give strongly consistent read-your-writes
from any location, which KV can't (KV can lag ~60 s between locations). SQLite-backed Durable
Objects are on the Workers free plan (verify the plan's DO request and storage limits at build
time and note them in `docs/deployment.md`).

The class is **fetch-style**: a `fetch()` handler with three JSON paths and an `alarm()`. It
imports nothing from `cloudflare:workers`, so the node tests that import `worker.js` keep
working. The logic lives in a plain class (`OverlayCore(storage, env, fetch, now)`) that the
tests drive directly.

| path | body | answer |
|---|---|---|
| `POST /record` | `{entries}` | `{ok:true}` |
| `POST /read` | `{tableId}` | `{entries}` (every stored entry for the table, with state) |
| `POST /status` | `{requestId}` | `{state: 'pending'\|'applied'\|'failed'\|null}` |

**Kill switch:** `OVERLAY_MODE = "off" | "live"` in `wrangler.toml` (default `off`, matching
`EB_SYNC_MODE` and `GCAL_MODE`). With `off`, nothing calls the DO: writes return
`overlaid: false`, reads are unchanged and `/mutation` goes straight to Coda. Eric flips it to
`live` after merge. Rollback is `off`, then if needed a `[[migrations]] tag = "v2"
deleted_classes = ["WriteOverlay"]` deploy (recipe in `docs/deployment.md`; a plain revert
can't remove a DO class).

### 3.2 What an entry holds

| field | meaning |
|---|---|
| `tableId` | Coda table id |
| `rowId` | Coda row id (for inserts, the id Coda returns) |
| `key` | the column key **as the write used it**: a name (`'Status'`) or an id (`'c-…'`); `''` for a whole-row delete |
| `keying` | `'name'` or `'id'`, per cell (`/^c-/` is an id) |
| `value` | the cell value as written (`null` for a cleared cell) |
| `op` | `set` \| `insert` \| `delete` |
| `requestId` | Coda's mutation id from the 202 |
| `writtenAt` | Worker clock, ms |
| `state` | `pending` \| `applied` \| `failed` |
| `appliedAt` | when Coda reported it applied |

Entries are stored as written because the planning seam is name-keyed end to end: the app
writes `{column: 'Status'}`, the Worker adds `'Edited by'` and friends by name, and some Worker
writes mix names and ids in one request. Slots, claims and venues are id-keyed on both sides.
There is no `actorId`: nothing reads it (§3.6).

### 3.3 Writes
Every Worker write to the four tables from app and lead routes goes through one helper,
`codaWrite(env, {url, method, body, tableId, op, rowId?, auth})`:
1. Send the write to Coda as today.
2. On 2xx with the overlay on, record its cells (one DO call).
3. Return Coda's result plus `overlaid: true`.

If step 2 fails, or the overlay is off, or Coda returned no `requestId`, return
`overlaid: false`; the app then waits for Coda to apply, as today (`waitApplied`). The write is
never lost: Coda has it.

- **Insert:** Coda returns `addedRowIds`; the overlay records the new row's cells under that id,
  so reads include the row before Coda applies it.
- **Delete:** recorded as `op: delete`; reads drop the row until Coda applies the delete.
- **The notes-doc button** isn't overlaid: Coda runs the button and writes the result, so there
  is nothing the Worker wrote.

### 3.4 Creating an event still waits, and says so (Eric, 2026-11-23)
Coda answers "not found" to any write on a row it hasn't created yet (an edit, Approve, the notes
doc button, a push). So a **new event** keeps today's wait for Coda to apply the insert; the
overlay is not turned into a write queue. What changes:
- The Create toast reads `Creating… this takes about half a minute`.
- The panel's primary (the in-card button on a computer, `#epPhoneBar` on a phone) reads
  **Creating… (about half a minute)** until the insert applies. A named label like this never
  turns into **Still saving…**.
- The `Created` toast moves to when the insert actually applies. Today it fires on the 202,
  before the row exists, which contradicts 0005.
- **The event stays editable.** Edits made meanwhile queue behind `afterCreate`, as today, and go
  out once the row exists; from then on they are overlaid and instant. guide.md's "keep adding
  details whenever you like" stays true.

gather never creates planning rows. A member's new claim is an insert into Claims and is overlaid
like any insert.

### 3.5 Reads
Every Worker read of the four tables from app and lead routes merges the overlay before using or
returning rows: `overlayRead(env, tableId, rows, {shape, snapshotAt, now})`, one DO call, then a
pure `mergeRows`:
- `set` entries replace the cell (newest `writtenAt` wins when several touch one cell);
- `insert` entries add the row if Coda's read doesn't have it yet;
- `delete` entries remove the row.

**Age-aware merge.** Which entries count depends on how old the data under them is:
- a `pending` entry is merged while `now - writtenAt < 120 s`;
- an `applied` entry is merged while `snapshotAt < appliedAt + APPLY_MARGIN_MS`, with
  `APPLY_MARGIN_MS = 30_000`;
- a `failed` entry is never merged.

`snapshotAt` is the KV snapshot's `at` for cached reads (`swrGetAt` returns `{data, at}`), and
`now` for fresh Coda reads (`?fresh=1`, single-row reads). This is what makes cached reads safe:
`swrGet` serves `/rows` and the gather snapshot for up to 5 min, so a snapshot taken before the
apply still gets the write merged however late it is served, and one taken comfortably after the
apply doesn't, so a later Coda-side edit shows. The 30 s margin covers Coda's own read replicas
after `completed`, which are unmeasured; a wider margin is harmless because an applied entry's
value equals Coda's. There is no fixed grace and no cache bust on apply.

**Gather's snapshot holds raw rows.** Today the gather KV value is `gatherSnapshot(...)`: already
filtered to published/approved-upcoming events and grouped by parent id, so no merge on top of it
can restore a just-approved event or place a new claim. It becomes `{events, slots, claims}` raw
rich rows under a **new key** (`gather-snap-v2`, so an old-shape value is never read). At serve
time the Worker runs `overlayRead` on each list, then `gatherSnapshot`, then the existing
filters. `buildMyClaims` and the roster merge their raw lists the same way.

**The claim 409.** `/claims/:id` reads the claim for ownership before an edit or remove. That read
goes through the overlay. If the claim exists only as a pending insert, the route answers 409
`Your sign-up is still being saved. Try again in a few seconds.` (Coda would 404 the write anyway,
and the wording matches the app's existing "still being saved" message.)

### 3.6 Read shapes
Written values and read values differ: relations are written as row ids but read as display
names (`simpleWithArrays`) or `{rowId, name}` (rich); text comes back fenced in rich reads; times
come back as ISO strings; and keys may be names or ids. The merge converts each entry to the
reader's format:
- **Keys:** used as is when the entry's `keying` matches the reader's; otherwise translated
  through a column map. Only one reader/writer pair crosses the seam (the app's name-keyed
  planning writes read by gather's id-keyed rich read, plus the Worker's own mixed writes), so the
  `{id ↔ name}` map exists **for the planning table only**: KV-cached, refreshed from one
  `/columns?limit=200` call at most hourly, and counted in the calling route's budget. A key the
  map doesn't know marks the row `stale` and leaves Coda's cell.
- **Relations:** ids → names via caches the Worker already keeps (the People slim cache, `/ref`
  programs, venues and venue types); KV reads, not Coda calls. An id missing from the cache marks
  the row `stale` and leaves Coda's cell. Before relying on this, the builder checks one real
  Leads cell's display value against the People cache's `name` (read-only) and records the
  result in the PR.
- Rich reads get `{rowId, name}`; text and times are produced in the reader's format by the same
  helpers that parse them today. `venueType` is added to `PLANNING_COLS`.
- **Formula, lookup and button columns and the row's display name aren't overlaid.** Nothing in
  the publish route or the readiness checks reads them.

`stale` is internal to the Worker. A publish, cancel or unpublish route whose row read is `stale`
answers 409 `Your last update is still being saved. Try again in a few seconds.` (text the app
already shows). `/rows` never returns `stale` to the app; the app's own local copy covers a blip
(§3.8).

### 3.7 Clearing and failure: one channel
The DO's **alarm** runs every ~5 s while anything is `pending`:
- it polls Coda's `mutationStatus` for up to 10 pending requestIds per run, oldest first;
- `completed` → `state = applied`, `appliedAt = now`;
- not applied within **120 s** (the same deadline as the app's `waitApplied`) → `state = failed`.
  The overlay stops merging it, and it is no longer polled;
- every entry is deleted `KEEP_MS = 5 min + 30 s` after it applied (or, unapplied, after it was
  written). Nothing in the overlay outlives ~5.5 min.

The alarm makes no cache bust and writes no Publish Log record.

**`/mutation/:id` asks the overlay first.** The app already polls `GET /mutation/:id` through
`CodaApplied.waitApplied` to confirm a write. For an overlaid write, the route answers from the
DO with no Coda call: `pending` → `{completed:false}`, `applied` → `{completed:true}`, `failed` →
`{completed:false, failed:true}`. On a miss (overlay off, or not an overlaid write) it falls
through to Coda as today. `waitApplied` treats `failed` as its existing rejection. The route
keeps its `canWrite` gate; gather doesn't use it (it holds its own changes locally with
`rememberOp`).

**What the person sees.** Nothing new. A failure shows as the pill's **Save failed — retry**
(an unconfirmed create), the save.js:128 toast (`Your last change to “…” didn’t save — open it
and make the change again`), or the Worker-write toast, reworded to drop "Coda":
`The change didn't confirm. Check again in a minute.` There is no per-person notice route, no
poller, no unconfirmed/lost states and no new failure copy.

### 3.8 What changes in the app
- **Save path.** `DB.update`, `DB.create`, `DB.remove` and the Worker-route calls return
  `overlaid`. When `overlaid: true`, the save queue resolves at once and `applied()` runs in the
  background (not counted in `pendingFor`), reporting a failure through the existing toasts.
  `overlaid: false` keeps today's wait. **Saving…** shows only for the round trip (~1 s);
  **Still saving…** only in the fallback.
- **Local copy.** `_recent` is held until the background confirm settles, so if a read hits a DO
  blip (rows unmerged) the calendar doesn't revert a change shown as saved.
- **Transitions.** `transitionTo` skips the wait after the Status write when it was overlaid, so
  Approve → Add to Eventbrite is instant. `settledForPush` needs no logic change: `pendingFor`
  drops once the request returns.
- **Create.** As §3.4.
- **Venues.** **Save address** is a plain cell edit: when overlaid, the dialog closes at once.
  **Add venue** keeps its wait, because a new venue has to be created before an event can use it
  (its id isn't in the name caches until Coda applies it). Help says so in one plain line.
- **Copy.** `SLOW_TIP` becomes `This is taking longer than usual; your change is safe`. No other
  new on-screen text beyond §3.4's. No "Mission Control" on screen.
- **gather** drops the "bust again after 28 s" workaround (`bustEventCachesNowAndAfterApply`).
- **Help ships with it**, in each PR: saves are instant, a new event takes about half a minute
  (in `[[ ]]` so the guard protects it), **Still saving…** now means something is slow, Add venue
  still waits. The Eventbrite and Calendar timing lines stay as they are (the markers are
  unchanged).
- `CLAUDE.md` non-negotiable #5 and its "never act on a read right after a write" constraint are
  updated in the same branch to match 0005/0012, with a sibling rule: every Worker write to the
  four tables goes through `codaWrite`, every read through `overlayRead` (sync runners
  allowlisted until the follow-up). `scripts/check.sh` enforces it.

## 4. Decision records
- **0012 — Write-through overlay:** the DO; entries as written plus `keying`; the age-aware
  merge; `failed` at 120 s through `/mutation`; `OVERLAY_MODE`; creates still wait; Add venue
  still waits; runners deferred; and the rejected alternative (§7).
- **0005 amended:** "Saved" means Coda accepted the write and every read through the Worker
  returns it (overlay), or, when the overlay is off or unavailable, that Coda applied it. Failed
  applies are shown, never hidden. Status → "amended by 0012".
- **0008 amended:** Status changes; "reads right after a write can miss it" becomes "Worker reads
  don't; Coda-side readers and the sync runners still do"; the proposed fast-writes line becomes
  "Adopted: see 0012".

## 5. Constraints the builder must hold
- Free plan; each invocation stays ≤ 50 outbound calls. Count each DO call as one until the
  deferred check settles it. App and lead routes add +1 per write and +1 per read, plus at most
  one hourly `/columns` call for the planning column map: far under 50. The DO alarm is its own
  invocation and polls at most 10 requestIds. The sweeps are untouched.
- Coda stays the source of truth (0001): an applied entry merges only into snapshots older than
  `appliedAt + 30 s`; nothing outlives ~5.5 min.
- Every app and lead read path of the four tables goes through `overlayRead`, and every write
  through `codaWrite`: `/rows`, the single-row reads in `/rows` DELETE, publish, cancel,
  unpublish and the Eventbrite status/preview routes, the gather snapshot and its builds,
  `buildMyClaims`, the roster, `/claims/:id`, `/slots`, `/venues`, `/ref/venues`. A
  `scripts/check.sh` rule flags direct Coda writes and reads of those tables outside the helpers,
  with an explicit allowlist (`eb-sync-run.js`, `gcal-run.js`, the notes-doc button).
- Entries stored as written, with a `keying` tag; only the planning table gets a column map.
- Tests with stubbed Coda and a stubbed Durable Object; the merge is a pure function.

## 6. Order of work
Two PRs, stacked on #41. Help and docs ship in each.
1. **PR A — a lead's save is instant.** The DO (fetch-style, `OVERLAY_MODE` off), the merge, the
   helpers and the planning column map, DO-first `/mutation`; the planning routes and their row
   reads; the app save path, transitions, the create hint and copy; help, decisions, project docs
   and the `check.sh` rule. End to end and demonstrable once `OVERLAY_MODE = live`.
2. **PR B — gather and venues.** The raw-row gather snapshot (new key), claims and slots, the
   `/claims/:id` 409, removing the double bust, venues (Save address instant, Add venue waits),
   with their help and doc lines.

The sync runners are a later follow-up (§2).

## 7. Calls made (check these)
- Durable Object rather than D1 or KV (consistency; one global instance is plenty for EST's write
  volume).
- `APPLY_MARGIN_MS = 30 s` after apply, measured against the snapshot's age; 120 s to declare a
  write `failed` (matches today's `waitApplied`); 5.5 min keep.
- Upserts with `keyColumns` aren't overlaid (Coda returns no id); the existing import marker stays.
- People/Programs left out.
- If the overlay is off or unreachable, fall back to today's wait rather than failing the save.
- **Rejected alternative: "stop holding Saving… for plain edits, and wait only at steps that read
  the row", without an overlay.** It would make plain edits feel fast with no new machinery,
  since leads already see their own changes locally. It was rejected because it doesn't give
  gather reloads read-your-writes, and it doesn't make Approve → Add to Eventbrite instant: the
  Worker reads Coda, so those steps would still wait ~28 s. Both are in the core outcome ("every
  Worker read sees the Worker's writes"). Eric chose the overlay on 2026-11-20.
- **Still cut:** D1 or Supabase as truth, a Coda pack sync table, a write queue to make creates
  instant, `/me/writes` and the unconfirmed → lost notice ladder.
