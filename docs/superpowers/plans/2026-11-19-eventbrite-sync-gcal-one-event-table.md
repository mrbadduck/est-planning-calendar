# Eventbrite sync, gCal from the Worker, one event table — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every EST Eventbrite event becomes a planning row and stays in step with
Eventbrite; the Worker becomes the only Google Calendar writer; the 238 historical
events move into the planning table and every Coda consumer of `EST Events SRC` is
repointed, so `EST Planning Events SRC` becomes the one table, `EST Events`.

**Architecture:** New Worker modules hold pure, unit-tested logic (`eb-sync.js`,
`gcal.js`, `google-auth.js`) and thin I/O runners (`eb-sync-run.js`, `gcal-run.js`).
Shared I/O helpers leave `worker.js` for `worker-io.js`. An Eventbrite webhook plus an
hourly cron feed one handler keyed by Eventbrite event id. Two Node scripts do the
one-time backfill and the before/after metrics check. Coda schema and formula changes
are a checklist, each gated on Eric's OK.

**Tech Stack:** Cloudflare Worker (ES modules, KV, cron triggers), Coda API v1,
Eventbrite API v3, Google Calendar API v3 with a service account (RS256 JWT via
WebCrypto), `node --test`, vanilla JS app (buildless).

**Spec:** `docs/superpowers/specs/2026-11-18-eventbrite-sync-gcal-one-event-table-design.md`
(+ the survey `docs/superpowers/specs/2026-11-18-est-events-src-consumers.md`).

## Global Constraints

