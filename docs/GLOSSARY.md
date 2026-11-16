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

*Past* (the date has gone by) and *history* (`isHistory`: approved or published and
past) are derived too. They lock fields; they are not stages.

## Editor tabs

| On screen | `SECTIONS` id | What it holds |
|---|---|---|
| Details (the spec renames it **Listing**, pending Eric's OK) | `details` | The Eventbrite listing fields, in listing order, plus the listing card and Preview. Deep links `?section=details`. |
| Planning | `planning` | Private fields: Program(s), Leads, Internal description, and the planning notes doc. Old links `?section=notes` land here. |
| Potluck & Volunteers | `volunteers` | Sign-up slots and claims (the gather app's data). |
| Attendees | `attendees` | Lead-only roster: Eventbrite orders and gather claimants. |
| Budget, Comms, Feedback | — | Muted "Coming soon" tabs that host the feedback board. |

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
| Program(s), Leads | `Program(s)`, `Leads` (relations) | `programs`/`programNames`, `leads`/`leadNames` | Private. Arrive as names; `mapRelations` maps them to row ids. |

## Publishing

| Term | Where | Meaning |
|---|---|---|
| **Add to Eventbrite** | footer primary, `act: 'add-eb'` | Creates a *private* Eventbrite draft. Needs the `add` readiness checks. Stage becomes On Eventbrite. |
| **Update draft** | footer primary, `act: 'update-eb'` | Re-sends the listing to the private draft. |
| **Publish** | footer primary, `act: 'publish-eb'` | Makes the listing public. Needs the `publish` readiness checks. |
| **Update listing** | footer primary, `act: 'update-listing'` | Re-sends a published listing. May offer to email registrants. |
| Unpublish | ⋮ menu | Takes a published listing back to private. |
| **readiness** | `ListingRules.readiness(ev, {venue, todayISO})` → `{add, publish}` | The checks for the next push, each `{key, field, ok, message}`. The footer, the field markers and the Worker all use the same list (D5). |
| **footerModel** | `ListingRules.footerModel(input)` | Pure function → what the Status & next step panel shows: steps, title, sub line, links to failing fields, the readiness checklist, the one primary action, ⋮ items. `renderStatusPanel` only paints it (D6). |
| **pushed snapshot** | Coda `Last EB pushed values` → `ev.pushed` | What the Worker last sent to Eventbrite. Written only by the Worker. Field sync status compares the form with it (`syncStatus`, `unpushedFields`), never with live Eventbrite data (D4). |
| Last EB push at / Last published at | Coda columns of those names | ISO text, written by the Worker. |

## Saving

| Term | Code | Meaning |
|---|---|---|
| Saved | `applied`, `CodaApplied` | Coda has *applied* the write, not just accepted it (D3). Takes 25–35 s. |
| Saving… / Still saving… | `pendingFor(id)` | Something for this event is queued, in flight or not yet applied. "Still saving…" after 20 s. |
| Save failed — retry | `#saveStatus` | The only save state with its own pill. Click to retry. |
| save queue | `saveQueue` (`web/save-queue.js`) | Per event: one write in flight, later edits coalesce. |
