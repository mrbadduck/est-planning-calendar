# Glossary

One word per idea, the same in the app, the doc, the code and our conversations.
For each term: what leads see on screen, the Coda column in `EST Planning Events SRC`
(where there is one), and the name in code. If a term changes, change it here in the
same branch.

## Lifecycle stages

An event's **stage** comes from `ListingRules.stageOf(ev)` (`web/listing-readiness.js`).
Only `Status` is stored; the Eventbrite stages are derived from `Eventbrite Event ID`
and `Publish status`.

| On screen | Stored as | Code (`stageOf`) | Meaning |
|---|---|---|---|
| Draft | `Status` = Draft | `draft` | A lead's working copy. Nobody else acts on it. |
| Proposed | `Status` = Proposed | `proposed` | Waiting for Tribal Council. |
| Approved | `Status` = Approved, no `Eventbrite Event ID` | `approved` | Council said yes; not on Eventbrite yet. |
| On Eventbrite | Approved + `Eventbrite Event ID` set, `Publish status` ≠ Published | `onEventbrite` | A private Eventbrite draft exists. Nobody sees it. |
| Published | Approved + `Publish status` = Published | `published` | The public listing is live. |
| Cancelled | `Status` = Cancelled | `cancelled` | Off the calendar's active set; Eventbrite listing torn down. |
| Past | derived: approved (any Eventbrite stage) + date passed | not a stage: `footerModel` step 6, from `input.past` (`isHistory`) | The event has happened. The sixth step of the checklist, and the header badge and List view say the same word; On Eventbrite / Published show as skipped if it never got there. Next (coming soon): expenses and what you learned. The listing row says Not on Eventbrite (no "yet"). |

*Past* (the date has gone by, and the sixth step) and *history* (`isHistory`: approved or published and
past) are derived too. They lock fields; they are not stages. *Past* is also what makes
the sixth step the current one.

## Editor tabs

