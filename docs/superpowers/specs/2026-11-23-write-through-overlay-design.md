# Design — Write-through overlay for Coda's apply delay

**Status:** design. Nothing built.
**Date:** 2026-11-23.
**Decided with Eric:** Coda stays the source of truth; the ~28 s apply delay is fixed with a
Worker-side write-through overlay (2026-11-20, after weighing D1-as-truth with a Coda pack
sync table and Supabase). Decision 0005 already named this as the intended fix ("fast writes
in the Worker, not weakening this rule").
**Builds on:** PR #40 (Eventbrite sync) and PR #41 (Google Calendar); stacked on #41.

## 1. Why

Coda accepts a write at once but applies it ~28 s later, whatever the doc size (0008). Every
read through the Worker in that window returns the old row. That one fact drives:

- the app's **Saving… → Still saving…** wait of up to two minutes on every edit (0005);
- gather showing a member's claim as missing after a reload, papered over with a second cache
  bust 28 s later (PR #40, Task 6b);
- several KV markers in the Eventbrite and Calendar sync (`eb-row:importing`, `ebpending:`,
  calendar tombstones) whose job is to cover reads that can't yet see a write.

**The fix:** the Worker remembers every write it sends to Coda until Coda has applied it, and
lays those remembered writes over every read it serves. Coda keeps the data; the Worker only
covers the gap.

**Success:**
- A lead's edit shows as saved within about a second, and every screen, route and sync job that
  reads through the Worker sees it straight away.
- A member's gather claim shows on reload at once.
- If Coda ever fails to apply a write, the person who made it is told; nothing pretends.

## 2. Goals, non-goals, anti-goals

**Goals**
1. Read-your-writes for every Worker read of the tables the Worker writes: planning events,
   slots, claims, venues.
2. "Saved" in the app means: Coda accepted the write **and** the overlay holds it, so every read
   through the Worker returns it. Shown within ~1 s. **Creating a new event is the exception** — it
   still waits for Coda to create the row (§3.3a), with an immediate hint saying so.
3. A write Coda doesn't apply is surfaced to the person (and logged), never silently dropped.
4. Stay on the Cloudflare free plan and inside each invocation's 50-call budget.

**Non-goals**
- Making Coda's own UI, formulas, metrics or pack syncs see writes sooner. Coda-side readers keep
  the ~28 s lag.
- Removing the existing sync markers (`ebpending:`, `eb-row:importing`, calendar tombstones).
  They stay for now; simplifying them on top of the overlay is a follow-up.
- Writes made directly in Coda by people. They aren't the Worker's, so the overlay doesn't know
  them; they appear when Coda applies them, as today.
- People and Programs tables (gather's find-or-create of a person already has its own cache
  path; leave it).

**Anti-goals (failure even if it works)**
- The overlay becoming a second source of truth: anything that lives only in the overlay past
  Coda's apply, or that a Coda-side edit can't eventually override.
- Showing "Saved" for a write Coda never applies, with no one told.
- An overlay outage making the app stop working. (If the overlay can't be reached, the Worker
  falls back to today's behaviour — wait for Coda to apply — and says so in the log; never
  silently drops the write.)
- Breaking the free-plan call budgets the sweeps were tuned to.

## 3. How it works

### 3.1 Where the overlay lives
A **Cloudflare Durable Object** (`WriteOverlay`), one global instance (`idFromName('overlay')`),
with its own SQLite storage. Durable Objects give strongly consistent read-your-writes from any
location, which KV can't (KV can lag ~60 s between locations). SQLite-backed Durable Objects are
on the Workers free plan (my call; verify the plan's DO request and storage limits at build time
and note them in `docs/deployment.md`).

One table:

| column | meaning |
|---|---|
| `table_id` | Coda table id |
| `row_id` | Coda row id (for inserts, the id Coda returns; see 3.3) |
| `col_id` | Coda column id (`''` for a whole-row delete) |
| `value` | JSON cell value as written (`null` for a cleared cell) |
| `op` | `set` \| `insert` \| `delete` |
| `request_id` | Coda's mutation id from the 202 |
| `written_at` | Worker clock, ms |
| `state` | `pending` \| `applied` \| `failed` |
| `applied_at` | when Coda reported it applied |
| `actor_id` | the person, for failure notices |

### 3.2 Writes
Every Worker write to the four tables goes through one helper,
`codaWrite(env, ctx, {tableId, op, rowId?, cells, actorId, keyColumns?})`:
1. Send the write to Coda as today.
2. On 2xx, record it in the overlay with Coda's `requestId` (one Durable Object call).
3. Return `{ok, requestId, overlaid: true}`.

If step 2 fails (overlay unreachable), return `overlaid: false`; the app then falls back to
waiting for Coda to apply, as today (`waitApplied`). The write itself is never lost — Coda has it.

**Batching for sweeps (call budget):** the Eventbrite and Calendar sweeps collect their overlay
records and send them in one Durable Object call at the end of the run (the same pattern as the
batched Publish Log). Lead routes and app saves record each write immediately.

### 3.3 Inserts and deletes
- **Insert:** Coda returns `addedRowIds` (without `keyColumns`); the overlay records the new row's
  cells under that id, so reads include the row before Coda applies it. With `keyColumns` (the
  Eventbrite import's upsert) Coda returns no row id; those keep the existing `importing` marker
  and are not overlaid (non-goal above).
- **Delete:** recorded as `op: delete`; reads drop the row until Coda applies the delete.

### 3.3a Creating an event still waits (Eric, 2026-11-23)
Coda answers "not found" to any write on a row it hasn't created yet (an edit, Approve, the notes
doc button, a push). So a **new event** keeps today's wait for Coda to create the row before it is
saved and editable — the overlay is not turned into a write queue. What changes is the **hint**:
the moment a lead creates an event, the status line says *"Creating the event in Mission Control —
this takes about half a minute."* (shown immediately, not after a timeout), and the event opens
read-only with that line until the row exists. Edits after that are instant. gather never creates
planning rows; a member's new claim is an insert into Claims and is overlaid like any insert
(nothing else writes to a claim row in that window).

### 3.4 Reads
Every Worker read of the four tables merges the overlay before using or returning rows:
`overlayRead(env, tableId, rows, {keying: 'id'|'name'})` — one Durable Object call returning all
`pending` and recently `applied` entries for that table, then a pure merge:
- `set` entries replace the cell (newest `written_at` wins when several touch one cell);
- `insert` entries add the row if Coda's read doesn't have it yet;
- `delete` entries remove the row;
- for name-keyed reads, column ids map to names through the table's column list (already cached
  by the Worker for the notes-doc column; reuse it).

This includes the KV-cached `/rows` and gather snapshot: the cache holds Coda's view, and the
overlay is merged on top at serve time, so a cached snapshot never hides a recent write. Cache
busting on write stays as it is.

The Coda `query` lookups (the Eventbrite webhook's single-row lookup) merge too: overlay inserts
whose cells match the query are added.

### 3.4a Read shapes (my call)
Written values and read values differ: relations are written as row ids but read as display
names (`simpleWithArrays`) or `{rowId, name}` (rich); text comes back fenced in rich reads; times
come back as ISO strings. The overlay stores the cell **as written** and the merge converts it to
the reader's format:
- relations → names via caches the Worker already keeps (the People slim cache, `/ref` programs,
  venues and venue types) — KV reads, not Coda calls, so no budget cost; an id missing from the
  cache falls back to waiting (the read reports it as `stale` and callers that act on it — the
  publish route, transitions — wait for that row to apply, as today);
- rich reads get `{rowId, name}`; text and times are produced in the reader's format by the same
  helpers that parse them today;
- **formula, lookup and button columns and the row's display name aren't overlaid.** Nothing in the
  publish route or the readiness checks reads them; anything that does keeps waiting.
So the publish route and transitions stop waiting **for the columns the overlay can fill**; a push
straight after a venue change sees the new venue name.

### 3.5 Clearing
The Durable Object's **alarm** runs every ~5 s while anything is `pending`:
- polls Coda's `mutationStatus` for each pending `request_id` (batched, a few per alarm);
- `completed` → `state = applied`, `applied_at = now`;
- an entry stays visible for **60 s after applied** (covers KV-cached reads and Coda's own read
  replicas), then is deleted;
- if it isn't applied within **120 s**, the entry becomes `unconfirmed` (my call — Coda has no
  failure state, and a write can still apply late). It **stays merged** until Coda applies it or
  10 minutes pass; if it applies late, the notice clears itself. After 10 minutes unapplied it stops
  being merged and the notice says the change didn't save.
- when an entry applies, the alarm also busts the `/rows` and gather KV snapshots, so a snapshot
  read before the apply can't outlive the 60 s grace.

The overlay never holds anything longer than ~3 minutes. Once an entry is gone, Coda's own data —
including any later edit made in Coda by a person — is what every read returns.

### 3.6 What the person sees when Coda is slow or doesn't apply (my calls)
- **Only the person who made the change is told.** Notices never go in shared responses (`/rows`
  and the gather snapshot are cached and shared). A signed-in route, `GET /me/writes`, returns that
  person's `unconfirmed` and lost entries; the app polls it while any of its own saves are
  unconfirmed. gather members are signed in for claims, so the same route serves them.
- **Unconfirmed (120 s–10 min):** "Still confirming your change to <fields>…" — no action.
- **Lost (10 min):** "Your change to <fields> didn't save. [Try again] [Dismiss]". *Try again*
  re-sends the cell edit (safe to repeat). **No Try again for creates or deletes** — the notice says
  to check the event, like today's `retryCreateConfirm` rule (never risk a duplicate row).
- Each lost write also writes a Publish Log record (`action: overlay-lost`).

### 3.7 What changes in the app
- `web/data.js` save path: when a write returns `overlaid: true`, it's saved — no `waitApplied`.
  `overlaid: false` keeps today's wait.
- **Saving…** shows only for the round trip (~1 s); **Still saving…** only in the fallback.
- Transitions and the Eventbrite push no longer need to wait for pending saves to apply, because
  the Worker's reads now see them (they still wait for in-flight requests to return).
- gather drops the "bust again after 28 s" workaround.
- Help ships with it: saves are instant; what "Still confirming" and "didn't save" mean.
- `CLAUDE.md` non-negotiable #5 and its "never act on a read right after a write" constraint are
  updated in the same branch to match 0005/0012.

## 4. Decision records
- **0012 — Write-through overlay** (Durable Object; what it holds; clearing; failure surfacing;
  fallback).
- **0005 amended:** "Saved" means Coda accepted the write and every read through the Worker
  returns it (overlay), or — when the overlay is unavailable — that Coda applied it. Failed
  applies are shown, never hidden.
- **0008 amended:** consequences now point at 0012.

## 5. Constraints the builder must hold
- Free plan; each invocation stays ≤ 50 outbound calls. **Durable Object calls count as
  subrequests** (my understanding; verify). Budget impact:
  - lead routes and app saves: +1 per write, +1 per read — far under 50;
  - Eventbrite sweep: +1 read, +1 batched record → its worst case (48) would reach 50, so
    `SWEEP_MAX_EVENTS` drops from 8 to 7;
  - Calendar sweep: +2 (worst ~41).
- Coda stays the source of truth (0001); nothing outlives Coda's apply by more than the 60 s grace.
- Every Worker read path of the four tables goes through `overlayRead`; a review checklist lists
  them (`/rows`, `/rows/:id`, gather snapshot and its builds, `/venues`, `/ref/venues`, roster,
  the Eventbrite runner's row reads and query, the Calendar runner's reads, the publish/cancel/
  unpublish/delete routes' row reads).
- Column ids, not names, inside the overlay.
- Tests with stubbed Coda and a stubbed Durable Object; the merge is a pure function.

## 6. Order of work
1. The Durable Object, its storage, alarm and the pure merge (no wiring).
2. `codaWrite` + `overlayRead`, wired into app-facing routes (`/rows`, venues, gather claims and
   slots); app save path; failure banner; help.
3. Wire the sync runners and lead routes (batched for sweeps; `SWEEP_MAX_EVENTS` → 7).
4. Remove gather's double bust; decision records.
Each step its own PR, stacked.

## 7. Calls I made (check these)
- Durable Object rather than D1 or KV (consistency; one global instance is plenty for EST's
  write volume).
- 60 s grace after applied; 120 s to declare a write failed (matches today's `waitApplied`).
- Upserts with `keyColumns` aren't overlaid (Coda returns no id); the existing import marker stays.
- People/Programs left out.
- If the overlay is unreachable, fall back to today's wait rather than failing the save.
