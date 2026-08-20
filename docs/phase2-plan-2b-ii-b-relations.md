# Phase 2 · Plan 2b-ii-b — leads / volunteers / venue pickers + Planning Notes

> **Status: ✅ DONE (Aug 2026).** Follows the 2b-ii-a pattern (name→id mapping via
> a loaded reference list; relations written as row ids).

**Goal:** Replace the last "set in Coda" placeholders in the editor with real
relation pickers, and give new events a Planning Notes template.

## Decisions (confirmed)

- **Leads** = a **chip list** of *write-authorized* people only — `Leadership
  Status` includes `Program Lead` or `Tribal Council` (~28). Same cohort the
  Worker lets write. (Mirrors the program chip picker.)
- **Volunteers** = a **typeahead over all ~1128 people** → removable chips. Needs
  a new `Volunteers` relation column on the planning table (added this plan).
- **Venue** = cascade: `Venue Type` select → `Venue` select filtered to that type
  and excluding `Closed/Unavailable?` → plus the existing `Venue (other)` free
  text.
- **Planning Notes** = textarea seeded with the 6-prompt template (from
  `phase2-planning-table.md`) for new events.
- **Slim `/ref/people` projection** (Worker): the People table is ~1128 rows ×
  ~50 cols. `/ref/people` returns only `{id, name, lead}` (`lead` = write-
  authorized). One fetch powers both the Leads filter and the Volunteers
  typeahead. `/ref/venues` (53) and `/ref/venue-types` (5) stay full.
- Relations come back from Coda as **display-name strings** (confirmed), so
  pre-selection maps name→id via the loaded lists (same as `Program(s)`). Caveat:
  identical person names could mis-preselect (rare, low-stakes).

## Tasks

### Task 1 — foundation (reads + schema)
- [x] Worker `/ref/people` slim projection `{id, name, lead}`; deploy via wrangler
      (CI secret is missing — manual deploy).
- [x] Add `Volunteers` column (relation → `EST People SRC`, multiple) to
      `EST Planning Events SRC` (`grid--gYIvdD-cE`).
- [x] App: `loadPeople()` (→ `PEOPLE_LIST` {id,name,lead}, `peopleIdByName`,
      `LEADS_LIST` = leads only) and `loadVenues()` (→ `VENUES` {id,name,type,
      closed}, `VENUE_TYPES`, name→id maps). Call in `init()` before `loadEvents()`.
- [x] `planningRowToEvent`: map `Leads`/`Volunteers`/`Venue`/`Venue Type` names→ids
      (`event.leads`, `event.volunteers`, `event.venue`, `event.venueType`);
      `event.venueOther` = `Venue (other)`.

### Task 2 — Leads chip list + write
- [x] Editor: `#f_leads` chip multi-select over `LEADS_LIST`, pre-pressed from
      `event.leads`, gated by `canWrite`. Retire the hardcoded `PEOPLE`.
- [x] `readForm` → `leads` (ids); `eventToCodaCells` writes `Leads` = person ids.

### Task 3 — Volunteers typeahead + write
- [x] Reusable typeahead (input → filtered suggestions over `PEOPLE_LIST` → add
      chip; chips removable). `#f_vols`, pre-filled from `event.volunteers`.
- [x] `readForm` → `volunteers` (ids); `eventToCodaCells` writes `Volunteers`.

### Task 4 — Venue cascade + write
- [x] `#f_vtype` (Venue Type) → `#f_venue` filtered by type & `!closed`; `#f_vother`
      free text. Pre-fill from `event.venueType`/`venue`/`venueOther`.
- [x] `readForm` → `venueType`/`venue`/`venueOther`; `eventToCodaCells` writes
      `Venue Type`, `Venue`, `Venue (other)`.

### Task 5 — Planning Notes template
- [x] `#f_notes` textarea, seeded with the template for new events; pre-filled for
      existing. `readForm` → `planningNotes`; write `Planning Notes`.

### Task 6 — ship + verify
- [x] Remove the "Leads & venue: set in Coda" locknote. `node --check`.
- [x] Manual proxy deploy (people projection live). Rendering + interactive
      pickers verified locally (dev override).
- [ ] Pages deploy; sign in and create/edit an event with leads + volunteers +
      venue + notes → confirm the relations persisted (Coda MCP).
- [x] Tick 2b-ii-b in `CLAUDE.md` + `phase2-planning-table.md`.