| On screen | `SECTIONS` id | What it holds |
|---|---|---|
| Listing (was "Details" until 2026-11) | `details` | The Eventbrite listing fields, in listing order. A red dot on the tab means a readiness item for the next step is a Listing field. On phones the listing card and Preview sit at the top. Deep links `?section=details` and `?section=listing`. |
| Planning | `planning` | Private fields: Program(s), Leads, Internal description, and the planning notes doc. Old links `?section=notes` land here. |
| Potluck & Volunteers | `volunteers` | Sign-up slots and claims (the gather app's data). |
| Attendees | `attendees` | Lead-only roster: Eventbrite orders and gather claimants. |
| Budget, Comms, Feedback | — | Muted "Coming soon" tabs that host the feedback board. |

## Event page

| On screen | Code | Meaning |
|---|---|---|
| event page | `#eventPage`, `openEventPage`, `leaveEventPage` | An open planning event: a full page in place of the calendar (not a modal). **← Calendar** or Back returns to the calendar where you left it. |
| **Status & next step** panel | `#epPanel`, `statusPanelHTML`, `renderStatusPanel` (`web/status-panel.js`) | The panel on every tab: the checklist, the readiness rows, the one primary action and ⋮, one sentence of help, the listing card, and the failed-save pill. Painted from `footerModel` (D6). On phones: a status card at the top plus the bottom bar `#epPhoneBar`. |
| checklist (the steps) | `footerModel(...).steps` → `#edStatus`; who/when from `PageRules.stepNotes` | The six lifecycle steps (the five stages, then Past), top to bottom: done ✓, current, to do, or skipped (–, a past event's Eventbrite steps it never reached), with who/when where the row records it (Past: the event date). |
| checklist rows (what's left) | `footerModel(...).checklist` → `#edChecks` | The readiness items for the next push, one per field group: ✓ label, or ✗ a link that focuses the field (`focusField`). |
| **Needs approval** | `#listBar`, `listBarHTML`, `prefs.needsApproval`, `PageRules.needsApproval` | The List view's toggle: shows only Proposed planning events, with a count. Visible to everyone. |

## Fields

| On screen | Coda column | Code (`ev.` / `FIELDS` key) | Notes |
|---|---|---|---|
| Title | `Title` | `title` | Public. |
| Summary | `Public summary` | `publicSummary` | Public. Eventbrite's short summary. |
| Description | `Public description` | `publicDescription` | Public. Sanitized HTML on Eventbrite (`ListingHtml.sanitize`). |
| Internal description | `Event Description` | `description` | Private. Shown as the header subtitle. Never sent to Eventbrite. |
| Planning notes (the Google Doc) | the notes-doc URL column, read by id (`CODA_NOTES_COL_ID`) | the notes doc (`POST /notes-doc`) | Private, one Google Doc per event. Not the same as Internal description. The old `Planning Notes` text column (`planningNotes`) is read-only legacy. |
| Free tickets | `Capacity` | `capacity` | Public. The free General Admission ticket count. Blank = no cap. |
| Address on listing | `Address visibility` | `addressVisibility` | Public. `Public` or `Registrants only`. Private homes default to Registrants only. |
| Venue | `Venue` (relation), `Venue (other)` | `venueName`, `venueOther` | Public. The pushed snapshot stores it as `venueName`. |
| Street / Unit / City / State / ZIP | `Street`, `Unit`, `City`, `State`, `ZIP` on `EST Venues SRC` | `VenueAddress` (`web/venue-address.js`), `proxy/src/venues.js` | Private to editors (`GET /venues/:id`). Read and written by column id. |
| Has an address | derived | `venue.hasAddress` | True when Street and City are both filled; for venues not yet split, when the old `Address` text is non-blank. A row hand-edited in Coda with no State is sent to Eventbrite with the area state (TN; Nashville-only org). |
| Address (venue) | `Address` on `EST Venues SRC` | composed text | Plain text, kept composed from the parts on every venue write; what Eventbrite and older rows read. |
| Program(s), Leads | `Program(s)`, `Leads` (relations) | `programs`/`programNames`, `leads`/`leadNames` | Private. Arrive as names; `mapRelations` maps them to row ids. |

## Publishing

| Term | Where | Meaning |
|---|---|---|
| **Add to Eventbrite** | panel primary, `act: 'add-eb'` | Creates a *private* Eventbrite draft. Needs the `add` readiness checks. Stage becomes On Eventbrite. |
| **Update draft** | panel primary, `act: 'update-eb'` | Re-sends the listing to the private draft. |
| **Publish** | panel primary, `act: 'publish-eb'` | Makes the listing public. Needs the `publish` readiness checks. |
| **Update listing** | panel primary, `act: 'update-listing'` | Re-sends a published listing. May offer to email registrants. |
| Unpublish | ⋮ menu | Takes a published listing back to private. |
| **readiness** | `ListingRules.readiness(ev, {venue, todayISO})` → `{add, publish}` | The checks for the next push, each `{key, field, ok, message}`. The panel, the field markers and the Worker all use the same list (D5). |
| **footerModel** | `ListingRules.footerModel(input)` | Pure function → what the Status & next step panel shows: steps, title, sub line, links to failing fields, the readiness checklist, the one primary action, ⋮ items. `renderStatusPanel` only paints it (D6). |
| published line | `footerModel` → `LIVE_STATUS_TEXT`, `input.liveStatus` (`_ebStatus`) | "Published · registration open / happening now / registration closed / canceled on Eventbrite", from Eventbrite's live status; before it loads, closed once the date has passed. |
| **pushed snapshot** | Coda `Last EB pushed values` → `ev.pushed` | What the Worker last sent to Eventbrite. Written only by the Worker. Field sync status compares the form with it (`syncStatus`, `unpushedFields`), never with live Eventbrite data (D4). |
| Last EB push at / Last published at | Coda columns of those names | ISO text, written by the Worker. |
| **Source** | Coda `Source` (Plan / Eventbrite / Backfill; blank = Plan) → `ev.origin` (not `ev.source`, which is `'planning'`) | Where the row came from. The app writes `Plan` on a new event and never changes it. |
| imported event | `ev.origin === 'Eventbrite'` | An event made directly on Eventbrite that the Worker copied into planning. Shows "Imported from Eventbrite" where the creator's name would be. |
| flow-in | Worker, spec §5.3; decision 0009 | A change made on Eventbrite copied onto the planning row, field by field. Plan's unpushed edits win. |
| Last from Eventbrite | Coda `Last from Eventbrite` → `ev.lastFromEb` `{at, fields}` | JSON written by the Worker on each flow-in. The panel says "Updated from Eventbrite: …" while `at` is later than `Last EB push at` (`PageRules.updatedFromEbLine`). |
| **gCal Event ID** | Coda `gCal Event ID` (`PLANNING_COLS.gcalEventId`) | `ev.gcalEventId` | The Google Calendar event a row put on the calendar. Written only by the Worker (and `scripts/link-gcal-ids.mjs` once, before the cutover). |
| **sync window** | `inSyncWindow` (`proxy/src/gcal.js`) | Rows dated yesterday or later. The calendar sweep looks only at these, so past events are never touched (0010). |
| **GCAL_MODE** | Worker var | `off` / `shadow` / `live`. |
| **shadow mode** | `GCAL_MODE=shadow` | The Worker works out each calendar change and logs it to the Publish Log (target `Google Calendar`) without calling Google. Used for a week before going live. |
| calendar sweep | `sweepGcal`, `GCAL_CRON` | The 15-minute run that brings the calendar in step with every row in the sync window. Publish, Cancel and Unpublish sync their own row at once. |

## Saving

| Term | Code | Meaning |
|---|---|---|
| Saved | `applied`, `CodaApplied` | Coda has *applied* the write, not just accepted it (D3). Takes 25–35 s. |
| Saving… / Still saving… | `pendingFor(id)` | Something for this event is queued, in flight or not yet applied. "Still saving…" after 20 s. |
| Save failed — retry | `#saveStatus` | The only save state with its own pill, in the Status & next step panel. Click to retry. |
| save queue | `saveQueue` (`web/save-queue.js`) | Per event: one write in flight, later edits coalesce. |
