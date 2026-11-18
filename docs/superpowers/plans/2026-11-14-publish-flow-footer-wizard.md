# Publish Flow, Footer Wizard & Honest Saves: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A lead can take an approved event from approval to public on Eventbrite in one sitting. The Details tab's footer wizard always shows the next step and what's missing; saves mean "applied"; fields say where they go; the Worker never acts on stale or silently-altered data.

**Architecture:**
- **One pure shared module, `web/listing-readiness.js`,** holds the rules: stage, readiness checks, field visibility, sync status, footer model, change notice. It's imported by the app (script tag), the Worker (side-effect import, F18) and node tests.
- **Honest saves:** the app polls a new Worker route `GET /mutation/:requestId` until Coda reports a write applied.
- **The Worker's publish path** re-runs the same readiness checks, repairs a missing ticket class, writes a snapshot of what it pushed, and gains preview, unpublish and draft-delete routes.

**Tech Stack:** Buildless vanilla JS (`web/`), Cloudflare Worker (`proxy/`, wrangler), `node --test`, Coda API v1, Eventbrite API v3.

**Spec:** `docs/superpowers/specs/2026-11-14-publish-flow-footer-wizard-design.md`. Read it first; this plan cites its sections (§), facts (F#), decisions and departures (D#). Visual reference: https://claude.ai/artifact/AeaeVySLeUM866d1emm8Ct.

**Before Task 9 and Task 16:** spec §4 has open questions Q1–Q3. The plan implements the **recommended** answers: Q1 (a) leads may delete never-published events; Q2 the registrants guard; Q3 mailto interim. If Eric chose differently, adjust those two tasks only.

## Global Constraints

- **Branch:** work on `feat/publish-wizard` (create from `main`). Never commit to `main`. Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- **Buildless app:** no bundler or new dependencies in `web/`. New shared files are plain scripts that attach to `globalThis` (same shape as `web/save-queue.js`) and are added as `<script>` tags in `web/index.html` *before* `app.js`.
- **After any `web/*.js` edit:** `node --check web/<file>.js` (CLAUDE.md).
- **Tests:** `cd proxy && npm test` (`node --test`). One test run at a time machine-wide (`~/.claude/CLAUDE.md`). Run touched files only while iterating: `node --test test/<file>.test.js`.
- **Coda columns are referenced by id** in all new Worker code (`proxy/src/coda-columns.js`). Existing name-keyed reads in the publish route may stay (deferred id-hardening) except where a task says otherwise.
- **Any Worker path that writes planning rows busts `ROWS_KV_KEY`** (`swrBust(env, ROWS_KV_KEY)`).
- **Eventbrite API paths always end in `/`** before the query string (F9).
- **Tooltips:** use the app's `data-tip` attribute (not `title=`) plus `aria-label`.
- **Phone breakpoint:** stays `≤600px` (`PHONE_MQ`), matched in CSS.
- **Copy:** user-facing text must match the spec §5.5 table and the canvas exactly. The verbs are **Add to Eventbrite**, **Update draft**, **Publish**, **Update listing**, **Unpublish (back to private)**, **Cancel event…**, **Delete event**, **Preview listing**. Never use "publish" for the private-draft step.
- **Help ships with the change:** `web/help/guide.md` + `web/help/whats-new.md` are in this branch (Task 17); `node scripts/check-help.mjs --branch feat/publish-wizard` must pass before the PR.
- **Free-plan Worker:** no request may exceed 50 subrequests (F5). No polling inside the Worker.
- **Machine resources:** follow `~/.claude/CLAUDE.md` "Machine resources". Record the PID/port of any dev server or `wrangler dev` you start, kill by PID only, stop it when the step is done.

## Review Focus

1. **Coda never confirms a save** (`mutationStatus` stays `completed:false`, returns 400, or the network drops). The save pill should end in a retryable "Save failed — retry", the primary button should stay disabled, and nothing should claim "Saved". Pinned in Task 2 (`waitApplied` timeout/400/network) and Task 11 (pending gating).
2. **An event pushed before this change has no pushed snapshot.** No field should claim "Not on Eventbrite yet" or "Matches Eventbrite". Status is `unknown`, the globe only. Pinned in Task 1 (`syncStatus` with `null`).
3. **The user edits a field while a 30 s apply is in flight, then clicks the primary button.** The button must stay "Saving…" until *every* queued edit is applied, not just the first. Pinned in Task 11 (`pendingFor` over coalesced writes).
4. **A Home venue with no address while the user has explicitly chosen Public** must stay Public (never override a choice) and block Add to Eventbrite with the address message. A **Venue (other)** name must block with "Add this venue to Venues first". Pinned in Task 1.
5. **Eventbrite description HTML containing `<script>`, event-handler attributes or `javascript:` links** must render as harmless text or be stripped in the preview. Pinned in Task 13 (sanitizer).

---

## File map

| File | Responsibility | Tasks |
|---|---|---|
| `web/listing-readiness.js` (new) | Pure rules: `stageOf`, `FIELDS`, `readiness`, `addressVisibilityDefault`, `syncStatus`, `footerModel`, `changeNotice` → `globalThis.ListingRules` | 1, 3 |
| `web/coda-applied.js` (new) | Pure `waitApplied` poller → `globalThis.CodaApplied` | 2 |
| `web/listing-html.js` (new) | Pure allowlist sanitizer for Eventbrite description HTML → `globalThis.ListingHtml` | 13 |
| `proxy/src/publish.js` (new) | Pure Worker helpers: `mutationResult`, `rowToListingEvent`, `pushedValues`, `descriptionToWrite`, `ticketPlan`, `previewModel` | 4–8 |
| `proxy/src/worker.js` | Routes: `/mutation`, publish changes, `/eventbrite/preview`, `/unpublish/eventbrite`, cancel/delete changes | 4, 6, 7, 8, 9 |
| `proxy/src/coda-columns.js` | New column id `lastEbPushedValues` | 5 |
| `.github/workflows/deploy-proxy.yml` | Path filter includes `web/listing-readiness.js` | 10 |
| `web/app.js` | DB methods, honest-save wiring, editor `ctx`, footer render, Details form, preview modal, ⋮ actions; remove old publish panel and lead lock | 11, 12, 13, 14, 15, 16 |
| `web/index.html`, `web/styles.css` | Script tags; footer/marker/card/preview styles | 11, 12, 13 |
| `web/help/guide.md`, `web/help/whats-new.md` | Help | 17 |
| `proxy/test/listing-readiness.test.js`, `coda-applied.test.js`, `listing-html.test.js`, `publish.test.js` (new) | Tests | 1, 2, 3, 5–8, 13 |

---

### Task 1: Shared rules: stage, field visibility, readiness, address default, sync status

**Files:**
- Create: `web/listing-readiness.js`
- Test: `proxy/test/listing-readiness.test.js`

**Interfaces:**
- Produces (on `globalThis.ListingRules`):
  - `stageOf(ev) → 'draft'|'proposed'|'approved'|'onEventbrite'|'published'|'cancelled'`. Reads `ev.status` (lowercase), `ev.eventbriteId`, `ev.publishStatus`; per spec §5.1.
  - `FIELDS`: `{[key]: {label, public: boolean, pushedKey?: string}}` for keys `title, description, programs, leads, date, start, end, venue, publicSummary, publicDescription, capacity, addressVisibility`. `public` = true for title, date, start, end, venue, publicSummary, publicDescription, capacity, addressVisibility. `pushedKey` equals the key for public fields.
  - `readiness(ev, {venue, todayISO}) → {add: Check[], publish: Check[]}`, where `Check = {key, field, ok, message}`.
    - `venue` is `null` or `{name, type, hasAddress}`.
    - `ev` uses app field names: `title, scheduling, allDay, date, start, end, capacity, venueName, venueOther, addressVisibility, publicDescription, status`.
    - `publish` includes every `add` check plus `publicDescription`.
  - `addressVisibilityDefault(current, venue) → string`: returns `'Registrants only'` only when `current` is empty/undefined **and** `venue.type === 'Home'`; otherwise returns `current`.
  - `syncStatus(ev, pushed) → {[fieldKey]: 'match'|'changed'|'unknown'}`, for public fields only. `pushed === null` → every public field `'unknown'`. Comparison: trimmed string equality; capacity compared as a number.
  - `unpushedFields(ev, pushed) → string[]`: public field keys whose status is `'changed'`, in `FIELDS` order.

Check keys and messages (exact copy, used by the footer and fields):

| key | field | fails when | message |
|---|---|---|---|
| `approved` | — | status ≠ approved | `Needs Tribal Council approval first` |
| `title` | title | blank | `Add a title` |
| `exact` | date | scheduling ≠ exact or allDay | `Pick an exact date and times (Eventbrite can't list a range, month or all-day event)` |
| `date` | date | blank | `Add a date` |
| `future` | date | date < todayISO | `Pick a date that hasn't passed` |
| `start` | start | blank | `Add a start time` |
| `end` | end | blank | `Add an end time` |
| `endAfterStart` | end | end ≤ start | `End time must be after the start time` |
| `capacity` | capacity | not an integer ≥ 1 (`''`, `'0'`, `'1.5'`, `'abc'` all fail) | `Add a capacity: how many free tickets Eventbrite offers` |
| `venueOther` | venue | `venueOther` set and `venueName` blank | `Add this venue to Venues first, so Eventbrite gets its address` |
| `venueAddress` | venue | venue set, `addressVisibility` is `'Public'` (or blank, which means Public), and `!venue.hasAddress` | `This venue has no street address. Add one to the venue, or choose Registrants only` |
| `publicDescription` | publicDescription | blank (publish only) | `Add a public description (Eventbrite requires one to publish)` |

No venue at all is allowed (online event) and produces no failing check.

- [ ] **Step 1: Write failing tests** in `proxy/test/listing-readiness.test.js` (`import '../../web/listing-readiness.js'; const R = globalThis.ListingRules;`):
  - `stageOf`: one assertion per row of spec §5.1, including `{status:'approved', eventbriteId:'1', publishStatus:'Draft'} → 'onEventbrite'` and `{..., publishStatus:'Published'} → 'published'`.
  - `readiness`:
    - a fully ready approved event (date `'2027-03-01'`, start `'18:00'`, end `'20:00'`, capacity `'20'`, no venue, todayISO `'2026-11-14'`) → every `add` check ok and `publish` has exactly one failure, `publicDescription`.
    - each table row's failing input produces exactly that key with `ok:false` and the exact message.
    - capacity `'0'`, `'1.5'`, `''` fail; `'20'` and `20` pass.
    - `venueOther:'Bob\'s house', venueName:''` fails `venueOther`.
    - Home venue `{name:'X', type:'Home', hasAddress:false}` with `addressVisibility:'Public'` fails `venueAddress`; the same with `'Registrants only'` passes.
  - `addressVisibilityDefault`:
    - `('', {type:'Home'}) → 'Registrants only'`
    - `('Public', {type:'Home'}) → 'Public'` (Review Focus 4)
    - `('', {type:'Restaurant/Bar'}) → ''`
    - `('', null) → ''`
  - `syncStatus`:
    - `pushed=null` → all public keys `'unknown'` (Review Focus 2)
    - capacity `'20'` vs pushed `20` → `'match'`
    - start `'18:30'` vs `'18:00'` → `'changed'`
    - private keys are absent from the result
  - `unpushedFields` returns `['start','capacity']` for those two changes, in `FIELDS` order.

- [ ] **Step 2: Run** `cd proxy && node --test test/listing-readiness.test.js`. Expected: FAIL (module missing).

- [ ] **Step 3: Implement** `web/listing-readiness.js` as an IIFE attaching `ListingRules` to `globalThis` (copy the wrapper shape of `web/save-queue.js`). Pure; no DOM, no fetch.

- [ ] **Step 4: Run** the test again and `node --check web/listing-readiness.js`. Expected: PASS.

- [ ] **Step 5: Commit** `feat(rules): shared listing rules: stage, readiness, sync status`.

---

### Task 2: `waitApplied`, the honest-save poller

**Files:**
- Create: `web/coda-applied.js`
- Test: `proxy/test/coda-applied.test.js`

**Interfaces:**
- Produces: `globalThis.CodaApplied.waitApplied(requestId, {fetchStatus, sleep, now, onSlow}) → Promise<void>`
  - `fetchStatus(requestId) → Promise<{status:number, completed?:boolean}>`
  - Poll delays: 1000 ms for the first 5 polls, then 1500 ms up to 20 s elapsed, then 2000 ms.
  - Calls `onSlow()` once when 20 000 ms have elapsed without completion.
  - Resolves on `completed:true`.
  - Resolves immediately on `status === 404` (route missing during a deploy gap).
  - Rejects `Error('save not confirmed')` with `.status = 400` on 400.
  - Rejects `Error('save not confirmed')` once 120 000 ms have elapsed.
  - A thrown `fetchStatus` (network error) is retried until the deadline, then rejects.
  - `requestId` falsy → resolves immediately.

- [ ] **Step 1: Write failing tests** using a fake clock (`now` returns a counter that `sleep(ms)` advances; no real timers):
  - completes on the 3rd poll → resolves after 3 calls
  - 404 → resolves after 1 call
  - 400 → rejects with `.status===400`
  - never completes → rejects at ≥120000 ms elapsed, and `onSlow` was called exactly once (Review Focus 1)
  - `fetchStatus` throws twice then completes → resolves
  - falsy requestId → resolves with 0 calls

- [ ] **Step 2: Run** `node --test test/coda-applied.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement** in `web/coda-applied.js` (IIFE → `globalThis.CodaApplied`).
- [ ] **Step 4: Run** the tests and `node --check web/coda-applied.js`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(save): waitApplied poller for Coda mutation status`.

---

### Task 3: Footer model and change notice

**Files:**
- Modify: `web/listing-readiness.js`
- Test: `proxy/test/listing-readiness.test.js`

**Interfaces:**
- Consumes: Task 1 (`stageOf`, `readiness`, `unpushedFields`).
- Produces:
  - `footerModel(input) → {steps, title, sub, links, primary, secondary, menu}`. Input fields:
    - `stage`, `past` (boolean)
    - `role` (`{canEdit, canApprove}`)
    - `checks` (output of `readiness`)
    - `pending` (boolean)
    - `unpushed` (string[])
    - `ebEditedElsewhere` (boolean)
    - `registrants` (number|null)
    - `proposedBy` (`{name, date}`|null)
    - `justChanged` (`{fields:string[], registrants:number}`|null)
  - Output:
    - `steps`: an array of 5 `{label, state:'done'|'current'|'todo'}`, with labels `Draft, Proposed, Approved, On Eventbrite, Published`. For `cancelled`, all steps are `todo` and `title` is `'Cancelled'`.
    - `links`: `[{field, label}]` (the failing checks for the next action)
    - `primary`: `{label, act, enabled, tone:'primary'|'go'|'quiet'}|null`
    - `secondary`: `{label, act}|null`
    - `menu`: `[{act, label, sub, tone:'normal'|'danger'}]`
    - `act` values: `propose, approve, reopen, add-eb, update-eb, publish-eb, preview-eb, update-listing, email-registrants, dismiss-notice, delete, unpublish, cancel`
  - Rules:
    - Copy and actions are exactly the spec §5.5 table.
    - `pending:true` replaces `primary` with `{label:'Saving…', act:null, enabled:false, tone:'primary'}` and keeps everything else.
    - `past:true` with stage `published`/`onEventbrite` → no primary (except `email-registrants` if `justChanged`) and `menu: []`.
    - Leads with stage `draft`/`proposed`/`approved`/`onEventbrite` get `delete` in `menu` (Q1 (a)).
    - Council gets `delete` there too, and in `cancelled`.
    - `delete` never appears together with `cancel`.
  - `changeNotice(before, after, ev) → {subject, body, fields}`:
    - covers date, start, end and venue changes (title/description excluded)
    - subject: `Update: <title> on <Mon, Mar 1>`
    - body lists each change as `Start time: 6:00 PM → 6:30 PM`, `Where: <old> → <new>`, then a blank line and `See you there!`
    - `fields: []` when nothing relevant changed

- [ ] **Step 1: Write failing tests:**
  - one `footerModel` case per spec §5.5 row, asserting `title`, `primary.label`, `primary.enabled`, `primary.act` and the `menu` acts. For example:
    - lead/approved/not-ready with end+capacity failing → `title` `'Approved. 2 things left before Eventbrite'`, `links` fields `['end','capacity']`, primary `Add to Eventbrite` disabled
    - published + `unpushed:['start','capacity']` → title `"2 changes aren't on Eventbrite yet"`, primary `Update listing`, menu `['unpublish','cancel']`
  - `pending:true` on the ready state → primary `Saving…` disabled (Review Focus 3, model side)
  - for every stage, `menu` never contains both `delete` and `cancel`
  - `changeNotice` with start `18:00→18:30` → `fields:['start']` and body contains `Start time: 6:00 PM → 6:30 PM`; no changes → `fields:[]`
- [ ] **Step 2: Run** them. Expected: FAIL.
- [ ] **Step 3: Implement** in `web/listing-readiness.js`.
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(rules): footer model + change notice`.

---

### Task 4: Worker `GET /mutation/:requestId`

**Files:**
- Modify: `proxy/src/worker.js` (new route next to the `rows` route)
- Create: `proxy/src/publish.js` (start the module with `mutationResult`)
- Test: `proxy/test/publish.test.js`

**Interfaces:**
- Produces:
  - Route: `GET /mutation/:requestId` → 200 `{completed:boolean}`; 400 `{error}` for Coda's 400; 401/403 as other write routes (`authIdentity` + `canWrite`). One Coda subrequest: `GET ${base}/mutationStatus/${encodeURIComponent(id)}`.
  - Pure: `mutationResult(status, body) → {httpStatus, json}`. Maps Coda 200 → `{200, {completed: !!body.completed}}`, 400 → `{400, {error:'unknown request id'}}`, other → `{502, {error:'coda <status>'}}`.

- [ ] **Step 1:** Failing tests for `mutationResult` (200 completed true/false, 400, 500).
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement `mutationResult` and the route.
- [ ] **Step 4:** Run `npm test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(proxy): GET /mutation/:id for honest saves`.

---

### Task 5: Pushed-snapshot column and row mapping

**Files:**
- Coda schema (via the Superhuman Docs MCP, `table_columns_manage` on `superhuman://docs/DYAz_wCVfv/tables/grid--gYIvdD-cE`):
  - add a text column **`Last EB pushed values`**, description `JSON of exactly what the Worker last sent to Eventbrite. Written by the proxy only.`
  - update the **`Public description`** column description to `Public listing body for Eventbrite. Distinct from the internal Event Description; never falls back to it.`
- Modify: `proxy/src/coda-columns.js` (add `lastEbPushedValues: '<new id>'` to `PLANNING_COLS`, with a comment)
- Modify: `proxy/src/publish.js`, `proxy/test/publish.test.js`

**Interfaces:**
- Produces:
  - `rowToListingEvent(V) → ev`. V is the name-keyed `simpleWithArrays` row the publish route reads. Output is in `ListingRules.readiness` input shape:
    - `title←Title`, `status←Status (lowercased)`, `scheduling←Scheduling (lowercased)`, `allDay←All day`
    - `date←Date` (first 10 chars)
    - `start/end←Start/End` (`HH:MM` via the existing regex in `worker.js` publish route)
    - `capacity←Capacity`, `venueName←Venue[0]`, `venueOther←Venue (other)`, `addressVisibility←Address visibility`
    - `publicSummary`, `publicDescription`
    - `eventbriteId←Eventbrite Event ID`, `ticketClassId←Eventbrite Ticket Class ID`
    - `pushed←JSON.parse(Last EB pushed values) or null` (invalid JSON → null)
  - `pushedValues(ev, {ticketClassId}) → string`: JSON of `{title, date, start, end, capacity:Number, publicSummary, publicDescription, venueName, addressVisibility, ticketClassId}`.

- [ ] **Step 1: Make the schema changes** with the MCP and record the new column id. Verify with `table_columns_read`: the column exists, is type `none`, and the id matches what you put in `coda-columns.js`.
- [ ] **Step 2: Failing tests:**
  - `rowToListingEvent` on a fixture row shaped like the probe (F10) gives the mapped values
  - `Venue: []` → `venueName:''`
  - bad JSON → `pushed:null`
  - `pushedValues` round-trips through `JSON.parse` with capacity as a number
- [ ] **Step 3:** Run. Expected: FAIL. **Step 4:** Implement. **Step 5:** Run. Expected: PASS.
- [ ] **Step 6: Commit** `feat(proxy): pushed-values snapshot column + row mapping` (include the column id in the commit body).

---

### Task 6: Publish route: readiness gate, logged rejections, no silent fallbacks, snapshot write

**Files:**
- Modify: `proxy/src/worker.js` (publish route ~L303–475, `ensureEbVenue` ~L1246, the `/rows` POST/PUT path)
- Modify: `proxy/src/publish.js`, `proxy/test/publish.test.js`

**Interfaces:**
- Consumes: Tasks 1 and 5; the Worker imports `'../../web/listing-readiness.js'` once at the top of `worker.js` and reads `globalThis.ListingRules`.
- Produces:
  - `descriptionToWrite(ev, pushed) → string|null`: returns `null` (skip the structured-content write) when `ev.publicDescription` is blank, or equals `pushed.publicDescription` after `normText`; otherwise returns the text. Never returns the internal description (decision 7).
  - Publish route behavior:
    1. Read the row.
    2. `ev = rowToListingEvent(V)`.
    3. Look up the venue record by `ev.venueName` in `EST Venues SRC` (reuse the read `ensureEbVenue` already does; pass `{name, type: values['Venue Type'], hasAddress: !!values['Address']}`).
    4. `checks = ListingRules.readiness(ev, {venue, todayISO: <America/Chicago today>})`.
    5. Use `checks.add` when `draftOnly`, else `checks.publish`. If any fail: `logPublish({action:'readiness', ok:false, status:409, message: <failed messages joined ' · '>})`, then return 409 `{error:<first message>, checks:<failed checks>}`.
    6. The existing 409s (not approved, conflict) are also logged with `action:'readiness'`/`'conflict'`.
  - On create, `summary` falls back to nothing (remove the `stripHtml(ev.description)` fallback in `eventToEventbritePayload`'s create path), and the structured-content text comes only from `descriptionToWrite`.
  - `ensureEbVenue`: the "public venue with no address → online" fallback is removed. That case now returns `{error: {status: 409, body: {error_description: 'This venue has no street address'}}}`. No venue → online stays (it's an allowed choice).
  - On success: write `PLANNING_COLS.lastEbPushedValues` = `pushedValues(ev, {ticketClassId})` in the same `setRow` as the success cells.

- [ ] **Step 1: Failing tests** for `descriptionToWrite`:
  - blank → `null`
  - equals pushed (whitespace-insensitive) → `null`
  - different → the text
  - pushed `null` + non-blank → the text
- [ ] **Step 2:** Run. FAIL. **Step 3:** Implement the helper and wire the route changes above. Keep every Eventbrite path's trailing slash.
- [ ] **Step 4:** `npm test` passes, and `npx wrangler deploy --dry-run --outdir /tmp/est-dry` (in `proxy/`) succeeds. The bundle contains `ListingRules` (`grep -c ListingRules /tmp/est-dry/worker.js` ≥ 1). Delete `/tmp/est-dry` after.
- [ ] **Step 5: Commit** `feat(proxy): readiness-gated publish, logged rejections, no silent fallbacks`.

---

### Task 7: Ticket class repair on retry

**Files:**
- Modify: `proxy/src/publish.js`, `proxy/test/publish.test.js`, `proxy/src/worker.js` (publish step 3)

**Interfaces:**
- Produces: `ticketPlan({isCreate, storedTcId, classes, capacity}) → {action:'create'|'adopt'|'update'|'leave'|'none', id?}`. `classes` is `[{id}]` from `GET /events/{id}/ticket_classes/`, or `null` when not fetched.

| Case | Result |
|---|---|
| isCreate | `{action:'create'}` |
| storedTcId and capacity | `{action:'update', id:storedTcId}` |
| storedTcId, no capacity | `{action:'none'}` |
| no storedTcId, `classes.length===0` | `{action:'create'}` |
| no storedTcId, exactly 1 | `{action:'adopt', id}` |
| more than 1 | `{action:'leave'}` |

- Worker:
  - Fetch `classes` only when `!isCreate && !storedTcId` (one extra subrequest).
  - `adopt` stores the id and then updates its quantity from Capacity.
  - `create` stores the new id.
- [ ] **Step 1:** Failing tests, one per table row. **Step 2:** Run. FAIL.
- [ ] **Step 3:** Implement and wire.
- [ ] **Step 4:** `npm test` passes.
- [ ] **Step 5: Commit** `fix(proxy): create or adopt a missing ticket class on update (F12)`.

---

### Task 8: Preview route

**Files:**
- Modify: `proxy/src/publish.js`, `proxy/test/publish.test.js`, `proxy/src/worker.js`

**Interfaces:**
- Produces:
  - `GET /eventbrite/preview?rowId=` (auth: `canWrite`) → 200 `previewModel(...)`, 404 `{linked:false}` when no Eventbrite id. Two Eventbrite subrequests: `/events/{id}/?expand=venue,ticket_classes,logo` and `/events/{id}/description/`.
  - `previewModel(eventBody, descriptionBody, addressVisibility) → {name, summary, descriptionHtml, startLocal, endLocal, timezone, status, location:{online, name, displayAddress}, tickets:[{name, free, quantityTotal}], logoUrl}`.
    - `displayAddress` is the venue's `address.localized_address_display` when `addressVisibility !== 'Registrants only'`; otherwise the city/region (`'Nashville, TN'`) and the note `'Full address shown to registrants only'`.
    - `descriptionHtml` is `descriptionBody.description` (raw; the app sanitizes).
- [ ] **Step 1:** Failing tests using a fixture shaped like the F10 probe (draft, no tickets, online, `summary:null`):
  - `location.online:true`, `tickets:[]`, `summary:''`
  - a fixture with a venue + `'Registrants only'` → no street address in output
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS.
- [ ] **Step 5: Commit** `feat(proxy): Eventbrite draft preview route (F8)`.

---

### Task 9: Unpublish, cancel and delete against Eventbrite's order rules

**Files:**
- Modify: `proxy/src/publish.js`, `proxy/test/publish.test.js`, `proxy/src/worker.js` (cancel route ~L501, DELETE in `rows` route ~L128, new unpublish route)

**Interfaces:**
- Produces:
  - Registrant count: reuse the existing `ebEventSnapshot(body).sold` in `proxy/src/eventbrite.js` (sums `ticket_classes[].quantity_sold`; needs `expand=ticket_classes`). Don't add a second helper.
  - **`POST /unpublish/eventbrite {rowId}`** (`canWrite`):
    1. Read the event (expand ticket_classes).
    2. If `sold > 0` → 409 `{needsEventbriteCancel:true, registrants:n, error:'People have registered, so Eventbrite won't let this listing be unpublished. Cancel the event instead.'}`.
    3. Else `POST /events/{id}/unpublish/`; on success set `Publish status = 'Draft'`, `Published? = false`, bust rows, log `action:'unpublish'`.
  - **`POST /cancel/eventbrite`:** check `sold` first.
    - Above 0: change nothing; log; return 409 `{needsEventbriteCancel:true, registrants:n, error:'Eventbrite only lets someone with East Side Tribe's Eventbrite login cancel an event people have registered for (it refunds and emails them). Ask council to cancel it on Eventbrite, then click Cancel event here again.'}`.
    - Else: if the event is live, unpublish; if it's a draft, `DELETE /events/{id}/`. Then set `Status = Cancelled`, `Published? = false`, and Publish status `'Cancelled'`.
    - An Eventbrite event already `canceled` or `deleted` counts as success, so the plan-side cancel completes after council cancels on Eventbrite.
  - **`DELETE /rows/:id`:**
    - Allow `canWrite` when the row's `Published?` is false and its Status is not Cancelled (Q1 (a)). A Cancelled row needs `canApprove`, as today.
    - Refuse with 409 `{error:'Cancel this event before deleting it'}` when `Published?` is true.
    - With an Eventbrite id, `DELETE /events/{id}/` first. On Eventbrite failure return 502 `{error}` and keep the row.
    - Log `action:'delete'`.
- [ ] **Step 1:** Add a failing test to `proxy/test/publish.test.js` (or the existing eventbrite test file, if one covers `ebEventSnapshot`): `ebEventSnapshot({ticket_classes:[{quantity_sold:3},{quantity_sold:9}]}).sold === 12`, and no `ticket_classes` → `0`. It may already pass; that's fine, it pins the behavior the new routes rely on.
- [ ] **Step 2:** Run it. **Step 3:** Implement the routes (each reads the row by name like the existing cancel route; trailing slashes).
- [ ] **Step 4:** `npm test` passes; the dry-run bundle succeeds.
- [ ] **Step 5: Commit** `feat(proxy): unpublish route; cancel/delete respect Eventbrite order rules (F7)`.

---

### Task 10: Deploy wiring for the shared module

**Files:**
- Modify: `.github/workflows/deploy-proxy.yml` (`paths:` add `'web/listing-readiness.js'`)
- Modify: `CLAUDE.md`. In the repo map row for `web/`, note "`web/listing-readiness.js` is also bundled into the Worker"; under "App gotchas" add: "`web/listing-readiness.js` is imported by the Worker: keep it free of DOM/browser globals; editing it redeploys the Worker."
- [ ] **Step 1:** Make both edits.
- [ ] **Step 2:** Verify the YAML parses: `node -e "require('fs').readFileSync('.github/workflows/deploy-proxy.yml','utf8')"`, then confirm by eye that the path list contains the new entry.
- [ ] **Step 3: Commit** `ci: redeploy the Worker when shared listing rules change` (body: `Help: none — CI/docs only`).

---

### Task 11: App honest saves and pending state

**Files:**
- Modify: `web/index.html` (add `<script src="listing-readiness.js">`, `<script src="coda-applied.js">` before `save-queue.js`)
- Modify: `web/app.js`: `CodaSource` (~L351), `saveQueue` (~L1977), `transitionTo` (~L2096), `createFromForm` (~L1193), `paintSaveStatus`/`setSaveStatus` (~L2030)

**Interfaces:**
- Consumes: Task 2 `CodaApplied.waitApplied`; Task 4 route.
- Produces (in `app.js`):
  - `CodaSource.update(id, cells) → Promise<{requestId}>`. `create` additionally sets `e._requestId`.
  - `CodaSource.mutationStatus(requestId) → Promise<{status, completed}>` (fetches `/mutation/:id` with `_wh()` headers; never throws on non-2xx).
  - `applied(requestId, eventId) → Promise<void>`: wraps `waitApplied` with `fetchStatus: DB.mutationStatus`, real `sleep`/`now`, and `onSlow` → if that event is open, `setSaveStatus('slow')`. It also keeps a per-event counter in `_applying: Map<id, number>`.
  - `pendingFor(id) → boolean`: true when `saveQueue.status(id)==='saving'`, `_autosaveT` is set for the open editor of `id`, or `(_applying.get(id)||0) > 0`.
  - `setSaveStatus('slow')` text: `Still saving — Coda is slow right now`.
  - `saveQueue` `write: (id, cells) => DB.update(id, cells).then(r => applied(r && r.requestId, id))`.
  - `transitionTo`: after `DB.update(Status)`, `await applied(requestId, ev.id)` before `markRecent`/toast/reopen.
  - `createFromForm`: after `DB.create`, start `applied(e._requestId, e.id)` without awaiting (the editor opens; the footer reads `pendingFor`).
  - Every place that paints the save pill also calls `renderEditorFooter()` (Task 12) so the primary slot follows `pendingFor`.
- [ ] **Step 1: Write a failing integration-style test** in `proxy/test/save-queue.test.js`, `'saved fires only after the applied promise resolves'`. Construct `SaveQueue.create({write})` where `write` returns a promise that resolves only when the test resolves a second "applied" deferred; assert `onState` has not emitted `'saved'` until then. This pins Review Focus 3 at the queue level: two edits staged during an in-flight write coalesce, and `'saved'` comes after the second write's apply.
- [ ] **Step 2:** Run. It should PASS without changes (`SaveQueue` already awaits `write`). If it fails, the queue needs fixing before going on.
- [ ] **Step 3:** Implement the app changes above. `node --check web/app.js`.
- [ ] **Step 4:** Manual check against prod, local app only:
  1. Run `npx -y live-server web --port=8080 --no-browser`; record its PID.
  2. Point the app at a staged Worker: `wrangler versions upload` in `proxy/`, then `localStorage.setItem('est-proxy-base', '<preview url>')`.
  3. Edit Capacity on the test event (row `i-3ec5JtSbzX`; spec F10).
  4. The pill shows "Saving…" for roughly 10–30 s, then "Saved".
  5. Within ~1 s of "Saved", the Coda formula `[EST Planning Events SRC].Filter(Title="Wandering Scholars Presents: Jewish Futures").First().Capacity` returns the new value.
  6. Put the value back to 20. Kill live-server by PID.
- [ ] **Step 5: Commit** `feat(app): saves report Saved only once Coda has applied them (D3)`.

---

### Task 12: Editor `ctx`, footer wizard render, ⋮ menu; remove the lead lock

**Files:**
- Modify: `web/app.js`: `openEditor` (~L1066–1153), `footerActionsHTML` (delete), the click dispatcher (~L2190–2205), `renderSection`
- Modify: `web/index.html` (the modal footer gets two stable containers: `<div id="edFoot"></div>` beside the existing save pill)
- Modify: `web/styles.css` (footer wizard, steps, kebab, menu; phone rules at `≤600px`)

**Interfaces:**
- Consumes: Task 3 `footerModel`, Task 1 `stageOf`/`readiness`, Task 11 `pendingFor`.
- Produces:
  - `editorCtx(ev) → {ev, role:{canEdit, canApprove}, stage, past, locked}`. `locked` = `ev.status==='cancelled'` only: the lead lock `approved && !canApprove` is **removed** (decision 5). `past` = `isHistory(ev)`.
  - `renderEditorFooter()`:
    - Builds `footerModel({...})` from `editing` + `editorCtx` + `readiness(editing, {venue: venueRecord(editing), todayISO: todayStr})` + `pendingFor` + `unpushedFields`.
    - Writes **inner** HTML into `#edFoot` only (D1).
    - On non-Details tabs it renders only the ⋮ menu (spec decision 3).
  - Kebab: `<button class="kb" data-act="menu" aria-label="More actions" aria-expanded>` opening a `role="menu"` list of `menu` items (`data-act=item.act`); closes on outside click/Esc.
  - Dispatcher: maps `act` values (Task 3 list) to handlers. The new handlers (`add-eb`, `update-eb`, `publish-eb`, `preview-eb`, `update-listing`, `email-registrants`, `unpublish`) are stubbed with `toast('Coming in this branch')` until Tasks 14–16 replace them; `propose`/`approve`/`reopen`/`cancel`/`delete` keep their existing functions.
  - `links` render as `<a href="#" data-focus-field="<field>">`; click scrolls the field into view and focuses its input.
- [ ] **Step 1:** `node --check web/app.js` after the refactor; `npm test` still passes.
- [ ] **Step 2:** Manual check (local app + staged Worker, test event):
  - Draft/Proposed/Approved footers match the canvas boards A–C.
  - The ⋮ menu never shows Delete together with Cancel.
  - A lead account can edit an approved event's fields.
  - At 390 px width the footer wraps and shows `Step 3 of 5 · Approved`.
- [ ] **Step 3: Commit** `feat(app): footer wizard + kebab menu; leads can edit approved events (D1, D2, D6)`.

---

### Task 13: Details form: markers, key, required tags, address default; remove live seeding; listing card; preview modal

**Files:**
- Create: `web/listing-html.js`, `proxy/test/listing-html.test.js`
- Modify: `web/app.js`: `renderPlanning`, `wirePlanning`, `publishFieldsHTML`, `renderListingSection`, `wireListingSection`; delete `publishPanelHTML`, `wirePublishPanel`, `loadEbLive` (its status fetch moves to Task 14's `refreshEbStatus`), `seedLiveFields`, `ebLiveHTML`, `_ebDirty`/`markEbDirtyIfPublicChanged`; `CodaSource` add `ebPreview(rowId)`; `close()`/`leaveForm` leave guard
- Modify: `web/index.html` (script tag for `listing-html.js`), `web/styles.css`

**Interfaces:**
- Consumes: Tasks 1, 3, 8.
- Produces:
  - `ListingHtml.sanitize(html) → string`.
    - Allowlist: `p, br, strong, b, em, i, ul, ol, li, a[href]`. `a` keeps only `http(s):`/`mailto:` hrefs and gets `target="_blank" rel="noopener"`.
    - All other tags are unwrapped to text. All attributes except an allowed `href` are dropped.
    - `<script>`/`<style>` content is removed entirely.
    - Implemented as a tokenizer over the string (no DOM), so node can test it.
  - `fieldLabelHTML(key, labelText, ctx)`: the label plus marker icons from `FIELDS[key].public` and `syncStatus` (eye-off / globe / globe+check), with `data-tip` text exactly as the canvas (`Private: only leads and council see this. Never sent to Eventbrite.` / `Public: this becomes part of the Eventbrite listing.` / `Matches the Eventbrite listing: what you see here is what Eventbrite has.`). It also adds the red/amber text tags from readiness/sync (`Needed for Eventbrite`, `● Not on Eventbrite yet` + a hint `Eventbrite: <pushed value>`).
  - A form key above the first Details section, per canvas boards A/E.
  - Address default: when the venue picker changes, if `addressVisibilityDefault(current, venue)` differs from `current`, set the toggle and show the hint `Set to Registrants only because this venue is a private home. The public sees just "Nashville, TN".`
  - Venue hint `The street address is saved on the venue.` Description hint after linking `Editing here turns the description into plain text on Eventbrite (any bold, links or lists added there are removed).`
  - Button renamed `Copy internal description`, with the hint `If you copy the internal description, take out planning notes first. This text goes public.`
  - Listing card (linked events): pill `Private draft`/`Public`, `Registration open · X of Y registered` when public, tickets line `Tickets: General Admission · free · N` and `Paid tickets and discount codes: coming later`.
  - Preview modal (`act:'preview-eb'`): fetches `DB.ebPreview(id)` and renders board E2's layout with `ListingHtml.sanitize(descriptionHtml)`; Close / Publish buttons.
  - Leave guard: in `close()`, if `stageOf(editing)` is `onEventbrite`/`published` and `unpushedFields(...).length`, show an in-modal confirm bar `You have N changes that aren't on Eventbrite yet.` with `Close anyway` / `Keep editing` (no `window.confirm`).
  - `venueRecord(ev) → {name, type, hasAddress}|null` from `VENUES`. Extend the `VENUES` mapping (~L108) with `hasAddress: !!(x.values && x.values['Address'])`.
- [ ] **Step 1: Failing sanitizer tests** (Review Focus 5):
  - `<p>Hi <strong>there</strong></p>` unchanged
  - `<script>alert(1)</script><p>x</p>` → `<p>x</p>`
  - `<p onclick="x">y</p>` → `<p>y</p>`
  - `<a href="javascript:alert(1)">z</a>` → `z`
  - `<a href="https://e.com">l</a>` → `<a href="https://e.com" target="_blank" rel="noopener">l</a>`
  - `<div><span>t</span></div>` → `t`
- [ ] **Step 2:** FAIL. **Step 3:** Implement `listing-html.js`; tests PASS; `node --check`.
- [ ] **Step 4:** Implement the form changes; `node --check web/app.js`.
- [ ] **Step 5: Manual check** (staged Worker, test event, local app). Look for:
  - markers and tooltips on every field
  - picking a Home venue with no address sets Registrants only
  - explicitly choosing Public keeps Public and shows the `venueAddress` message
  - reopening the linked test event does **not** change Capacity: run the Coda formula from Task 11 before and after opening (F11 regression)
  - the preview opens for draft 2004849174851
- [ ] **Step 6: Commit** `feat(app): field markers, readiness on fields, pushed-snapshot sync; remove live seeding (D4)`.

---

### Task 14: Add to Eventbrite / Update draft / Publish / Update listing actions

**Files:**
- Modify: `web/app.js` (replace the Task 12 stubs `add-eb`, `update-eb`, `publish-eb`, `update-listing`; `CodaSource.publishEventbrite` unchanged signature)

**Interfaces:**
- Consumes: Task 6 (409 `{error, checks}`), Task 11 `pendingFor`/`applied`, Task 3 `changeNotice`.
- Produces:
  - `add-eb`/`update-eb` → `publishEventbrite(id, true)`; `publish-eb`/`update-listing` → `publishEventbrite(id, false)`.
  - Before calling: `await flushAutosave()`, then `await` all `applied` for the event; the footer shows `Saving…` meanwhile.
  - On 409 with `checks`: show the first message in the footer (re-render with those checks merged) and toast it. No other UI changes.
  - On success: update `editing.eventbriteId/eventbriteUrl/publishStatus` from the response, store the pushed snapshot locally (`editing.pushed = <values sent>`, mirrored from what `pushedValues` writes), then `renderEditorFooter()`, and re-render only the listing card container (D1).
  - Keep `CodaSource.ebStatus(rowId)` (`GET /eventbrite/status`, unchanged). Task 13 removes only the *seeding* in `loadEbLive`; replace it with `refreshEbStatus(ev)`, which stores `{editedSincePush, sold: live.sold, publishStatus: live.status}` on `_ebStatus[ev.id]` and re-renders the footer and card. `footerModel`'s `registrants` and `ebEditedElsewhere` read from it (`null` until it loads).
  - The conflict notice replaces the old `confirm()`. When `_ebStatus[id].editedSincePush`, the listing card shows `Someone changed this listing on Eventbrite since your last update. Updating will replace their changes.` The primary action passes `force:true` once that notice has been shown.
  - After `update-listing` succeeds, if `changeNotice(before, after).fields.length && registrants>0`, set `justChanged` so the footer shows board G.
- [ ] **Step 1:** `node --check web/app.js`; `npm test`.
- [ ] **Step 2: Manual check** (staged Worker):
  - on the broken test draft 2004849174851, click **Update draft**; with read-only probes, confirm the event now has exactly 1 ticket class with `quantity_total` 20 (F12 repaired) and `Last EB pushed values` is set on the row
  - clear End on a copy of the event → Add to Eventbrite is disabled and the footer links to End
- [ ] **Step 3: Commit** `feat(app): add/update/publish via the wizard with readiness messages`.

---

### Task 15: Email registrants after a change (Q3 interim)

**Files:**
- Modify: `web/app.js` (`email-registrants` handler)

**Interfaces:**
- Consumes: Task 3 `changeNotice`; existing roster fetch (`GET /roster/:rowId`) and `RosterLib` helpers used by the Attendees tab (reuse whatever builds the BCC list there).
- Produces: `email-registrants` builds `mailto:?bcc=<emails>&subject=<changeNotice.subject>&body=<changeNotice.body>` and opens it. When the URL would exceed 1 800 chars, it copies the emails instead and toasts `Emails copied. Paste them into BCC.` (same fallback as Attendees). `Not now` clears `justChanged`.
- [ ] **Step 1:** `node --check`; manual: on the test event with no registrants, board G does not appear (registrants 0); with a fake `justChanged` set in the console, the mailto opens with the change listed.
- [ ] **Step 2: Commit** `feat(app): offer to email registrants after date/time/venue changes`.

---

### Task 16: Unpublish / Cancel / Delete from the ⋮ menu

**Files:**
- Modify: `web/app.js` (`cancelEvent`, `deleteEditor`, new `unpublishEvent`; `CodaSource.unpublishEventbrite(rowId)`)

**Interfaces:**
- Consumes: Task 9 routes.
- Produces:
  - `unpublishEvent()`: `confirm('Make this listing private again? It disappears from Eventbrite and gather until you publish it again.')`, then the route. On success `publishStatus='Draft'`, `published=false`, re-render the footer/card.
  - On 409 `needsEventbriteCancel` (unpublish or cancel): show a message bar in the editor with the route's `error` text, plus `Open in Eventbrite ↗` (`editing.eventbriteUrl`) and `Email the N registrants` (reusing Task 15's mailto builder with subject `Update: <title>` and an empty body). The status does not change.
  - `deleteEditor()`: confirm text `Delete this event? This can't be undone.` plus, when linked, ` Its private Eventbrite draft is deleted too.`. Handles 409/502 from Task 9 by restoring the event and toasting the `error`.
- [ ] **Step 1:** `node --check`; `npm test`.
- [ ] **Step 2: Manual check** (staged Worker, a **new** throwaway test event):
  1. Approve, Add to Eventbrite, Publish.
  2. Unpublish → it's Draft on Eventbrite (read-only probe) and hidden in gather.
  3. ⋮ shows Delete before publishing; Delete removes the Eventbrite draft (GET returns 404 or `deleted`) and the row.
  4. The has-registrants 409 path can't be exercised safely live (it needs real orders). Verify it by calling the route against a fixture in a unit test of the 409 body shape, or by reading the code. Note in the PR that it's untested live.
- [ ] **Step 3: Commit** `feat(app): unpublish, cancel and delete follow Eventbrite's order rules`.

---

### Task 17: Help

**Files:**
- Modify: `web/help/guide.md` (`#edit-details`, `#lifecycle`, `#publish`, `#troubleshooting`)
- Modify: `web/help/whats-new.md`

**Interfaces:**
- Consumes: exact on-screen copy from Tasks 3, 12, 13 and 16.
- [ ] **Step 1: Rewrite** for a non-technical lead (writing guide at the top of `guide.md`), following spec §5.8:
  - drop the lead lock
  - five stages
  - Add to Eventbrite vs Publish
  - the readiness list in plain words
  - Preview
  - Update listing and emailing registrants
  - Unpublish
  - Cancel with registrants (council cancels on Eventbrite)
  - Delete deletes the Eventbrite draft
  - Registrants-only default for homes
  - the marker icons
  - "Saving… can take up to half a minute"

  Put every on-screen label in `[[ ]]`, matching the footer model copy exactly.
- [ ] **Step 2:** Add `## 2026-11-<day>` to `whats-new.md` with 3–5 bullets (newest first).
- [ ] **Step 3:** Run `node scripts/check-help.mjs` and `node scripts/check-help.mjs --branch feat/publish-wizard`. Expected: exit 0.
- [ ] **Step 4: Commit** `docs(help): publish wizard, honest saves, field markers`.

---

### Task 18: End-to-end verification, then PR

- [ ] **Step 1:** `cd proxy && npm test` (all green). `node --check` on every changed `web/*.js`. `./scripts/sync-shared.sh --check`. `node scripts/check-help.mjs --branch feat/publish-wizard`.
- [ ] **Step 2: Staged Worker + local app walkthrough** on a new throwaway event, following canvas boards A→G, using a **lead** account. Then repeat Approve as council. Confirm:
  - every board's footer copy and primary action
  - the Saving… gating
  - Preview
  - Publish, which makes the event visible in gather
  - Update listing after a time change offers the email
  - Unpublish
  - Delete

  Clean up: delete the throwaway event (verify the Eventbrite draft is gone), and unset `localStorage.est-proxy-base`. Kill any live-server/wrangler by PID.
- [ ] **Step 3:** Fix the original test event: with the staged Worker, open "Wandering Scholars Presents: Jewish Futures" and click **Update draft**. Verify Capacity still reads 20 in Coda and the Eventbrite draft has 1 ticket class.
- [ ] **Step 4:** Push the branch and open the PR (the help-guard hook runs on `gh pr create`). The PR body lists:
  - D1–D8 for explicit review
  - the untested-live path (Q2 cancel with registrants)
  - the deploy note: the Worker deploys from `proxy/**` or `web/listing-readiness.js` on merge; the app deploys via Netlify; the app tolerates the old Worker (`/mutation` 404 → immediate resolve)
