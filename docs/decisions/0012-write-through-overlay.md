# 0012 — A write-through overlay covers Coda's apply delay

**Date:** 2026-11-23 (chosen with Eric 2026-11-20; PR A) · **Status:** in force; ships
with `OVERLAY_MODE = "off"` until Eric flips it · **Amends:**
[0005](0005-saved-means-applied.md), [0008](0008-coda-apply-latency.md)

## Context

Coda accepts a write at once and applies it ~28 s later ([0008](0008-coda-apply-latency.md)).
Every read through the Worker in that window returns the old row. So every edit waited up to
half a minute on **Saving…** ([0005](0005-saved-means-applied.md)), and Approve → Add to
Eventbrite waited too, because the Worker reads the Status from Coda.

## Decision

The Worker remembers each write it sends to Coda until Coda has applied it (and briefly
after), and lays those writes over the reads it serves. Coda keeps the data
([0001](0001-coda-source-of-truth.md)); the overlay only covers the gap.

- **Where it lives.** One SQLite-backed Durable Object, `WriteOverlay`
  (`proxy/src/overlay-do.js`, binding `OVERLAY`, `idFromName('overlay')`). It is
  fetch-style (`POST /record`, `/read`, `/status`, plus `alarm()`) and imports nothing from
  `cloudflare:workers`, so the node tests that import `worker.js` keep working. The logic is
  `OverlayCore`, which the tests drive directly.
- **Entries are stored as written.** One entry per cell: `tableId`, `rowId` (for an insert,
  the id Coda returned in `addedRowIds`), `key` (the column as the write named it, `''` for a
  whole-row delete), `keying` (`'id'` when the key starts `c-`, else `'name'`), `value`,
  `op` (`set` | `insert` | `delete`), `requestId`, `writtenAt` (Worker clock), `state`
  (`pending` | `applied` | `failed`) and `appliedAt`. The DO refuses a malformed batch whole.
  Only the planning table has an id ↔ name map (`planningColMap`: one
  `/columns?limit=200` call, KV-cached for an hour, which also gives each column's kind);
  slots, claims and venues are id-keyed on both sides.
- **Writes** go through `codaWrite` (`proxy/src/worker-io.js`): send to Coda as before, then,
  on a 2xx with the overlay on, record the cells (one DO call) and return `overlaid: true`.
  A reply with no `requestId`, a mismatched `addedRowIds` count or a failed record call
  gives `overlaid: false` with one console line; an upsert with `keyColumns` (Coda returns
  no row id) is never overlaid. Either way the app waits for the apply, as before, and the
  write is never lost: Coda has it.
- **Reads** go through `overlayRead`, which calls the pure `mergeRows`
  (`proxy/src/overlay.js`): `set` replaces the cell (newest `writtenAt` wins), `insert` adds a
  row Coda's read doesn't have yet, `delete` drops the row. Each value is shaped for the
  reader: relation ids become display names from the Worker's KV caches (People, programs,
  venues, venue types), times and dates become Coda's ISO forms, and rich text is fenced. A
  cell that can't be translated, a calculated or unknown column, or a missing name keeps
  Coda's value and marks the row `stale`. A publish, cancel, unpublish or `/rows` DELETE whose
  row is stale answers 409 *Your last update is still being saved. Try again in a few
  seconds.* So does one that can't reach the overlay while the app says it still holds
  unconfirmed changes to that event (`unconfirmed`).
- **The merge is age-aware.** A `pending` entry merges for `FAIL_AFTER_MS` (120 s) after it
  was written. An `applied` entry merges only into a snapshot taken before
  `appliedAt + APPLY_MARGIN_MS` (30 s): a cached `/rows` snapshot passes its own `at`, and a
  fresh Coda read the time just before it read (`snapshotAt`). A `failed` entry never merges. There is no fixed grace and no cache
  bust on apply. The 30 s margin covers Coda's read replicas after `completed`, which are
  unmeasured; a wider margin is harmless because an applied entry's value equals Coda's.
- **Clearing and failure.** While anything is pending, the DO's alarm runs every 5 s
  (`ALARM_EVERY_MS`) and asks Coda's `mutationStatus` about up to 10 requestIds
  (`POLLS_PER_ALARM`), oldest first: `completed` → `applied`; still not applied at 120 s →
  `failed`. Every entry is deleted `KEEP_MS` (5 min + 30 s, `swrGet`'s 5 min hard limit plus
  the margin) after it applied or, unapplied, after it was written. Nothing outlives ~5.5 min.
  The alarm busts no cache and writes no Publish Log record.
