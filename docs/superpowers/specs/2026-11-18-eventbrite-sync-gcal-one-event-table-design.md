# Design — Eventbrite sync, gCal from the Worker, one event table

**Status:** design, for Eric's review. Nothing here is built.
**Date:** 2026-11-18.
**Covers:** steps 2 and 6 of the end-state proposal
(`2026-11-14-events-people-comms-end-state-design.md` §5, §4, §8), plus a new
requirement: events built directly on Eventbrite flow into plan.
**Inputs:** the end-state proposal; the read-only survey of Mission Control
(2026-11-18; consumer list reproduced in Appendix A); the Worker as merged in
#35–#39.

## 1. Why, and why now

The plan app isn't fully rolled out. Some people still build events directly on
Eventbrite, and those events never show up in plan or gather: nothing flows from
Eventbrite to the planning table. Eric can't stop people using Eventbrite, so this
route has to keep working as long as EST uses Eventbrite.

At the same time the backend has two event tables (`EST Planning Events SRC` and
`EST Events SRC`), two systems creating gCal events (the forgotten EST Zapier Zap and
Coda's Daily Event Freshen Up), and importer buttons nobody presses any more: 8
Eventbrite events since Oct 2026 have no `EST Events SRC` row, so recent metrics are
already incomplete. Eric wants the backend cleaned up, not just patched.

**Success:**
- Every EST Eventbrite event, however it was made, is a planning row within minutes,
  manageable in plan and visible in gather, as if it had been built in plan and pushed.
- A change made on Eventbrite shows up in plan (and so on gCal and gather) on its own.
- The Worker is the only thing that writes EST's Google Calendar.
- `EST Planning Events SRC` is the one event table, renamed `EST Events`. Every
  metric, People formula and workflow that read `EST Events SRC` reads it instead,
  with the same numbers. `EST Events SRC` is frozen as `EST Events (legacy)`.

## 2. Goals, non-goals, anti-goals

**Goals**
1. Import: any EST Eventbrite event without a planning row gets one, automatically.
2. Flow-in: edits made on Eventbrite update the planning row automatically.
3. gCal: the Worker creates, updates and removes gCal events, keyed by a stored id.
   The Zap and Freshen Up are switched off.
4. One table: backfill the 238 historical events, repoint every consumer, retire the
   importers, freeze the old table.

**Non-goals**
- People, Mailchimp, comms (steps 3–5, 7). Nothing here touches Mailchimp.
- Filling in programs and leads for imported events. Eric does that in a manual
  cleanup sweep in Coda. **The plan app does not flag events missing a program or lead.**
- Tickets and discount codes as a plan-app feature (pinned for later). The Coda
  discount workflow is repointed, not redesigned.
- The gather Profile & Preferences page (its own spec; decisions in memory).

**Anti-goals (failure even if it works)**
- Matching records by searching names or descriptions. Every link is by a stored id
  (Eventbrite event id, gCal event id, Coda row id).
- Two writers for one thing: after cutover, nothing but the Worker writes gCal, and
  nothing but the Worker creates planning rows from Eventbrite.
- An Eventbrite read silently wiping a value a lead set in plan (the Capacity wipe,
  F11, that led to decision 0006).
- Metrics that quietly change during the move. Every repointed consumer is checked
  against its old value before the next one moves.
- Duplicate planning rows from a webhook and the sweep racing (Coda applies writes
  ~28 s after accepting them, decision 0008).

## 3. Decided with Eric (2026-11-18)

1. **Eventbrite-built events backfill into plan as if built in plan and pushed**, and
   are managed in plan from then on.
2. **The Eventbrite-direct route is permanent.** The import runs continuously, not as
   a one-off bridge.
3. **Changes made on Eventbrite flow into plan automatically.** This replaces decision
   0006 (see §5.3 for the safeguards).
4. **No in-app flag for missing program/lead.** Eric sweeps them in Coda.
5. **The plan includes the full collapse:** backfill, repoint every consumer, freeze
   `EST Events SRC`, rename the planning table to `EST Events`.
6. **Coda-side changes are listed first** (Appendix A). Who applies them (Claude via
   the API with Eric's OK per change, or Eric by hand) is decided per phase after
   Eric reads the list.

## 4. Shape of the work

Four parts, built in this order, each shippable alone:

| Part | What | Depends on |
|---|---|---|
| **A. Import + flow-in** | Worker: Eventbrite webhook + hourly sweep → create or update planning rows | new planning columns (§8.1) |
| **B. gCal from the Worker** | Worker: insert/patch/delete gCal by stored id; cutover from Zap + Freshen Up | A (imported events need gCal too) |
| **C. Backfill** | One-time script: 238 `EST Events SRC` rows → planning rows | A's mapping functions; Eric's duplicate pass |
| **D. Repoint + retire** | Coda: recreate metric hooks on the planning table, repoint ~50 consumers, retire importers, freeze + rename | C |

**No Worker-made twin rows (my call).** The end-state proposal's stage 1 had the
Worker create an `EST Events SRC` twin for every published event, to keep metrics
alive during the move. Since this plan goes all the way to one table, twins would be
throwaway code. Instead: backfill first (C), then repoint (D). Until D lands, Eric can
keep pressing the old importer buttons if he wants metrics current; nobody presses
them today anyway.

## 5. Part A — Eventbrite → plan

### 5.1 Triggers
- **Webhook:** register an Eventbrite webhook (org-level, EST org `1080997994263`) for
  `event.created`, `event.published`, `event.updated`, `event.unpublished` to
  `POST /webhooks/eventbrite/<secret>` on the Worker.
  - Eventbrite webhooks are not signed. The Worker trusts nothing in the body: it
    takes only the `api_url`, checks it's an Eventbrite event URL, and fetches the
    event itself with its own token, then checks `organization_id` is EST's. The
    secret path segment (Worker secret `EB_WEBHOOK_SECRET`) keeps random traffic out.
  - It answers 200 fast and does the work in `ctx.waitUntil`.
- **Hourly sweep (my call: hourly, not nightly — cheap, and bounds how stale a missed
  webhook can leave things):** a Worker cron lists EST's Eventbrite events changed
  recently (`/organizations/{org}/events/?order_by=...`, paging, plus every event
  starting from 30 days ago onward) and runs each through the same handler. Eventbrite
  events don't carry webhooks for every change (ticket edits, for instance), so the
  sweep is also the backstop for flow-in.
- **Registering the webhook is a live Eventbrite change**: Eric's OK, done once, and
  recorded in `docs/deployment.md`.

### 5.2 One handler, keyed by Eventbrite event id
`syncEbEvent(ebEvent)`:
1. Find the planning row whose `Eventbrite Event ID` equals the event's id.
2. **None → import** (§5.4). **One → flow-in** (§5.3). More than one → log a Publish
   Log error, change nothing.
3. **Racing the ~28 s apply wait:** a fresh insert isn't readable yet, so a webhook
   right behind it would import twice. The Worker keeps a KV marker
   `eb-row:<ebId> → rowId` (TTL 1 h) written at insert and checked before step 1.
   The insert also uses Coda's upsert (`keyColumns: [Eventbrite Event ID]`) as a
   second guard.
4. **Our own pushes come back as webhooks.** While a plan push for that row is in
   flight (the existing `ebPending` KV marker), the handler skips it. After the push,
   the snapshot matches Eventbrite, so §5.3 finds nothing changed.
5. Every import and every flow-in writes a Publish Log row
   (`action: import | flow-in`, fields changed, `actor: eventbrite`), busts
   `ROWS_KV_KEY`, and never throws past the log.

### 5.3 Flow-in (edits on Eventbrite → planning row)
**This replaces decision 0006** with a new decision record (0009, "Eventbrite edits
flow into plan, field by field"). The safeguards:

- **Only fields changed on Eventbrite are copied.** For each synced field, compare the
  live Eventbrite value with the row's `Last EB pushed values` snapshot. Equal → the
  field wasn't touched on Eventbrite → leave the row alone. Different → copy the live
  value onto the row and into the snapshot.
- **The snapshot records what Eventbrite holds, not what we sent (my call).** After
  every push (and every import or flow-in), the Worker re-reads the event and stores
  Eventbrite's own values, normalized. Eventbrite rewrites description HTML, so
  comparing with what we sent would see phantom edits.
- **Never overwrite an unpushed plan edit (my call).** If the row's value differs from
  the snapshot too (a lead changed it in plan and hasn't pushed), keep plan's value,
  don't touch the snapshot for that field, and raise the existing "changed on
  Eventbrite" conflict notice for the lead. Rare in practice.
- **Synced fields:** title, date, start, end (wall clock in `America/Chicago`), capacity,
  public description (as plain text, like today's editor), venue (§5.5), online vs.
  in person, publish state (draft → On Eventbrite, live → Published, canceled →
  Status Cancelled, ended/completed → left to the app's Past logic).
- **Not synced:** the public summary (Eventbrite doesn't return it reliably; plan
  owns it), tickets and price (pinned feature), address visibility (plan owns it; it
  decides which Eventbrite venue we push).
- **Repeating events (series) (my call):** Eventbrite series have a parent with no single
  date and one child per occurrence, each with its own id. The handler imports each
  **occurrence** as its own planning row and ignores the parent (`is_series_parent`). Plan
  already treats every date as its own event. An edit to the series shows up as edits to
  each occurrence, which flow in one by one.
- **Eventbrite deletes an event:** the row is marked `Publish status = Removed from
  Eventbrite` and the Eventbrite id kept. Nothing is deleted.

### 5.4 Import (new planning row)
The row looks as if a lead had built it in plan and pushed it:

| Planning column | Value |
|---|---|
| Title, Date, Start, End, Capacity, Public description | from Eventbrite |
| Status | `Approved` (or `Cancelled` if canceled on Eventbrite) |
| Publish status | draft → `On Eventbrite`, live/started/ended → `Published` |
| Eventbrite Event ID, Eventbrite URL, Eventbrite Ticket Class ID | from Eventbrite |
| Venue / Venue (other) | §5.5 |
| Address visibility | `Public` if the event shows a full address, else `Registrants only` |
| Last EB pushed values, Last EB push at | the snapshot of what Eventbrite holds (so every field shows "matches Eventbrite") |
| **Source** (new) | `Eventbrite` |
| Program(s), Leads, Volunteers, Approved by | blank (Eric's sweep) |
| Created by | blank; the app shows "Imported from Eventbrite" instead of a name |

Imports include drafts: a draft on Eventbrite is the "On Eventbrite" stage in plan.

### 5.5 Venue matching
By stored id only: `EST Venues SRC` already caches each venue's Eventbrite venue ids
(`Eventbrite Venue ID`, `Eventbrite Private Venue ID`). An Eventbrite venue id that
matches → that venue. No match → `Venue (other)` gets the Eventbrite venue's name and
address as text, and Eric's sweep links it. Never match venues by name.

### 5.6 What leads see (help ships with it)
- Imported events show "Imported from Eventbrite" where the creator's name would be.
- When a change flowed in, the status panel says "Updated from Eventbrite: start
  time, capacity" with the time (from the Publish Log), until the next edit in plan.
- Events built on Eventbrite now appear in plan and gather. Help: a short guide
  section on "events made on Eventbrite" and a dated `whats-new.md` line.

## 6. Part B — Google Calendar from the Worker

### 6.1 Access
A Google Cloud **service account** owned by EST, with the *East Side Tribe Events*
calendar shared to it ("Make changes to events"). Its key is a Worker secret
(`GOOGLE_SA_KEY`), the calendar id a Worker var. The Worker signs an RS256 JWT with
WebCrypto and exchanges it for an access token (cached in KV, ~55 min). Setting this
up needs Eric (Google Cloud console, calendar sharing).

### 6.2 What goes on the calendar
A planning row is on gCal when **Status = Approved and it has a date** (not a month
idea or a date window), whether or not it is on Eventbrite (decided with Eric,
2026-11-19). That covers today's Zap + Freshen Up (Eventbrite events once live), the
manual "Create/Update gCal" button for events not on Eventbrite (OneTable potlucks,
retreats, 50+ dinners), and imported events.

- **Stored id, never searched:** a new text column `gCal Event ID` on the planning
  row. Insert writes it; update and delete use it.
- **Event contents:** title; start/end in `America/Chicago` (all-day when set);
  description = public summary, then the registration line, then the gather link.
  The registration line is the Eventbrite link once the event is Published; until then
  it reads "Registration on Eventbrite coming soon" (Eric, 2026-11-19), and it's
  replaced with the link on the next sync after publishing;
  location honors `Address visibility` (registrants-only → area only, the same rule
  as the Eventbrite venue).
- **When it syncs:** after every successful push or flow-in that changes a gCal field,
  and in the hourly sweep (which repairs drift and catches anything missed). Cancel
  or unpublish → delete the gCal event and clear the id (my call: delete, not
  "CANCELLED:" in the title; the Eventbrite page is where registrants learn about it).
- **Idempotent:** a patch with the same values is harmless. A stored id that 404s
  (someone deleted it in Google) → recreate and log it.
- Each gCal write logs to the Publish Log (`action: gcal-insert | gcal-patch | gcal-delete`).

### 6.3 Cutover without duplicates
1. **Link existing gCal events by stored id.** For upcoming events, the old tables
   already hold the gCal event id: `EST Events SRC` → `gCal Event Id`, and Events
   EVENTBRITE → `gCal Event`. A one-time script copies those ids onto the matching
   planning rows (matched by Eventbrite id). Rows with no known gCal id are listed
   for Eric, not guessed.
2. **Shadow mode.** Worker var `GCAL_MODE = off | shadow | live`. In shadow the Worker
   computes every insert/patch/delete and writes it to the Publish Log without calling
   Google. Run a week; Eric compares it with what the Zap and Freshen Up did.
3. **Switch over on one day, in this order:** Eric turns off the EST Zapier Zap
   "New Event EB→GCal" (and deletes its Eventbrite webhook) and the Coda rule "Daily
   Event Freshen Up"; then `GCAL_MODE = live`; then the sweep's first run fills in any
   gaps. The 4 known orphan gCal events (audit) are deleted by hand.
4. The gCal buttons (Create/Update gCal Event, Freshen Up, Create/Update gCal on
   `EST Events SRC`) are retired in Part D.

## 7. Part C — Backfill the history

A script in `scripts/` (Node, like the venues backfill): **dry run by default**,
`--apply` to write, `--only <rowId>` for one row, resumable, logs each row.

1. **Unmatched past Eventbrite events are reported, not imported.** The dry run lists
   every org event that started before today and has no `EST Events SRC` row (`EST
   Events SRC` is the source of truth for the past), for Eric to match up first.
2. **Before it runs, Eric resolves the duplicates** the survey found: L'chaim Time
   12/2/2025 (two rows, one Eventbrite id) and the doubled Littles Shabbat Jan–Jun 2026
   series (5/9 and 6/13 each have two non-cancelled rows). The script refuses to run
   while two `EST Events SRC` rows share an Eventbrite id.
3. **One planning row per `EST Events SRC` row.** Rows with an Eventbrite id go through
   Part A's import mapping (Eventbrite data), then the legacy fields are layered on.
   The 67 rows without Eventbrite use legacy fields only.
4. **Rows already in plan** (the 2 linked ones, and any planning row with the same
   Eventbrite id, including events Part A has imported since it went live) are
   updated, not duplicated: legacy fields fill blanks only.
5. **Field mapping:**

| `EST Events SRC` | Planning row |
|---|---|
| Event Name | Title (strip the "(M/D/YYYY)" suffix Eventbrite-imported names carry) |
| Event Date (for Metrics) | Date |
| Event Start / Event End | Start / End (time part) |
| Program(s), Leads, Volunteers, Collaborators | same (multi relations) |
| Venue | Venue (first one); any others go into **Additional venues** (3 rows: Channukah Bonfire(s) '20 at four houses, The Sabbath Dance, Leadership Retreat Dec '24) |
| Cancelled? | Status = `Cancelled`; otherwise `Approved` |
| Event Description | Event Description |
| Num Attendees (Manual Override), Banner Image Override, Registration URL Override, Event Photos | new columns of the same names |
| gCal Event Id | gCal Event ID |
| row id | **Legacy EST Events row** (the existing `Linked EST Events SRC row`, renamed) |
| — | Source = `Backfill` |

6. **Leads are approximate** (they were defaulted from the program's leads at the
   time). They are carried over as they are; Eric's sweep corrects them.
7. **Verification:** after `--apply`, the script compares counts by year, cancelled,
   with/without Eventbrite against the survey numbers (238 rows; 171 with Eventbrite;
   20 cancelled) and lists every mismatch.

## 8. Part D — One table: repoint and retire

### 8.1 New columns on the planning table
- Data: `Source` (select: Plan / Eventbrite / Backfill), `gCal Event ID`,
  `Additional venues` (→ EST Venues SRC, multi; history only, for real multi-location
  events, not shown in the app — Venue stays single so the app, the Eventbrite push and the
  address rules don't change; agreed with Eric 2026-11-19),
  `Collaborators` (→ EST Collaborators SRC, multi), `Num Attendees (Manual Override)`,
  `Banner Image Override`, `Registration URL Override`, `Event Photos`.
  (`Source` and `gCal Event ID` are needed by Part A/B, so they land first.)
- **`Eventbrite Event` becomes a formula** keyed by the stored id:
  `[Events EVENTBRITE].Filter([Eventbrite Id] = thisRow.[Eventbrite Event ID]).First()`.
  Today it's a hand-set lookup the Worker never fills. A formula means a new event
  links itself as soon as the pack sync sees it.
- Metric hooks recreated as formulas, same names as on `EST Events SRC` so consumers
  repoint with a table swap: `Event Date (for Metrics)` (= Date), `Eventbrite Event All
  Orders`, `Eventbrite Event Num Tickets` and `Num Orders` (with the manual-override
  fallback), `Eventbrite Ticket Revenue`, `Num First Timers`, `First Timers EST`,
  `Collab Event`, `Min Leadership Wave`, `Banner image`, `Event Discount Config`
  (reverse lookup), `Metrics Reporting Periods` (reverse lookup), `Cancelled?`
  (= Status is Cancelled).
- The Pre-/Post-Event Slack Reminder buttons move to the planning table unchanged.

**What counts as an event for metrics (my call).** `EST Events SRC` only ever held
events that happened or were cancelled; the planning table also holds drafts, proposals
and Eventbrite drafts. So the recreated `Cancelled?` hook is not enough. A new formula
column **`Counts for Metrics`** is true when Status = `Approved` **and** either Publish
status is `Published` or the event has no Eventbrite listing. Drafts, Proposed rows,
Eventbrite drafts that never went live, and cancelled events are excluded. Every repointed
consumer filters on `Counts for Metrics` where it used to filter on `Cancelled? != true`.
Backfilled rows all satisfy it (Approved, and Published if they had Eventbrite), so the
numbers match the old table.

Column ids for the new columns go into `proxy/src/coda-columns.js`; new Worker code
references them by id.

### 8.2 Repoint, in this order, verifying each
**Part D is written as a checklist (my call).** Much of it — formula columns, views,
canvas controls, buttons, rules — the Coda API can't change, so each step gives the exact
new formula or action, and the verification script runs between steps. Whoever applies a
step (Claude through the API where it can, with Eric's OK; Eric by hand otherwise), the
order and the checks are the same.

Consumers are listed in Appendix A. Order:
1. **Metric hooks on the planning table** (§8.1), checked against `EST Events SRC`
   row by row for the backfilled events (tickets, orders, revenue, first timers).
2. **People, Venues, Programs, Collaborators** formulas (A.1–A.12).
3. **Events EVENTBRITE / Events GCAL / Mailchimp** reverse links (A.21, A.23, A.24, A.26).
4. **Quarterly Metrics** `Events EST` (A.13) and everything below it.
5. **Discount workflow** (A.27–A.36, A.38, A.43–A.45): repoint the two hand-entered
   lookups by mapping each old row id to its new planning row (via `Legacy EST Events
   row`); repoint the select controls (their options formula isn't in the API: by
   hand in Coda).
6. **Views and dashboards** (A.40, A.46–A.52). The website view is retired.

**Verification is a script, not eyeballing.** Before step 1, a read-only snapshot
script records every consumer's current values (each Quarterly Metrics row's numbers,
each person's and program's counts and dates, each venue's) to a JSON file. After each
repoint step it re-reads and diffs. Expected differences are only: (a) the 8 Oct
2026+ events that `EST Events SRC` is missing (they now count), and (b) duplicates Eric
removed in Part C. Anything else stops the move.

### 8.3 Retire
- Importers: "Add EST Event" on Events EVENTBRITE and Events GCAL, the canvas button
  "Add EST Events from Eventbrite", and the two "w/out EST event" to-do views.
- gCal: Create gCal Event, Update gCal Event, Freshen Up (Events EVENTBRITE),
  Create/Update gCal (`EST Events SRC`), the "EST Event -> gCal Sync" page. The Coda gCal
  pack sync stays only while something still reads Events GCAL (Event list for grant
  app does).
- JFed: "Add/Update JFed Cal" button and its killswitch control (retired 2026-11-14).
- Before freezing, open the two Coda rules the survey couldn't read ("Event Planning
  Reminders", the monthly Slack rule) and repoint them if they read `EST Events SRC`.

### 8.4 Freeze and rename
`EST Events SRC` → `EST Events (legacy)`, locked. `EST Planning Events SRC` →
**`EST Events`**. Table ids don't change, so the Worker is unaffected; docs, glossary
and `wrangler.toml` comments are updated. (The planning seam's name-keyed columns are
unaffected by a table rename; id-hardening stays a separate task.)

## 9. Decision records
- **0009 — Eventbrite edits flow into plan, field by field** (supersedes 0006).
- **0010 — The Worker is the only gCal writer**, by stored id.
- **0011 — One event table** (`EST Events`), with the backfill and the legacy table.
Glossary: `Source`, imported event, flow-in, legacy EST Events row.

## 10. Constraints the builder must hold
- Coda applies writes ~28 s after accepting them (0008): no read-after-write without
  the KV marker or a wait.
- Every Worker route that changes planning rows busts `ROWS_KV_KEY`.
- New code references Coda columns by id (`coda-columns.js`).
- `web/*.js` ≤ 800 lines; `worker.js` is 1,591 lines already, so new Worker code goes in
  new modules (`eb-sync.js`, `gcal.js`) with pure, unit-tested functions.
- No live writes (Coda, Eventbrite, Google) from a session without Eric's OK; scripts
  dry-run by default; no Worker deploys from a session.
- Help ships in the same branch for anything a lead can see.

## 11. Answered (Eric, 2026-11-19)
- **Events not on Eventbrite go on gCal** once approved, with "Registration on Eventbrite
  coming soon" until they're published (§6.2).
- **Every EST Eventbrite event is in EST's org** (`1080997994263`); no other org needs
  covering. The import takes everything in it.
- **For the past, `EST Events SRC` is the source of truth.** Every past Eventbrite event
  should match an `EST Events SRC` row. The backfill's dry run lists any past org event with
  no matching row, for Eric to match up; it never imports those into history on its own.
  The hourly sweep only looks at events from 30 days ago onward, so it can't pull old
  unmatched events in either.
- **Nothing reads the "EST Events for Website" view any more.** The website embeds the gCal
  view now (a "gather-y" replacement comes later). The view is retired (A.49), and the
  banner/registration-override columns are still carried over as data.
- Who applies each Coda change is decided per step; Part D is a checklist either way (§8.2).

## Appendix A — Coda changes (every consumer of `EST Events SRC`)

From the read-only survey on 2026-11-18. Full detail (formulas, ids):
`docs/superpowers/specs/2026-11-18-est-events-src-consumers.md`.

**Direct references**
| # | Table | Column / object | Change |
|---|---|---|---|
| A.1 | EST People SRC | Events Led EST | Filter `EST Events` by Leads |
| A.2 | EST People SRC | Events Volunteered EST | Filter `EST Events` by Volunteers |
| A.3 | EST People SRC | Events Hosted | follows Venues A.5 (no edit) |
| A.4 | EST People SRC | Last Host Date | follows A.3 (no edit) |
| A.5 | EST Venues SRC | EST Events | Filter `EST Events` by Venue **or** Additional venues (keeps every host's hosting history) |
| A.6 | EST Venues SRC | Last Event Date | follows A.5 |
| A.7 | EST Programs SRC | EST Events | Filter `EST Events` by Program(s) |
| A.8–A.11 | EST Programs SRC | Last/Next Event Date, Avg Tickets (12 mo, last 5) | follow A.7 (same column names on the new table) |
| A.12 | EST Collaborators SRC | Collab EST Events | Filter `EST Events` by Collaborators |
| A.13 | Quarterly Metrics SRC | Events EST | Filter `EST Events` by date, not cancelled, past |
| A.14–A.20 | Quarterly Metrics SRC | Total Orders, Collab Events, 3rd Wave Led, Total Tickets, Registrants, First Time Registrants, Ticket Sales Revenue | follow A.13 |
| A.21 | Events EVENTBRITE | EST Event | Filter `EST Events` by `Eventbrite Event ID` = this event's id |
| A.22 | Events EVENTBRITE | Add EST Event (button) | retire |
| A.23 | Events EVENTBRITE | EST Program(s) | follows A.21 |
| A.24 | Events GCAL | EST Event | Filter `EST Events` by `gCal Event ID` |
| A.25 | Events GCAL | Add EST Event (button) | retire |
| A.26 | Mailchimp Audience SRC | Events Led | follows A.1; already broken (points at missing gCal columns) — fix or drop |
| A.27 | Member Discount Codes SRC | EST Event (data lookup, 154 rows) | retarget to `EST Events`; remap each row via Legacy EST Events row |
| A.28–A.33 | Member Discount Codes SRC | Generate Discount, Code, Discount URL, Event Discount Config, Event Name, Send Member Email | follow A.27 (`Event Name` → `Title`) |
| A.34 | Event Discount Config SRC | Event (data lookup, 8 rows) | retarget + remap like A.27 |
| A.35–A.36 | Event Discount Config SRC | Config Name, Generate Codes | follow A.34 |
| A.37 | EST Planning Events SRC | Linked EST Events SRC row | rename `Legacy EST Events row` (backfill writes it) |
| A.38 | Eventbrite page | control "event for discount code sync" | options → `EST Events` (by hand) |
| A.39 | EST Events SRC | Pre-/Post-Event Slack Reminder, Create/Update gCal | Slack buttons move (§8.1); gCal button retired |
| A.40 | Events page | view "EST Event Details & Metrics" | recreate on `EST Events` |
| A.41 | Data Management Workflows | button "Add EST Events from Eventbrite" | retire |
| A.42 | Data Management Workflows | views "Eventbrite/gCal events w/out EST event" | retire |
| A.43 | Member Discount Codes page | control "event for discount codes" | options → `EST Events` (by hand) |
| A.44 | same page | buttons Generate Discount Codes, Send All Emails, add discount config | follow A.43 |
| A.45 | same page | views filtered by the control | follow A.43 |
| A.46 | Metrics | view "EST Events Metrics" + Quarterly Metrics views | recreate the first; the rest follow A.13 |
| A.47 | Metrics Sandbox | 2 charts on EST Events SRC | recreate or drop |
| A.48 | Metrics Sandbox | People view | follows A.2/A.3 |
| A.49 | Toolbox | view "EST Events for Website" | retire (nothing reads it; the website embeds gCal) |
| A.50 | EST Event -> gCal Sync | view with Create/Update gCal | retire |
| A.51 | Discord Reminders | view of EST Events SRC | recreate or drop |
| A.52 | Data Management Workflows | View 3 of EST Events SRC | drop |

**Second-order** (change with the above, no edit): People Num Events Led / Volunteered /
Hosted / combined, EST Program(s) Attended; Programs Num Events, Orders EVENTBRITE, Total
Orders, Distinct Registrants; every derived Quarterly Metrics column; Mailchimp Num Events
Led, Led Event IDs; Event Discount Config Member Discount Codes, Email Preview.

**Unread:** Coda rules "Event Planning Reminders" and the monthly Slack rule (check in
Automations before the freeze).

**Retire outside Coda:** the EST Zapier Zap "New Event EB→GCal" and its Eventbrite
webhook (at the gCal switch-over, §6.3).
