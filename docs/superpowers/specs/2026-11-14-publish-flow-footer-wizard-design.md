# Design: Publish flow, footer wizard and honest saves

**Status:** draft for review · **Date:** 2026-11-14
**Design canvas:** https://claude.ai/artifact/AeaeVySLeUM866d1emm8Ct (page "Full form + footer wizard")
**Supersedes, in part:** `2026-08-22-eventbrite-publish-design.md` (publish UX, the publish panel), `2026-08-23-status-machine-and-editor-refinements.md` (footer transitions, the "approved = locked for leads" rule).

## 1. Why

On 2026-11-14 a program lead tried to get one event onto Eventbrite. Several things went wrong:
- The "Create draft" button failed repeatedly with Eventbrite errors ("…require a quantity_total") that didn't mention any field on screen.
- Filling the field in and retrying failed the same way.
- Each failure stacked another "EVENTBRITE" heading on the panel.
- The attempt that finally "worked" left a half-built listing behind.

A persona review of the redesign (Dana, a non-technical volunteer lead) found more risks:
- Home addresses defaulting to public.
- Registrants not being told about time changes.
- "Add" and "Publish" being confused.

**Goal:** a lead can take an approved event from approval to public in one sitting. At every moment they can see:
- what each field does,
- what's still needed and why,
- whether anything is public yet.

The system never acts on stale data, and never quietly changes the user's input.

## 2. Verified facts this design rests on

Everything here was checked on 2026-11-14, against the live systems where it was safe to do so. Probe scripts are in this session's scratchpad (`probes/`).