- **One failure channel.** `GET /mutation/:id` asks the DO first (no Coda call):
  `applied` → `{completed: true}`, `pending` → `{completed: false}`, `failed` →
  `{completed: false, failed: true}`. When the DO has no record (overlay off, or a write
  that wasn't overlaid) it asks Coda, as before. The app's `waitApplied` treats `failed` as
  its existing "save not confirmed". The route keeps its `canWrite` gate.
- **"Saved"** means Coda accepted the write and the overlay holds it, or, when the write
  wasn't overlaid, that Coda applied it (0005 as amended). An overlaid edit's confirm runs in
  the background (`confirmLater` in `web/save.js`); if it fails, the edit goes back to
  **Save failed — retry**, or, with the event closed, the app puts the field back and says
  so. A transition that fails late is undone with a toast that names the step (unless a later
  transition has moved the event on). An Eventbrite step (add, update, publish, cancel,
  unpublish) that fails late keeps what Eventbrite did and says to check it again in a
  minute.
- **Creating an event still waits.** Coda answers "not found" to any write on a row it
  hasn't created, and the overlay is not a write queue. A new event's panel button reads
  **Creating… (about half a minute)** until the insert applies, then the app says
  “*title*” created. The event stays editable: edits queue behind the insert (`afterCreate`).
- **Add venue still waits** (PR B): a new venue has to be created before an event can use it.
- **The notes-doc button isn't overlaid.** Coda runs the button and writes the doc URL, so
  there is nothing the Worker wrote.
- **The sync runners are deferred.** `eb-sync-run.js` and `gcal-run.js` keep reading and
  writing Coda directly; `SWEEP_MAX_EVENTS` stays 8 and the `ebpending:`, `eb-row:importing`
  and calendar-tombstone markers stay. They already cover the runners' read-after-write
  cases. The follow-up is in `docs/roadmap.md` ("Next").
- **Kill switch.** `OVERLAY_MODE` in `proxy/wrangler.toml`: `off` (the default) makes no DO
  call: writes return `overlaid: false`, reads are unchanged and `/mutation` goes straight
  to Coda, which is today's behaviour. `live` turns it on. Rollback is in
  `docs/deployment.md` (a plain revert can't remove a Durable Object class).
- **Enforced.** `scripts/check.sh` rule 7 (`scripts/check-coda-paths.mjs`) flags a direct
  Coda write or read of the planning, slots, claims or venues tables outside the helpers,
  with an allowlist that gives a reason for each entry.

## Rejected

**Stop holding Saving… for plain edits, and wait only at the steps that read the row,
without an overlay.** It would make plain edits feel fast with no new machinery, since leads
already see their own changes locally. It doesn't give gather reloads read-your-writes, and
it doesn't make Approve → Add to Eventbrite instant: the Worker reads Coda, so those steps
would still wait ~28 s. Both are in the core outcome ("every Worker read sees the Worker's
writes"). Eric chose the overlay on 2026-11-20.

Also weighed and cut: Cloudflare D1 or Supabase as the source of truth, a Coda pack sync
table, a write queue to make creates instant, and a per-person notice route (`/me/writes`)
for unconfirmed or lost writes.

## Consequences

- With `OVERLAY_MODE = "live"`, a lead's edit shows as saved within about a second, and
  Approve → Add to Eventbrite doesn't wait for Coda. With it `off`, saves wait as before.
  Help is worded to be true either way.
- Coda-side readers (Coda's own UI, formulas, pack syncs) and the sync runners still see
  writes ~28 s late. Writes people make directly in Coda aren't the Worker's, so the overlay
  doesn't know them.
- Every app-facing route adds one DO call per write and one per read, plus the planning
  column map's hourly `/columns` call. Count each DO call as one of the 50 outbound calls an
  invocation allows until it is verified whether they count (`docs/deployment.md`).
- Gather, claims, slots, the roster and venues read and write through the helpers in PR B;
  until then rule 7 allowlists them ("PR B").
- Spec: `docs/superpowers/specs/2026-11-23-write-through-overlay-design.md`; plan:
  `docs/superpowers/plans/2026-11-23-write-through-overlay.md`.