- Coda applies writes ~28 s after accepting them (decision 0008): never act on a read right after a write without the KV marker or a wait.
- Every Worker route or job that changes planning rows busts `ROWS_KV_KEY`.
- New code references Coda columns by id via `proxy/src/coda-columns.js`; read rows id-keyed (`useColumnNames=false`).
- Nothing matches records by searching names or descriptions. Links are by Eventbrite event id, gCal event id, Coda row id, or stored Eventbrite venue id.
- `web/*.js` ≤ 800 lines; `proxy/src/worker.js` must not grow (it's 1,591 lines) — new Worker code goes in new modules.
- No live writes (Coda prod, Eventbrite, Google) and no Worker deploy from a session without Eric's OK; steps marked **🔒 Eric** need it. Scripts are dry-run by default; writing needs `--apply`.
- Timezone: `America/Chicago` (`env.EVENTBRITE_TZ`). EST Eventbrite org: `1080997994263` (`env.EVENTBRITE_ORG_ID`).
- Tests: one run machine-wide. Run only the touched specs, under the lock:
  `cd proxy && until mkdir /tmp/jest.lock 2>/dev/null; do sleep 5; done; trap 'rmdir /tmp/jest.lock' EXIT; node --test test/<file>.test.js`
- `./scripts/check.sh` passes before every commit. Help ships in the same branch for anything a lead can see (`web/help/guide.md` + a dated `web/help/whats-new.md` line, on-screen text in `[[ ]]`).
- Use the glossary's words. New terms (Source, imported event, flow-in, Legacy EST Events row, Counts for Metrics) go into `docs/GLOSSARY.md` in the branch that introduces them.
- Commits end with the two attribution lines from the session (Co-Authored-By, Claude-Session).

## Review Focus

1. **Our own push echoing back as a webhook** before Coda applies the new snapshot: must not copy anything onto the row (Task 6: skip while `ebPending` is set; Task 4: an echo whose values equal plan's is a no-op).
2. **Webhook and sweep (or `event.created` then `event.published`) racing inside the 28 s apply window:** exactly one planning row (Task 6: `eb-row:<ebId>` KV marker checked before the row lookup).
3. **Eventbrite's rewritten description HTML** after a push: must not register as an Eventbrite edit (Task 5: snapshot stores Eventbrite's normalized text).
4. **Series events and times near DST:** a series parent is ignored; each occurrence's date/start/end come from `start.local`/`end.local` unchanged (Task 3).
5. **A lead's unpushed edit and an Eventbrite edit to the same field:** plan's value stays, the field is reported as a conflict (Task 4).

---

## Phase A — Eventbrite → plan (branch `feat/eb-sync`, one PR)

### Task 1: Move the Worker's shared I/O helpers out of `worker.js`

**Files:**
- Create: `proxy/src/worker-io.js`
- Modify: `proxy/src/worker.js` (delete the moved definitions, import them)
- Test: `proxy/test/worker-io.test.js`

**Interfaces:**
- Produces (all exported from `worker-io.js`, behavior unchanged unless noted):
  `ROWS_KV_KEY`, `swrBust(env, key)`, `readAllRows(rowsUrl, auth, opts)`,
  `ebFetch(env, path, method?, body?, opts?)`, `readEbPending(env, rowId)`,
  `writeEbPending(env, rowId, marker)`, `codaRequestId(r)`,
  `logPublish(env, base, docId, auth, rec)`, and new pure
  `publishLogCells(rec, nowIso) -> Array<{column,value}>`.
- Change: `rec.target` (default `'Eventbrite'`) fills the `Target` cell; `rec.actorId`
  may be absent for system actions, and then `Message` is prefixed `"[eventbrite] "` or
  `"[sweep] "` from `rec.via`.

- [ ] **Step 1: Write the failing test** `publishLogCells` — `({action:'import', ok:true, ebId:'1', via:'eventbrite'}, '2026-11-19T00:00:00Z')` yields `Target`=`'Eventbrite'`, `Action`=`'import'`, `Result`=`'ok'`, `Message` starting `'[eventbrite] '`; with `target:'Google Calendar'` the `Target` cell is `'Google Calendar'`.
- [ ] **Step 2: Run it** — `node --test test/worker-io.test.js`. Expected: FAIL (module not found).
- [ ] **Step 3: Create `worker-io.js`** by moving the listed functions verbatim from `worker.js`; `logPublish` builds its cells with `publishLogCells`. `worker.js` imports them. No other change.
- [ ] **Step 4: Run** `node --test test/worker-io.test.js test/publish.test.js test/gather.test.js` — PASS; `wc -l proxy/src/worker.js` is smaller than 1,591; `./scripts/check.sh` passes.
- [ ] **Step 5: Commit** — `refactor(proxy): shared I/O helpers leave worker.js`.

### Task 2: New planning columns and their ids 🔒 Eric

**Files:**
- Modify: `proxy/src/coda-columns.js`
- Test: `proxy/test/coda-columns.test.js`

**Interfaces:**
- Produces `PLANNING_COLS` additions (existing columns, ids from the 2026-11-18 read):
  `capacity:'c-FtIEIv1oNF'`, `publishStatus:'c-Bppgu3CtFt'`, `ticketClassId:'c-_FdJ_-XX0_'`,
  `lastPublishedAt:'c-VQaRCCKLzX'`, `lastPublishError:'c-rIhvH9m_Y5'`,
  `eventDescription:'c-ZJO5Ge_PyI'`, `programs:'c-tHwtj89ksi'`, `leads:'c-92mRz-1SYp'`,
  `volunteers:'c-8_uS1RK9Qx'`, `legacyRow:'c-sUpvHhlGlI'`, `createdBy:'c-ueS3RrH9ie'`;
  and new columns: `source:'c-XNXXPfY74v'`, `lastFromEb:'c-b02zbLiHgk'` (created
  2026-11-22); `gcalEventId` (Phase B), `additionalVenues`, `collaborators`,
  `attendeesOverride`, `externalRegistrationUrl` (Phase C) get their ids when those columns
  are created. Banner Image Override and Event Photos are not carried over (spec §8.1).
- Also `LEGACY_EVENTS_TABLE = 'grid-9TAt5vMMKH'` and `LEGACY_COLS` for the columns the
  backfill reads (ids in the survey §1: name `c-YcC1vx5Ung`, eventbriteEvent `c-LvlbW7Fk28`,
  venue `c-qnAUWGhhWe`, collaborators `c-v8SaE7WTNb`, cancelled `c-kZqi1huBiz`,
  date `c-FNeOszspAw`, volunteers `c-K8QqK9dNsv`, leads `c-Gp18FBaE8q`,
  attendeesOverride `c-LHDV30AIeI`, eventbriteId `c-sLsqeZ0_zh`, gcalEventId `c-qFF9aveinM`,
  bannerOverride `c--RGP1jqmMp`, registrationUrlOverride `c-2-8FNMkNKQ`, programs `c-43WF5l9MHf`,
  start `c-Dx4hZN7o83`, end `c-0pwRaIBqeA`, eventDescription `c-veXmap6hVO`, photos `c-diN53OflnB`).

- [ ] **Step 1: 🔒 Eric — add to `EST Planning Events SRC`** (by hand or via the API with OK):
  `Source` (select: Plan, Eventbrite, Backfill; default Plan), `gCal Event ID` (text),
  `Last from Eventbrite` (text; Worker-written JSON `{at, fields}`) — **done 2026-11-22**.
  Later phases add `gCal Event ID` (B) and `Additional venues` (relation → EST Venues SRC,
  multi), `Collaborators` (relation → EST Collaborators SRC, multi),
  `Num Attendees (Manual Override)` (number), `External registration URL` (link) (C). Rename
  `Linked EST Events SRC row` → `Legacy EST Events row`. Add `Removed from Eventbrite` to
  `Publish status`'s options. Add `Google Calendar` to the Publish Log `Target` options.
  Read back the new ids with `table_columns_read`.
- [ ] **Step 2: Write the failing test** — every `PLANNING_COLS` and `LEGACY_COLS` value matches `/^c-[\w-]+$/` and no two keys share an id.
- [ ] **Step 3: Add the ids** to `coda-columns.js`, each commented with its column name.
- [ ] **Step 4: Run** `node --test test/coda-columns.test.js` — PASS.
- [ ] **Step 5: Commit** — `feat(proxy): column ids for Source, gCal Event ID and the one-table columns`.

### Task 3: Read an Eventbrite event into planning fields

**Files:**
- Create: `proxy/src/eb-sync.js`
- Test: `proxy/test/eb-sync.test.js` (fixtures inline)

**Interfaces:**
- Consumes: `normText`, `structuredContentText` from `eventbrite.js`.
- Produces:
  - `ebToFields(body, scBody) -> EbFields | null` where `body` is
    `GET /events/{id}/?expand=venue,ticket_classes` and `scBody` its structured content.
    `EbFields = { ebId, title, date:'YYYY-MM-DD', start:'HH:MM', end:'HH:MM', capacity:number|null,
    publicDescription:string, ebVenueId:string, online:boolean, ebStatus:string, changed:string,
    url:string, ticketClassId:string, venueText:string, hasStreetAddress:boolean }`.
    Returns `null` for a series parent (`is_series_parent === true`).
  - `ebStatusCells(ebStatus) -> { status?:'Approved'|'Cancelled', publishStatus:'Draft'|'Published'|'Cancelled', published:boolean }`.
  - `ebSnapshot(fields, keep) -> string` (JSON, same keys as `pushedValues` in `publish.js`,
    plus `ebChanged`): title/date/start/end/capacity/publicDescription from `fields`;
    publicSummary/venueName/addressVisibility/ticketClassId from `keep`.

- [ ] **Step 1: Write the failing tests:**
  - start.local `'2027-03-13T10:00:00'`, end.local `'2027-03-13T11:30:00'` → `date:'2027-03-13', start:'10:00', end:'11:30'` (also a fixture on 2026-11-01, the DST day, gives `'2026-11-01'`, `'18:00'`).
  - `is_series_parent:true` → `null`; a series child (`series_id` set, `is_series_parent:false`) → fields.
  - `capacity:null` with one ticket class `quantity_total:40` → `capacity:40`; with two classes → `capacity:null`.
  - `name.text` `'  Littles Shabbat '` → `title:'Littles Shabbat'`; description from structured content HTML `'<p>Hi&nbsp;there</p>'` equals `normText('Hi there')`.
  - `ebStatusCells`: `draft`→`{status:'Approved',publishStatus:'Draft',published:false}`; `live`,`started`,`ended`,`completed`→`{status:'Approved',publishStatus:'Published',published:true}`; `canceled`→`{status:'Cancelled',publishStatus:'Cancelled',published:false}`.
  - `ebSnapshot(fields,{publicSummary:'S'})` parses to an object with `publicSummary:'S'` and `ebChanged:fields.changed`.
- [ ] **Step 2: Run** `node --test test/eb-sync.test.js` — FAIL.
- [ ] **Step 3: Implement** the three functions in `eb-sync.js` (pure; no I/O, no DOM).
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** — `feat(proxy): read an Eventbrite event into planning fields`.

### Task 4: Decide an import or a flow-in

**Files:**
- Modify: `proxy/src/eb-sync.js`
- Test: `proxy/test/eb-sync.test.js`

**Interfaces:**
- Consumes: `EbFields`, `ebStatusCells`, `ebSnapshot` (Task 3); `PLANNING_COLS` (Task 2);
  a planning row as produced by `rowToListingEvent` (`publish.js`).
- Produces:
  - `SYNCED = ['title','date','start','end','capacity','publicDescription','venue','publishState']`.
  - `matchVenue(ebVenueId, venues) -> { venueRowId:string|null, addressVisibility:'Public'|'Registrants only'|'' }`
    where `venues` is `[{id, ebVenueId, ebPrivateVenueId}]`: a match on `ebVenueId` → Public,
    on `ebPrivateVenueId` → Registrants only, none → `{venueRowId:null}`.
  - `importCells(fields, venueMatch, nowIso) -> Array<{column,value}>` — the §5.4 table:
    Title, Date, Start, End, Capacity, Public description, Eventbrite Event ID/URL/Ticket Class ID,
    `ebStatusCells` values, Venue (row id) or Venue (other) = `fields.venueText`,
    Address visibility (from the match; unmatched → `'Public'` if `hasStreetAddress`, else `''`),
    Last EB pushed values = `ebSnapshot(fields, {addressVisibility})`, Last EB push at = `nowIso`,
    Source = `'Eventbrite'`, Scheduling = `'Exact'`.
  - `planFlowIn(rowEv, fields, venueMatch) -> { cells, changed:string[], conflicts:string[] }`.
    Per synced field: live = `fields` value, snap = `rowEv.pushed` value, plan = `rowEv` value.
    `live == snap` → skip. `live != snap && plan == snap` → write live to the row, record in `changed`.
    `live != snap && plan != snap && plan != live` → `conflicts`, don't write. `plan == live` →
    no row write. Every `changed` field also updates the snapshot (one `Last EB pushed values`
    cell carrying the merged snapshot) and adds `Last from Eventbrite` =
    `JSON.stringify({at:nowIso, fields:changed})`. Compare text with `normText`.
    `rowEv.pushed == null` (never pushed): treat `snap` as equal to `plan`.

- [ ] **Step 1: Write the failing tests:**
  - venue match: `ebPrivateVenueId` hit → `'Registrants only'`; no hit → `venueRowId:null`.
  - `importCells` for a live event contains `{column: PLANNING_COLS.source, value:'Eventbrite'}`, `Published?` true, `Publish status` `'Published'`, and never a Program(s), Leads or Created by cell.
  - flow-in, untouched in Eventbrite: snap.start `'18:00'`, live `'18:00'`, plan `'18:30'` → no cells, no conflict.
  - flow-in, edited in Eventbrite: snap `'18:00'`, plan `'18:00'`, live `'19:00'` → Start cell `'19:00'`, `changed:['start']`, snapshot start `'19:00'`.
  - **conflict (Review Focus 5):** snap `'18:00'`, plan `'18:30'`, live `'19:00'` → no Start cell, `conflicts:['start']`.
  - **echo (Review Focus 1):** snap `'18:00'`, plan `'19:00'`, live `'19:00'` → no Start cell, no conflict.
  - description `'<p>Hi there</p>'` live vs snap `'Hi there'` → unchanged.
  - Eventbrite `canceled` on a published row → Status `'Cancelled'`, `changed` includes `'publishState'`.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement** `matchVenue`, `importCells`, `planFlowIn`.
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** — `feat(proxy): import or flow-in decision for an Eventbrite event`.

### Task 5: The snapshot records what Eventbrite holds after a push

**Files:**
- Modify: `proxy/src/worker.js` (publish route, step 6 "success write-back", ~line 668)
- Modify: `proxy/src/publish.js` (new helper)
- Test: `proxy/test/publish.test.js`

**Interfaces:**
- Consumes: `ebToFields`, `ebSnapshot` (Task 3).
- Produces: `pushSnapshot(ev, fields, ticketClassId) -> string` in `publish.js`: when `fields`
  is non-null, `ebSnapshot(fields, {publicSummary:ev.publicSummary, venueName:ev.venueName,
  addressVisibility:ev.addressVisibility, ticketClassId})`; when `null` (the re-read failed),
  falls back to `pushedValues(ev, {ticketClassId})`.

- [ ] **Step 1: Write the failing tests** — `pushSnapshot` with fields whose `publicDescription` is Eventbrite's normalized text `'Hi there'` while `ev.publicDescription` is `'Hi  there\n'` stores `'Hi there'` (**Review Focus 3**); with `fields=null` it equals `pushedValues(ev,{ticketClassId})`.
- [ ] **Step 2: Run** `node --test test/publish.test.js` — FAIL.
- [ ] **Step 3: Implement** `pushSnapshot`; in the publish route, after publish succeeds, `GET /events/{id}/?expand=venue,ticket_classes` and its structured content via `ebFetch`, build fields with `ebToFields`, and write `pushSnapshot(...)` instead of `pushedValues(...)`. A failed re-read is not a push failure.
- [ ] **Step 4: Run** `node --test test/publish.test.js test/eb-sync.test.js` — PASS.
- [ ] **Step 5: Commit** — `feat(proxy): pushed snapshot holds Eventbrite's own values`.

### Task 6: Webhook, hourly sweep and the one handler

**Files:**
- Create: `proxy/src/eb-sync-run.js`
- Modify: `proxy/src/worker.js` (route `POST /webhooks/eventbrite/:secret`; `export default { fetch, scheduled }`)
- Modify: `proxy/wrangler.toml` (`[triggers] crons = ["7 * * * *"]`)
- Modify: `proxy/src/eb-sync.js` (pure helpers below)
- Test: `proxy/test/eb-sync.test.js`

**Interfaces:**
- Consumes: Task 1 helpers, Tasks 3–4 functions.
- Produces:
  - pure `parseEbWebhook(body) -> string|null`: returns the event id only when `api_url`
    matches `^https://www\.eventbriteapi\.com/v3/events/(\d+)/?$`; otherwise `null`.
  - pure `syncDecision({rowsWithId, markerRowId, pending}) -> 'skip'|'import'|'flowin'|'error'`:
    `pending` → skip; `markerRowId` or one row → flowin; none → import; more than one → error.
  - `syncEbEvent(env, ebId, via:'eventbrite'|'sweep') -> Promise<{action, rowId?, changed?, conflicts?}>`:
    fetch the event; drop it unless `organization_id === env.EVENTBRITE_ORG_ID`; skip series
    parents; find the row by `Eventbrite Event ID` (id-keyed read); apply `syncDecision`;
    import = upsert with `keyColumns:[PLANNING_COLS.eventbriteId]`, then KV
    `eb-row:<ebId>` → new row id (TTL 3600); flow-in = PUT the cells; bust `ROWS_KV_KEY`;
    `logPublish` with `action:'import'|'flow-in'|'conflict'`, `via`. Never throws.
  - `runSweep(env) -> Promise<{seen, imported, flowedIn}>`: page
    `/organizations/{org}/events/?order_by=start_desc&expand=venue,ticket_classes` and stop once
    `start.local` is more than 30 days before today; for each event whose `changed` differs from
    the row snapshot's `ebChanged` (or with no row), call `syncEbEvent(env, id, 'sweep')`.
  - An event Eventbrite answers 404 for (deleted there) → its row gets `Publish status =
    Removed from Eventbrite`, `Published?` false, Eventbrite id kept; logged `action:'removed'`.
    `runSweep` also GETs each upcoming row with an Eventbrite id that the listing didn't return,
    so deletions are caught without a webhook.
  - **Capped and resumable (stays inside the free plan's 50 outbound calls per run):** a run
    handles at most `SWEEP_MAX_EVENTS = 8` events that need work, then stores where it stopped in
    KV `eb-sweep-cursor` and exits; the next hourly run resumes there. Pure
    `sweepBatch(candidates, cursor, max) -> {batch, nextCursor}` picks the slice.
  - Worker var `EB_SYNC_MODE = off | live` (default `off`) gates both entry points.

- [ ] **Step 1: Write the failing tests** — a pure `removedCells()` returns Publish status `'Removed from Eventbrite'` and `Published?` false; `parseEbWebhook` accepts `{api_url:'https://www.eventbriteapi.com/v3/events/123/'}` → `'123'` and rejects any other host or a non-numeric id; `syncDecision`: pending → `'skip'`; marker set and zero rows (**Review Focus 2**) → `'flowin'`; zero rows, no marker → `'import'`; two rows → `'error'`; `sweepBatch` with 20 candidates, cursor at 8, max 8 → candidates 8–15 and `nextCursor` 16, and with the last slice `nextCursor` null.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement** the pure helpers, then `eb-sync-run.js`. The webhook route compares the path secret with `env.EB_WEBHOOK_SECRET` (constant-time), answers 200 at once and runs `syncEbEvent` in `ctx.waitUntil`. `scheduled` calls `runSweep` in `ctx.waitUntil`.
- [ ] **Step 4: Run** `node --test test/eb-sync.test.js` — PASS; `npx wrangler deploy --dry-run` (from `proxy/`) builds.
- [ ] **Step 5: Commit** — `feat(proxy): Eventbrite webhook and hourly sweep keep planning rows in step`.

### Task 6b: gather reads a small cached snapshot, not Coda

Today every gather page load reads three Coda tables in rich format (`buildMemberEvents`). After
the backfill the planning table is ~40× bigger, so gather moves to a cached snapshot holding only
upcoming events with their slots and claims, before Phase C grows the table.

**Files:**
- Modify: `proxy/src/gather.js` (pure snapshot builder), `proxy/src/worker.js` (`buildMemberEvents` reads the snapshot), `proxy/src/worker-io.js` (bust helper)
- Test: `proxy/test/gather.test.js`

**Interfaces:**
- Produces: pure `gatherSnapshot(eventRows, slotRows, claimRows, todayIso) -> {events, slotsByEvent, claimsBySlot}`
  keeping only rows that pass `isPublishedUpcoming` or `isApprovedUpcoming`, their slots, and those
  slots' claims (rich cell values kept as they are, so `projectEventForMember` is unchanged).
- KV key `GATHER_KV_KEY = 'gather-events-v1'`, read with `swrGet` (soft 30 s, hard 5 min).
- `bustEventCaches(env)` in `worker-io.js` deletes `ROWS_KV_KEY` and `GATHER_KV_KEY`; every place that
  busts `ROWS_KV_KEY` today calls it instead, and the claim and slot write routes call it too.
- Per request, only the caller-specific parts (mineClaimed, claimant names, preview flag) are worked out.

- [ ] **Step 1: Write the failing tests** — a past event, a draft, an upcoming published event with two slots and a claim, and a claim on the past event's slot → the snapshot has one event, its two slots, its one claim, and nothing from the past event.
- [ ] **Step 2: Run** `node --test test/gather.test.js` — FAIL.
- [ ] **Step 3: Implement** `gatherSnapshot`, `bustEventCaches`, and switch `buildMemberEvents` to the snapshot.
- [ ] **Step 4: Run** `node --test test/gather.test.js test/worker-io.test.js` — PASS; `./scripts/check.sh` passes.
- [ ] **Step 5: Commit** — `perf(proxy): gather reads a cached snapshot of upcoming events` (record `Help: none — no visible change` in the message).

### Task 7: What leads see, help and decision 0009

**Files:**
- Modify: `web/data.js` (`planningRowToEvent`: `source`, `lastFromEb`), `web/page-rules.js` (~line 37), `web/status-panel.js`
- Modify: `web/help/guide.md`, `web/help/whats-new.md`, `docs/GLOSSARY.md`, `docs/app-map.md`
- Create: `docs/decisions/0009-eventbrite-edits-flow-into-plan.md`; Modify: `docs/decisions/0006-…md` (Status: superseded by 0009), `docs/decisions/README.md`
- Test: `proxy/test/page-rules.test.js`

**Interfaces:**
- Produces on the event shape: `source:'Plan'|'Eventbrite'|'Backfill'`, `lastFromEb:{at:string, fields:string[]}|null`.
- `page-rules.js`: the created-by line reads `Imported from Eventbrite` when `source==='Eventbrite'`.
- `status-panel.js`: when `lastFromEb.at > lastEbPushAt`, a line `Updated from Eventbrite: <fields> · <when>`; field labels: title→Title, date→Date, start→Start time, end→End time, capacity→Capacity, publicDescription→Description, venue→Venue, publishState→Status on Eventbrite.

- [ ] **Step 1: Write the failing tests** in `page-rules.test.js`: an event with `source:'Eventbrite'` and no `createdBy` gives the line `'Imported from Eventbrite'`; the panel model for `lastFromEb:{at:'2026-11-19T10:00:00Z', fields:['start','capacity']}`, `lastEbPushAt:'2026-11-18T00:00:00Z'` includes `'Updated from Eventbrite: Start time, Capacity'`, and with `lastEbPushAt` later than `at` it doesn't.
- [ ] **Step 2: Run** `node --test test/page-rules.test.js` — FAIL.
- [ ] **Step 3: Implement** the mapping and the two lines. `eventToCodaCells` never writes `Source` or `Last from Eventbrite`, except that a new event created in the app writes `Source = Plan`.
- [ ] **Step 4: Help** — in `guide.md` add "Events made on Eventbrite": they appear in plan within minutes as [[Imported from Eventbrite]], changes made on Eventbrite show as [[Updated from Eventbrite]], and a change made in both places keeps plan's value and shows the conflict notice. Add a dated line to `whats-new.md`. Write decision 0009 (Context: the Eventbrite-direct route is permanent; Decision: field-by-field flow-in per spec §5.3; Consequences: 0006 superseded). Glossary: Source, imported event, flow-in.
- [ ] **Step 5: Verify** — `node --test test/page-rules.test.js` PASS; `./scripts/check.sh` passes (help guard included).
- [ ] **Step 6: Commit** — `feat(app): imported events and changes from Eventbrite show on the event page`.

### Task 8: Release Phase A 🔒 Eric

**Files:**
- Create: `scripts/eb-webhook.mjs` (list / register the org webhook; dry run by default)
- Modify: `docs/deployment.md`

- [ ] **Step 1:** `scripts/eb-webhook.mjs` lists the org's webhooks (`GET /organizations/{org}/webhooks/`) and, with `--apply`, creates one for `event.created,event.published,event.updated,event.unpublished` to `https://est-planning-proxy.eastsidetribe.workers.dev/webhooks/eventbrite/<EB_WEBHOOK_SECRET>`. Token from `proxy/.dev.vars`, never printed.
- [ ] **Step 2:** Document in `docs/deployment.md`: the secret `EB_WEBHOOK_SECRET`, the var `EB_SYNC_MODE`, the cron, the webhook script. Commit; open the PR (template's "How it was verified" filled in).
- [ ] **Step 3: 🔒 Eric** — merge (CI deploys with `EB_SYNC_MODE=off`); `wrangler secret put EB_WEBHOOK_SECRET`; run the script with `--apply`; set `EB_SYNC_MODE=live`.
- [ ] **Step 4: Check** — within an hour the Publish Log shows `import` rows for the upcoming Eventbrite events that had no planning row (Shoresh x Tribelings Hanukkah 12/6, the Littles Shabbat dates, Wandering Scholars 3/1/2027) and they appear in plan and gather. Report the "testing" draft to Eric.

---

## Phase B — Google Calendar from the Worker (branch `feat/gcal`, stacked on A)

### Task 9: What goes on the calendar, and how it reads

**Files:**
- Create: `proxy/src/gcal.js`
- Test: `proxy/test/gcal.test.js`

**Interfaces:**
- Produces:
  - `onCalendar(ev, todayIso) -> boolean`: `status==='approved'`, scheduling `exact`, a date, not cancelled, and `date >= todayIso - 1 day`.
  - `gcalEventBody(ev, {tz, gatherBase, area}) -> object` (Calendar API event resource):
    `summary`=title; timed `start/end {dateTime, timeZone:tz}` or all-day `{date}` (end = next day);
    `description` = public summary, blank line, registration line, blank line,
    `Sign up to help: ${gatherBase}/#/event/${rowId}`; registration line =
    `Register: ${eventbriteUrl}` when `publishStatus==='Published'`, otherwise exactly
    `Registration on Eventbrite coming soon`, except that an `externalRegistrationUrl` (when set
    and not Published on Eventbrite) gives `Register: ${externalRegistrationUrl}`; `location` = the venue's address when
    `addressVisibility!=='Registrants only'`, else `area` (`'Nashville, TN'`).
  - `gcalPlan(ev, storedId, lastHash, todayIso) -> {op:'insert'|'patch'|'delete'|'none', body?, hash?}`:
    on calendar and no id → insert; on calendar, id, hash changed → patch; not on calendar
    (cancelled, unpublished-to-draft back to Proposed/Draft, Removed from Eventbrite) and id → delete; else none.
    `hash` = a stable string of `body` (JSON with sorted keys).

- [ ] **Step 1: Write the failing tests** — approved, not on Eventbrite → description contains `Registration on Eventbrite coming soon`; published → contains `Register: https://www.eventbrite.com/e/…`; registrants-only → `location:'Nashville, TN'`; all-day 2026-12-06 → `start:{date:'2026-12-06'}, end:{date:'2026-12-07'}`; cancelled with stored id → `op:'delete'`; month idea → `onCalendar` false; same event twice → `op:'none'` the second time (hash equal).
- [ ] **Step 2: Run** `node --test test/gcal.test.js` — FAIL.
- [ ] **Step 3: Implement** `gcal.js` (pure).
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** — `feat(proxy): Google Calendar event rules`.

### Task 10: Service-account access token

**Files:**
- Create: `proxy/src/google-auth.js`
- Test: `proxy/test/google-auth.test.js`

**Interfaces:**
- Produces: `signServiceJwt(saKey:{client_email, private_key}, scope, nowSec) -> Promise<string>`
  (RS256 via `crypto.subtle`, PKCS8 PEM import; claims `iss`, `scope`, `aud:'https://oauth2.googleapis.com/token'`,
  `iat`, `exp=iat+3600`); `googleAccessToken(env) -> Promise<string>` — exchanges the JWT at the
  token endpoint, caches it in KV `gcal-token` for 3300 s. Secret `GOOGLE_SA_KEY` (the JSON key);
  scope `https://www.googleapis.com/auth/calendar.events`.

- [ ] **Step 1: Write the failing test** — generate an RSA key pair with `crypto.subtle.generateKey`, export the private key as PKCS8 PEM, sign; the JWT has three parts, its header is `{"alg":"RS256","typ":"JWT"}`, its claims carry the scope and `exp-iat===3600`, and the signature verifies with the public key.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** — `feat(proxy): Google service-account token`.

### Task 11: Sync gCal from the Worker

**Files:**
- Create: `proxy/src/gcal-run.js`
- Modify: `proxy/src/worker.js` (call after publish, cancel and unpublish succeed), `proxy/src/eb-sync-run.js` (after import/flow-in; in `runSweep`), `proxy/wrangler.toml` (vars `GCAL_CALENDAR_ID`, `GCAL_MODE = "off"`, `GATHER_BASE = "https://gather.eastsidetribe.org"`)
- Test: `proxy/test/gcal.test.js`

**Interfaces:**
- Consumes: Tasks 9–10; `PLANNING_COLS.gcalEventId`; `logPublish` with `target:'Google Calendar'`.
- Produces: `syncGcal(env, rowId) -> Promise<{op, ok}>` and `sweepGcal(env) -> Promise<{checked, ops}>`
  (every approved row dated yesterday or later, plus every row with a stored id whose `onCalendar` is now false;
  capped at `GCAL_SWEEP_MAX = 20` Google calls per run, resuming from KV `gcal-sweep-cursor` with `sweepBatch` from Task 6).
  Pure `gcalModeAction(mode, op) -> 'call'|'log-only'|'skip'`: `off`→skip, `shadow`→log-only, `live`→call (none → skip always).
  On a `patch` or `delete` that returns 404/410: `patch` re-inserts and stores the new id, `delete` clears the id; both log.
  The last hash per row lives in KV `gcal-hash:<rowId>`; the id is written to the row.

- [ ] **Step 1: Write the failing tests** — `gcalModeAction('shadow','insert')==='log-only'`; `('live','none')==='skip'`; a pure `afterGcalResponse(op, status, body) -> {storeId?:string, clearId?:true, reinsert?:true}`: insert 200 `{id:'abc'}` → `storeId:'abc'`; patch 404 → `reinsert:true`; delete 410 → `clearId:true`.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement** `gcal-run.js` and wire the call sites with `ctx.waitUntil` so no lead-facing route waits on Google.
- [ ] **Step 4: Run** `node --test test/gcal.test.js test/eb-sync.test.js test/publish.test.js` — PASS; `npx wrangler deploy --dry-run` builds.
- [ ] **Step 5: Commit** — `feat(proxy): the Worker keeps Google Calendar in step`.

### Task 12: Help, decision 0010, deployment notes

**Files:** `web/help/guide.md`, `web/help/whats-new.md`, `docs/decisions/0010-worker-is-the-gcal-writer.md`, `docs/decisions/README.md`, `docs/deployment.md`, `docs/GLOSSARY.md`

- [ ] **Step 1:** Help: approved events appear on EST's Google Calendar on their own; before publishing, the calendar says [[Registration on Eventbrite coming soon]]; cancelled events leave the calendar. (`[[ ]]` only around text that exists on screen — the coming-soon line is calendar text, so quote it plainly if the guard rejects it.)
- [ ] **Step 2:** Decision 0010 (one writer, stored id, delete on cancel, shadow mode). Deployment: create the service account, share the *East Side Tribe Events* calendar with it ("Make changes to events"), `wrangler secret put GOOGLE_SA_KEY`, set `GCAL_CALENDAR_ID`, the `GCAL_MODE` values.
- [ ] **Step 3:** `./scripts/check.sh` passes. Commit — `docs: Google Calendar from the Worker`. Open the PR.

### Task 13: Cut over 🔒 Eric

- [ ] **Step 1: 🔒 Eric** — set up the service account and secret (Task 12 notes); merge with `GCAL_MODE=off`.
- [ ] **Step 2: Link existing calendar events** — run `scripts/backfill-est-events.mjs --link-gcal` (Task 14) dry run, then `--apply`: copies gCal ids onto planning rows from `EST Events SRC.gCal Event Id` and Events EVENTBRITE `gCal Event`, matched by Eventbrite id. Rows with no known id are listed for Eric.
- [ ] **Step 3: 🔒 Eric** — `GCAL_MODE=shadow` for a week. Each day compare the Publish Log `Google Calendar` rows with what the Zap and Freshen Up did; differences go back to Task 9 as tests.
- [ ] **Step 4: 🔒 Eric, one sitting:** turn off the EST Zapier Zap "New Event EB→GCal" and delete its Eventbrite webhook; turn off the Coda rule "Daily Event Freshen Up"; set `GCAL_MODE=live`; run the sweep once (`wrangler` cron trigger or wait for :07); delete the 4 orphan gCal events from the audit by hand.
- [ ] **Step 5: Check** — the next day, every approved upcoming event in plan has exactly one calendar event; no new duplicates.

---

## Phase C — Backfill (branch `chore/one-table-backfill`)

### Task 14: Backfill script

**Files:**
- Create: `scripts/backfill-est-events.mjs`
- Test: `proxy/test/backfill-est-events.test.js`

**Interfaces:**
- Consumes: `LEGACY_COLS`, `PLANNING_COLS` (Task 2); `ebToFields`, `importCells` (Tasks 3–4).
- Produces: pure `planBackfill({legacy, planning, ebEvents, todayIso}) -> { creates:[{legacyId, cells}], updates:[{rowId, cells}], unmatchedPast:[{ebId, title, date}], duplicates:[{ebId, legacyIds}], gcalLinks:[{rowId, gcalEventId}], counts:{total, withEb, cancelled, byYear} }`.
  - A legacy row whose Eventbrite id is on a planning row → `updates` filling blank cells only.
  - Otherwise `creates`: Eventbrite rows from `importCells` then legacy fields layered on;
    others from legacy fields only. Mapping per spec §7.5: title without a trailing ` (M/D/YYYY)`;
    Date from `Event Date (for Metrics)`; Start/End time parts; Program(s), Leads, Volunteers,
    Collaborators; first Venue → Venue, the rest → Additional venues; Cancelled? → Status
    `Cancelled` else `Approved`; Event Description; Num Attendees (Manual Override);
    Registration URL Override → External registration URL (banner override and photos are not carried over);
    gCal Event Id → gCal Event ID; Legacy EST Events row = the legacy row id; Source = `Backfill`.
  - `unmatchedPast`: org events with `date < todayIso` and no legacy row.
  - `duplicates`: two legacy rows sharing an Eventbrite id. Any duplicate → the script refuses `--apply`.
- CLI: `node scripts/backfill-est-events.mjs` (dry run: markdown report of the counts, the duplicates, the unmatched past events, a sample of creates); `--apply` (writes in batches of 50 with the upsert key `Legacy EST Events row`, resumable); `--only <legacyRowId>`; `--link-gcal` (writes only `gcalLinks`).

- [ ] **Step 1: Write the failing tests** — `'Littles Shabbat (11/14/2026)'` → title `'Littles Shabbat'`; a three-venue row → Venue = first, Additional venues = the other two; a cancelled row → Status `'Cancelled'`; two legacy rows with Eventbrite id `1596776374119` → `duplicates` has one entry; an org event dated 2026-11-14 with no legacy row and `todayIso '2026-11-19'` → in `unmatchedPast`; a legacy row whose Eventbrite id matches a planning row with Program(s) set → `updates` without a Program(s) cell.
- [ ] **Step 2: Run** `node --test test/backfill-est-events.test.js` — FAIL.
- [ ] **Step 3: Implement** `planBackfill` (exported for the test) and the CLI (tokens from `proxy/.dev.vars`, never printed; follows `scripts/backfill-venue-address.mjs`).
- [ ] **Step 4: Run** — PASS. Then the dry run against prod (reads only) and attach its report to the PR. Expected counts: 238 total, 171 with Eventbrite, 20 cancelled.
- [ ] **Step 5: Help + commit** — add a dated `web/help/whats-new.md` line: past events back to 2017 now show in plan's past years (history, read as Past). `./scripts/check.sh` passes. Commit — `chore(one-table): backfill script for EST Events SRC history`.
- [ ] **Step 6: Measure before writing** — a local benchmark `scripts/bench-rows.mjs` builds a 250-row planning payload from the dry run's creates (in Coda's `simpleWithArrays` shape) and times `JSON.parse` + the `/rows` projection, and `JSON.parse` of the gather snapshot, 200 runs each. Report p50/p95. Go ahead only if `/rows` p95 is under 5 ms; otherwise stop and plan per-year caching of `/rows` with Eric (or the $5 Workers plan).
- [ ] **Step 7: 🔒 Eric** — resolve the duplicates and match the unmatched past events in Coda; re-run the dry run until both lists are empty; then `--apply`; re-run the dry run, which must report 0 creates.
- [ ] **Step 8: Watch CPU** — for three days after `--apply`, check the Worker's CPU time (p50/p99) in the Cloudflare dashboard. If p99 nears 10 ms, raise it with Eric: per-year `/rows` caching, or the $5 plan.

### Task 15: Before/after metrics check

**Files:**
- Create: `scripts/metrics-snapshot.mjs`
- Test: `proxy/test/metrics-snapshot.test.js`

**Interfaces:**
- Produces: pure `diffSnapshots(before, after, allow:{eventIds:string[]}) -> [{table, row, column, before, after}]`
  — differences explained only by `allow.eventIds` (the 8 events the legacy table was missing and the
  duplicates Eric removed) are dropped.
- CLI: `node scripts/metrics-snapshot.mjs --out before.json` reads, by column id: every Quarterly
  Metrics SRC column in Appendix A (A.13–A.20 and the derived ones), People (A.1–A.4 and the Num
  columns), Venues (A.5–A.6), Programs (A.7–A.11 + Orders/Registrants), Collaborators (A.12);
  `--diff before.json` re-reads and prints the diff; exit code 1 on any unexplained difference.

- [ ] **Step 1: Write the failing test** — a Programs `Num Events` change of +1 for an allowed event id → no diff; a Quarterly Metrics `Total Tickets` change with no allowed id → one diff row.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** — PASS.
- [ ] **Step 5:** Take `before.json` from prod (read only), store it outside the repo. Commit — `chore(one-table): metrics before/after check`. Open the PR (Phase C).

---

## Phase D — One table (branch `docs/one-table-cutover`)

### Task 16: The Coda checklist

**Files:**
- Create: `docs/one-table-checklist.md`

Each item: the exact change, who applies it (decided with Eric per step), and the check
(`node scripts/metrics-snapshot.mjs --diff before.json` must exit 0). Order is spec §8.2.

- [ ] **Step 1: Write the checklist** with these formulas on the planning table (column names; Coda resolves them):
  - `Eventbrite Event` → formula `[Events EVENTBRITE].Filter([Eventbrite Id] = thisRow.[Eventbrite Event ID]).First()`
  - `Cancelled?` → `thisRow.Status = "Cancelled"`
  - `Counts for Metrics` → `thisRow.Status = "Approved" AND (thisRow.[Publish status] = "Published" OR thisRow.[Eventbrite Event ID].IsBlank())`
  - `Event Date (for Metrics)` → `thisRow.Date`
  - `Eventbrite Event All Orders` → `thisRow.[Eventbrite Event].[All Orders]`
  - `Eventbrite Event Num Tickets` / `Eventbrite Event Num Orders` → the legacy formulas (survey §1 rows 11, 14) with the table swapped
  - `Eventbrite Ticket Revenue`, `Num First Timers`, `First Timers EST`, `Collab Event`, `Min Leadership Wave`, `Event Discount Config`, `Metrics Reporting Periods` → the legacy formulas (survey §1 rows 37, 16, 17, 18, 19, 41, 15), table swapped
  - then every Appendix A row in order, each consumer's new formula written out, every
    `Cancelled? != true` filter replaced by `[Counts for Metrics]`, and A.5 as
    `[EST Events].Filter(Venue.Contains(thisRow) OR [Additional venues].Contains(thisRow))`.
  - the Slack reminder buttons copied to the planning table (same Templates rows).
  - A.27/A.34 remap: for each Member Discount Codes / Event Discount Config row, set the lookup to the planning row whose `Legacy EST Events row` is its current value.
  - retirements (spec §8.3) and the two unread Coda rules to open first.
- [ ] **Step 2:** Commit — `docs(one-table): Coda checklist for the repoint`.
- [ ] **Step 3: 🔒 Eric** — work through the checklist with the diff after each section.

### Task 17: Freeze, rename, docs

**Files:** `CLAUDE.md`, `docs/app-map.md`, `docs/GLOSSARY.md`, `docs/roadmap.md`, `docs/architecture.md`, `docs/phase2-planning-table.md`, `proxy/wrangler.toml` (comments), `docs/decisions/0011-one-event-table.md`, `docs/decisions/README.md`

- [ ] **Step 1: 🔒 Eric** — rename `EST Events SRC` → `EST Events (legacy)` and lock it; rename `EST Planning Events SRC` → `EST Events`. Table ids don't change.
- [ ] **Step 2:** Update every doc and comment naming the two tables; decision 0011; glossary (`EST Events`, `Legacy EST Events row`, `Counts for Metrics`); roadmap: steps 2 and 6 done, and fix the stale "gather site not created yet" lines (roadmap and CLAUDE.md's repo map) — gather is live at `gather.eastsidetribe.org`.
- [ ] **Step 3:** `grep -rn "EST Planning Events SRC" docs CLAUDE.md proxy web | grep -v superpowers/` returns only historical mentions; `./scripts/check.sh` passes. Commit — `docs: one event table`. Open the PR.