| # | Fact | How verified |
|---|---|---|
| F1 | A Coda row write returns **202** + `requestId`. The value is **not applied** until `GET /mutationStatus/{requestId}` says `{"completed": true}`. Apply time was **13 s, 27 s, 30 s** for three single-cell writes. | Live write to `EST Planning Events SRC`; one no-op write, one reversible 20→21→20 |
| F2 | Once `completed: true`, both `GET row` and `list rows` return the new value immediately. | Same probe |
| F3 | `mutationStatus` with an unknown id returns **400** ("The given request ID is not valid."). | Same probe |
| F4 | The Worker passes Coda's 202 body straight to the app (`pass(w)`). The app calls a save "Saved" at that point. `transitionTo` writes Status the same way. | `proxy/src/worker.js` rows route; `web/app.js` `saveQueue`, `transitionTo` |
| F5 | Cloudflare Workers **Free** plan: **50 subrequests per request**, 10 ms CPU, no wall-clock limit. EST's Worker has no paid-plan settings. The publish route already makes ~20 subrequests. | developers.cloudflare.com/workers/platform/limits; `proxy/wrangler.toml` |
| F6 | Eventbrite **Publish** requires "a name and description, an organizer, at least one ticket, and valid payment options". | Eventbrite API reference, "Publish an Event" |
| F7 | Eventbrite **Unpublish**, **Cancel** and **Delete** all require that the event has **no pending or completed orders** (for free events). | Eventbrite API reference, those three entries |
| F8 | Eventbrite returns **404** for a draft's public page to anyone not logged in, and has no shareable draft-preview link. `GET /events/{id}/description/` returns the full HTML description. | Logged-out GET of `/e/2004849174851`; API reference "Retrieve Full HTML Description" |
| F9 | Eventbrite paths without a trailing slash **301-redirect** (e.g. `/ticket_classes` → `/ticket_classes/`). The Worker already uses slashes; the Coda pack was fixed in v76. | Read-only probe; pack fix commit `1fe91ec` |
| F10 | Test draft **2004849174851** ("Wandering Scholars Presents: Jewish Futures"): `capacity: 0`, **no ticket classes**, `online_event: true`, `summary: null`, structured content with **0 modules**. | Read-only GET |
| F11 | The Worker reports Eventbrite `capacity: 0` as `null` (`num(b.capacity) \|\| null`). `seedLiveFields` then puts `''` in the Capacity field and **autosaves it**, wiping the staged value (here 20). This happened on the test event and was restored by hand. | Code read + Coda formula + restore |
| F12 | On a retry after a failed first push, the Worker takes the **update** path, which only updates a ticket class it already has an id for. If the first push failed at the ticket step, **no ticket class is ever created**. | `worker.js` publish step 3; Coda row has blank `Eventbrite Ticket Class ID` |
| F13 | `ensureEbVenue` **silently makes the event online** when there's no venue, when the venue is a Public venue with no street address, or when the venue was typed into **Venue (other)** (never sent). **33 of 50 open venues have no address** (15 of 31 Homes). | Code read + Coda count |
| F14 | Venue types: Home, Restaurant/Bar, Greenspace, Public Facility, Other. Every venue has an `Address` column. `/ref/venues` already returns whole rows. | Coda read; `worker.js` `/ref` |
| F15 | The publish panel is replaced with `document.getElementById('f_publish').outerHTML = publishPanelHTML(...)`. That HTML includes the `.fld` wrapper and its **"Eventbrite" label**, but `#f_publish` is the inner node, so each swap nests one more label. | `web/app.js` publish handler |
| F16 | "Approved = locked for leads" is a **documented** rule (help guide #edit-details, #publish: "Tribal Council publishes it"). It is enforced only in the UI (`locked = approved && !canApprove`); the Worker lets any lead push. | `web/app.js` `openEditor`; `web/help/guide.md` |
| F17 | gather shows an event to members when `Published?` is true and Status isn't Cancelled. | `proxy/src/gather.js` `isPublishedUpcoming` |
| F18 | A shared browser script (`web/*.js`, attaching to `globalThis`) can be imported by the Worker as a side effect, and wrangler bundles it correctly. | Scratch bundle with wrangler 4.162 dry-run + executed |

## 3. Decisions (made with Eric, 2026-11-14)

1. **Two verbs.** **Add to Eventbrite** creates or updates a *private draft* listing. **Publish** makes it public and opens registration, and is offered only once the event is on Eventbrite.
2. **Five stages** shown as a progress line: Draft → Proposed → Approved → On Eventbrite → Published. Cancelled and Past sit outside the line.
3. **Footer wizard on the Details tab only.**
   - Left: the stage progress line plus one sentence on what happens next.
   - Right: **one primary slot** holding the single next action. It shows "Saving…" while a change is unsaved.
   - Far right: a **⋮ menu**.
   - Other tabs keep a plain footer: the save state and ⋮.
4. **Cancel and Delete never appear together.** Before publishing, ⋮ offers **Delete**. After publishing it offers **Unpublish** (only possible with no registrants) and **Cancel event**; Delete appears only after an event is cancelled.
5. **Leads keep editing after approval.** The lead lock is removed. This changes documented behavior (F16) on purpose.
6. **No re-approval** for date, time or venue changes after publishing. **Update listing** is enough, followed by an offer to email registrants.
7. **No hidden fallbacks.** An empty public summary or description is never filled from the internal description. "Copy internal description" stays an explicit button with a warning.
8. **Field markers:**
   - eye-off icon = private
   - globe = public
   - globe + check = public and matches Eventbrite
   - text tags only when action is needed: red **Needed for Eventbrite**, amber **Not on Eventbrite yet** (with the Eventbrite value shown)
   - a key at the top of the form explains them
9. **Address defaults to Registrants only** when the venue's type is **Home**.
10. **Preview** renders the draft's own Eventbrite data (F8) in the plan app's layout.
11. **Tickets and discount codes are pinned for later.** The app keeps creating one free General Admission ticket sized by Capacity.

## 4. Open questions (need Eric's answer before the tasks they block)

- **Q1. Who can delete before publishing?** Today Delete is council-only, on the server too. Under decision 4, a lead who wants to call off an unpublished event has nothing to click.
  - **(a)** Leads can delete events that were never published.
  - **(b)** Delete stays council-only, and leads ask council.

  *Recommended: (a).* Nothing public exists yet, and a lead can already delete what they created via Cancel today. Blocks task group G.
- **Q2. Cancelling a published event that has registrants.** Eventbrite's API refuses (F7). The current Worker assumes it works ("has registrants → cancel + notify"), so it fails for any event people registered for. Proposal:
  1. The Worker checks for registrants first.
  2. If there are any, it changes nothing and returns `needsEventbriteCancel` with the count.
  3. The app explains: "Eventbrite only lets someone with East Side Tribe's Eventbrite login cancel an event people have registered for (it refunds and emails them). Ask council to cancel it on Eventbrite, then click Cancel event here again."
  4. It shows the Open-in-Eventbrite link and an "Email the 12 registrants" draft.

  Blocks task group G.
- **Q3. Emailing registrants after a change.** Interim: reuse the Attendees tab's existing BCC `mailto:` (roster emails), prefilled with what changed, until Mailchimp comms (end-state spec §6.3) exist. *Recommended: yes.* Blocks task group H.

## 5. Design

### 5.1 Stage model (one function, shared)

`stageOf(ev, todayISO)`:

| Condition | Stage |
|---|---|
| `status === 'cancelled'` | `cancelled` |
| `status === 'draft'` | `draft` |
| `status === 'proposed'` | `proposed` |
| `status === 'approved'`, no `eventbriteId` | `approved` |
| `status === 'approved'`, `eventbriteId`, `publishStatus !== 'Published'` | `onEventbrite` |
| `status === 'approved'`, `publishStatus === 'Published'` | `published` |

`past` is a flag (`isHistory`), not a stage, so the progress line still shows where the event got to.

### 5.2 Readiness (one list, enforced in app and Worker)

`readiness(ev, venue)` → `{ add: Check[], publish: Check[] }`. Each `Check = {key, field, ok, label, message}`. The app shows the failing ones in the footer and on the fields. The Worker runs the **same function** before calling Eventbrite and returns its messages (logged).

**Add to Eventbrite** requires:
- Status Approved
- Title
- Exact scheduling (not range/month, not all-day)
- Date that's in the future
- Start and End, with End after Start
- Capacity, a whole number ≥ 1
- A location Eventbrite can take:
  - no venue → online, allowed
  - a **Venue (other)** name → blocked: "Add this venue to Venues first"
  - Address visibility **Public** at a venue with no address → blocked: "Add a street address to the venue, or choose Registrants only" (F13)

**Publish** additionally requires:
- a **Public description** (F6, and decision 7)
- the listing exists and has ≥ 1 ticket class (the Worker repairs this; see 5.6)

Public summary is recommended, not required.

### 5.3 Honest saves ("Saved" means applied)

- **Worker:** new `GET /mutation/:requestId` → `{completed}`, proxying `mutationStatus`. It requires a write-authorized identity, like other write routes. Each poll is its own request (one subrequest), so the free-plan limit (F5) isn't a concern.
- **App:** a small pure helper, `waitApplied(requestId, {fetchStatus, sleep, now})`, polls at 1 s, then 1.5 s, then 2 s.
  - After 20 s it reports "slow" ("Still saving — Coda is slow right now"). It keeps going until 120 s, then rejects as a save failure (retryable; re-sending the same cells is safe).
  - A missing route (404, during a deploy gap) resolves immediately, degrading to today's behavior.
  - Wired in at three places:
    1. The `saveQueue` write function: `DB.update(...)`, then `waitApplied`. One write is in flight per event and later edits coalesce, so a 30 s apply naturally batches edits.
    2. `transitionTo` (Status writes), so Approve → Add to Eventbrite can't hit "must be Approved" (F4).
    3. `DB.create`: the new event's id is tracked as having an unapplied mutation, and the footer's primary action waits on it.
- **UI:**
  - The save pill and the footer primary slot read one source: `pendingFor(id)`, meaning anything queued, in flight or not yet applied.
  - While it's true, the primary slot is a disabled **Saving…** button and actions that read Coda are unavailable.
  - The pill says "Saved" only when it's false.
- **Worker publish route:** no polling. It re-runs readiness on what it reads, so a stale read produces a clear "needs X" message instead of an Eventbrite error.

### 5.4 After the listing exists: compare against what was pushed, never auto-write

Today the form re-seeds the public fields from the live listing and autosaves them. That is how Capacity got wiped (F11). New rule:

- **The form always shows the event's own (Coda) values.** Nothing is written to Coda unless the user edits a field.
- On every successful push the Worker writes **`Last EB pushed values`**: a new text column holding JSON of exactly what it sent (title, date, start, end, capacity, summary, description, venue name, address visibility, ticket class id).
- **Field sync status** = form value vs pushed value. Equal → globe + check. Different → amber **Not on Eventbrite yet**, plus "Eventbrite: <pushed value>".
- **Eventbrite-side edits** are still detected with the existing `changed` vs `Last EB push at` guard, and shown as a notice ("Someone changed this listing on Eventbrite since your last update; updating will replace their changes") instead of a mid-push `confirm()`.
- **Events pushed before this change** have no pushed snapshot. Their fields show the globe only, with no check and no amber, until the next push writes one. Nothing is inferred and nothing is written.
- **Description:** the Worker skips rewriting Eventbrite's structured content when the description equals the pushed snapshot. This preserves rich formatting added on Eventbrite (today it compares with the live stripped text).

### 5.5 The footer wizard

**A pure model function** in the shared module decides what the footer shows:

`footerModel({stage, past, role, readiness, pending, ebEditedElsewhere, unpushedCount, lastChange})` → `{steps, title, sub, links, primary:{label, act, enabled, tone}, secondary?, menu:[{act, label, sub, tone}]}`

All copy comes from here, so it is unit-tested and is the single place the help guard's `[[labels]]` must match.

| Stage | Title / sub | Primary | ⋮ menu |
|---|---|---|---|
| draft (lead) | "Draft: only leads can see this" / "Propose it when the plan is ready. Rough dates are fine for now." | Propose to council | Delete event (per Q1) |
| proposed (lead) | "Awaiting Tribal Council approval" / "You can keep editing meanwhile. This footer changes as soon as council approves." | ✓ Saved (text) | Delete event (per Q1) |
| proposed (council) | "Needs your approval" / "Proposed <date> by <name>. Approving lets the lead add it to Eventbrite and publish it." | Approve | Delete event |
| approved, not ready | "Approved. N things left before Eventbrite" / links per failing check + "Then Add to Eventbrite creates a private draft. Nobody sees it until you publish." | Add to Eventbrite (disabled) | Delete event |
| approved, ready | "Ready for Eventbrite" / "Adding creates a private draft listing. Nobody can see it until you publish." | Add to Eventbrite | Delete event |
| onEventbrite | "On Eventbrite as a private draft" / "Preview shows exactly what Eventbrite has. Publish makes it public and opens registration." (+ "N changes aren't on Eventbrite yet" when unpushed) | Publish, or **Update draft** if unpushed, or disabled if publish-checks fail. Secondary: Preview listing | Delete event (also deletes the Eventbrite draft) |
| published | "Published · registration open · X of Y registered" / "N changes aren't on Eventbrite yet: …" | Update listing (when unpushed) else ✓ Saved | Unpublish (back to private) · Cancel event… |
| published, just updated date/time/venue | "The start time changed. Let the N registrants know?" | Email registrants · secondary: Not now | same |
| cancelled (council) | "Cancelled" / … | Reopen | Delete event |
| any, `pending` | (unchanged title) | **Saving…** (disabled) | unchanged |

On phones (≤ 600 px, `PHONE_MQ`), the steps collapse to "Step 3 of 5 · Approved" and the buttons wrap below the text.

### 5.6 Worker changes

- **`POST /publish/eventbrite`:**
  - (a) Runs shared readiness for the requested step and returns 409 `{error, checks}` on failure. Every early return is now **logged** to the Publish Log (today 409s aren't, which is why two of the 2026-11-14 failures left no trace).
  - (b) **Ticket repair:** on the update path with no stored ticket class id, `GET /events/{id}/ticket_classes/`:
    - 0 classes → create the General Admission class and store its id
    - exactly 1 → adopt it (store its id; update quantity from Capacity)
    - more than 1 → leave alone ("managed in Eventbrite")
  - (c) **No silent online:** `ensureEbVenue` no longer falls back to online. Readiness prevents those cases, and if one still reaches the Worker it fails with a clear message.
  - (d) Writes `Last EB pushed values` on success.
  - (e) Description skip compares against the pushed snapshot (5.4).
  - (f) No internal-description fallback on create (decision 7).
- **New `GET /eventbrite/preview?rowId=`** → `{name, summary, descriptionHtml, start, end, timezone, location:{online, name, displayAddress}, tickets:[{name, free, quantityTotal}], logoUrl, status}`.
  - Built from `GET /events/{id}/?expand=venue,ticket_classes,logo` and `GET /events/{id}/description/` (2 subrequests).
  - The app renders `descriptionHtml` through a small allowlist sanitizer (p, br, strong, em, ul/ol/li, a[href]); everything else becomes text.
- **New `POST /unpublish/eventbrite {rowId}`:**
  - Calls `ebUnpublish`.
  - On success: `Publish status = Draft`, `Published? = false` (so gather hides it, F17), plus a log row.
  - On Eventbrite's has-orders refusal: 409 `{needsEventbriteCancel, registrants}`.
- **`POST /cancel/eventbrite`:**
  - Checks registrants first (`ticket_classes[].quantity_sold` from the event expand).
  - With registrants: per **Q2**.
  - Without: unpublish (or delete the draft), then Status Cancelled, `Published? = false`.
- **`DELETE /rows/:id`:**
  - Permission per **Q1**.
  - If the row has an Eventbrite id: `DELETE /events/{id}/` first (allowed with no orders, F7). Stop with a clear error if Eventbrite refuses.
  - The row can't be deleted while Published (it must be cancelled first, decision 4).
- **New `GET /mutation/:requestId`** (5.3).
- **Shared module:** the Worker imports `web/listing-readiness.js` for its side effect (F18). `.github/workflows/deploy-proxy.yml` gains that path in its `paths:` filter, so a readiness change redeploys the Worker.

### 5.7 App changes (Details tab)

- **Remove:** `publishPanelHTML`, `wirePublishPanel`, `loadEbLive`, `seedLiveFields`, `_ebDirty`, the left-footer transition buttons (`footerActionsHTML`), and the lead lock.
- **Add:**
  - **Form key** at the top of Details: globe = public, eye-off = private, check = matches Eventbrite. Shown before and after the listing exists, as relevant.
  - **Field markers** on every field label, from a field-visibility map in the shared module. Hover text uses the existing `data-tip` tooltip (not `title=`, per the app convention), plus `aria-label`.
  - **Required tags** from readiness, on the fields. The footer links scroll to and focus the field.
  - **Address visibility default:** when a Home-type venue is picked and visibility is unset, set Registrants only and say why. Never override a value the user chose.
  - **Venue hint:** "The street address is saved on the venue." When the venue has no address and visibility is Public, readiness says what to do.
  - **Listing card** (once linked): status pill (Private draft / Public), registered count, tickets line ("General Admission · free · N" + "Paid tickets and discount codes: coming later"), "View on Eventbrite ↗" for those with a login.
  - **Preview modal** (E2 on the canvas).
  - **Copy internal description** button (renamed), with its warning hint.
  - **Description hint** after linking: "Editing here turns the description into plain text on Eventbrite."
  - **Leave guard:** closing the editor with unpushed changes on a linked event asks "You have N changes that aren't on Eventbrite yet. Close anyway?". Same mechanism as today's close path; no browser `confirm()` on page unload beyond the existing `beforeunload`.

### 5.8 Help (ships with the change; enforced by the help guard)

- **Rewrite** `#edit-details` (drop the lock sentence), `#lifecycle` (five stages, Delete vs Cancel rules), `#publish` (two verbs, readiness list, preview, unpublish, updating and telling registrants, the Registrants only default), `#troubleshooting` (Saving… takes a while; "Needed for Eventbrite").
- **Fix two claims that are false today:**
  - that cancel works after people register (F7)
  - that Delete "doesn't touch Eventbrite" (it now deletes the draft)
- **`whats-new.md`:** one dated entry.
- **Every `[[label]]`** must match `footerModel`'s copy and the field labels exactly.

## 6. Departures from existing patterns (for explicit review)

| # | Old pattern | New pattern | Why |
|---|---|---|---|
| D1 | Partial UI updates by `outerHTML` swaps of nodes whose HTML includes its own wrapper (`publishPanelHTML`) | A stable container per region (`#edFoot`, `#listingCard`, …) rendered with `el.innerHTML = view(model)`. Render functions return **inner** markup only. | F15: the swap nested a label on every failure. Containers that never move make that class of bug impossible. |
| D2 | Positional flags threaded everywhere: `(ev, canEdit, locked, canApprove, pastLocked)` | One `ctx` object built once in `openEditor`: `{ev, role:{canEdit, canApprove}, stage, past, locked}`, passed whole | Fewer argument-order bugs; adding the stage/role rules needed here would make the signatures worse. Existing tabs (Notes, Potluck, Attendees) can take `ctx` later; for now an adapter passes the old args. |
| D3 | "Saved" = Coda accepted the write (202) | "Saved" = Coda applied it (`mutationStatus.completed`) | F1/F2/F4: acting right after "Saved" read stale data. |
| D4 | Linked events re-seed fields from the live listing and autosave them ("Eventbrite is the truth") | Form shows Coda's values; sync status compares to a stored **pushed snapshot**; nothing auto-writes | F11: re-seeding wiped Capacity. Eventbrite's `summary` is write-only and its description is normalized HTML, so live comparison was never reliable. |
| D5 | Business rules duplicated or split between app (button gating) and Worker (some checks) | One pure shared module (`web/listing-readiness.js`): stage, readiness, field visibility, footer model. Imported by the app, the Worker (F18) and node tests | One list the button and the server can't disagree on. |
| D6 | Footer markup assembled in `openEditor` | `footerModel()` (pure, tested) → `renderEditorFooter(model)` (thin DOM) | The wizard's copy and logic become testable and are the help guard's source of truth. |
| D7 | Silent fallbacks (online venue, internal description) | Fail with a message the user can act on | Decision 7, F13. |
| D8 | Mid-push `window.confirm()` for the Eventbrite-edited conflict | A visible notice on the listing card before the user clicks; the Worker still guards with 409 | The user learns about the conflict before clicking, not after. `confirm()` stays for destructive confirmations (cancel/delete), which is fine. |

## 7. Out of scope

Tickets and discount codes (pinned). Mailchimp comms (end-state spec). gCal from the Worker. Event-table convergence. id-hardening the planning seam beyond the new column (CLAUDE.md "deferred id-hardening").

## 8. Risks

- **Saves now take Coda's real apply time (13–30 s).** Mitigations:
  - Autosave stays invisible apart from the pill.
  - Only the primary action waits, and it says why.
  - The "slow" message appears after 20 s.
- **Shared module imported by the Worker:** a browser-incompatible change would break the Worker. Node tests import it the same way, and the deploy workflow path filter catches changes.
- **Removing the lead lock** lets any lead edit any approved event. That matches what the Worker always allowed (F16).
- **Q2's interim** relies on council having Eventbrite access.
