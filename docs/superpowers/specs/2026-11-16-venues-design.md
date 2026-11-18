# Venues: add a venue and fix its address from the app

**Status:** design, 2026-11-16. Eric asked for it ("one of the last truly basic things a lead should be able to do easily") and skipped the questions as mechanical; the calls below are mine unless marked. Stacks on `feat/event-page` (PR #38) and releases with #35–#38.

## 1. Why

A lead planning an event at a place EST hasn't used can't pick it: the Venue picker only lists `EST Venues SRC`, and the fallback **Venue (other)** free text blocks Eventbrite ("Add this venue to Venues first"). A venue with a missing or messy address blocks a public listing ("Add a street address to the venue"), and the only fix is editing Coda by hand. The address is one free-text **Address** cell that the Worker parses (`parseUsAddress`) into Eventbrite's street/city/state/ZIP, which has needed repeated fixes (R22, Inglewood Lounge). Changing an address in Coda also doesn't reach Eventbrite, because each venue caches its Eventbrite venue id.

## 2. Goals

- From the event's **Where** block, a lead can **add a new venue** (name, type, address) in a few fields and have the event use it.
- A lead can **fix a venue's address** from the same place; the next push to Eventbrite uses the new address.
- Addresses are stored as structured fields (Street, Unit, City, State, ZIP), so Eventbrite gets exact fields with no parsing.
- The two readiness blockers about venues link straight to these actions.

## 3. Non-goals

- Editing other venue fields (contact, website, notes, hosts) — Coda stays the place for those.
- Deleting or merging venues; closing a venue (`Closed/Unavailable?`).
- Address autocomplete/geocoding.
- Removing **Venue (other)** (kept for old rows; new UI steers away from it).

## 4. Anti-goals

- A private home's street address showing to anyone who doesn't need it, or on a public listing when the event is Registrants only (existing safety split in `venuePayload` must hold).
- Duplicate venues created by accident (same name twice).
- An event pointing at a venue row that Coda hasn't created yet (the ~28 s apply lag).
- Breaking anything in Mission Control that reads the existing **Address** column.

## 5. Design

### 5.1 Data (Coda `EST Venues SRC`, `grid-foC40iAOaX`)

- **Add five text columns:** `Street`, `Unit`, `City`, `State`, `ZIP`. Their ids go in `proxy/src/coda-columns.js` (new code reads and writes by id).
- **Keep `Address`** as plain text, and keep it in step: every app write sets `Address` to the composed one-line form (`Street, Unit, City, ST ZIP`), so other Mission Control uses keep working.
- **Backfill** the 53 existing rows once: parse each `Address` with `parseUsAddress` into the five columns. Done as a reviewed one-off: the builder produces a dry-run table (row, Address → Street | Unit | City | State | ZIP, flagged rows that didn't parse cleanly) for Eric to approve; only then is it written. **Needs Eric's OK** (live Coda writes), as does adding the columns.
- "Has an address" = `Street` and `City` present (structured), else the old `Address` cell (rows not yet backfilled).

### 5.2 Worker routes (role-gated: `canWrite` = Program Lead or Tribal Council)

- `GET /venues/:rowId` → `{id, name, type, street, unit, city, state, zip}`. Addresses stay out of the shared, cached `/ref/venues` list (private homes); this per-venue read is for the edit form only.
- `POST /venues` `{name, typeId, street, unit, city, state, zip}` → creates the row; returns `{id, requestId}`.
  - `name` required, trimmed; rejected (409, "A venue called X already exists") if it matches an existing venue case-insensitively.
  - `typeId` must be an existing Venue Type row.
  - Address rules (shared, pure, tested): Street + City + State (2 letters) required for a full address; ZIP optional (5 or 5+4). A venue may be saved without an address only if its type is Home — then events there must be Registrants only to publish (existing rule).
- `PUT /venues/:rowId` `{street, unit, city, state, zip}` → updates the address; **clears both cached Eventbrite venue ids** (`Eventbrite Venue ID`, `Eventbrite Private Venue ID`) in the same write, so the next push creates an Eventbrite venue with the new address. Returns `{requestId}`.
- All three bust the `ref-venues-v2` KV cache. Writes set `Address` (composed) too.
- Eventbrite: `venuePayload` uses the structured fields when `Street` and `City` are present; otherwise today's `parseUsAddress(Address)` path (old, un-backfilled rows). `venueRefItem.hasAddress` follows the "has an address" rule.

### 5.3 App (Where block on the Listing tab, and the create form)

- **Add a venue:** when the venue search has no exact match, the dropdown's last row is **+ Add "<typed name>" as a venue**. It opens an inline form in the Where block (not a modal): Name (prefilled), Venue type (the existing types), Street, Unit (optional), City (default Nashville), State (default TN), ZIP. **Add venue** / **Cancel**.
  - On Add: the Worker creates the row; the app waits until Coda has applied it (D3, `CodaApplied`), showing "Adding venue…" in the form; then adds it to the local venue list and selects it on the event (the normal autosave writes the Venue relation). On failure the form stays with the message.
  - Available to anyone who can edit the event.
- **Fix an address:** under the selected venue, a muted line shows its address when known (fetched with `GET /venues/:id` when the Where block renders for an editor) and an **Edit address** link; when there's no address, the line reads "No street address yet" with **Add address**. The link opens the same inline form with Name and Type read-only. On Save: `PUT`, wait applied, update the line, re-run readiness. A note in the form: "This changes the address for every event at this venue."
- **Readiness links:** "Add this venue to Venues first" (venueOther) opens Add a venue prefilled with the Venue (other) text; "Add a street address to the venue, or choose Registrants only" opens the address form. Both through the existing ✗-row link mechanism (`focusField` → the Where block, then open the form).
- Private homes: the address line is shown only to editors (it's never in the shared list); on an event set to Registrants only it reads "Shared with registrants only".

### 5.4 Help

Guide: the Where section explains adding a venue and fixing its address, with exact on-screen labels; whats-new gets an entry. Glossary: Street/Unit/City/State/ZIP and the "has an address" rule.

## 6. Constraints

- Everything from PR #35/#38's rules: D1 stable containers, D3 Saved = applied, D4 nothing from Eventbrite written back, D7 no silent fallbacks, buildless, files ≤ 800 lines, `web/listing-readiness.js` DOM-free (Worker-bundled).
- New Coda reads/writes by column id. Bust `ref-venues-v2` on every venue write.
- R1: no live writes during the build. Worker routes are tested with the existing node test harness (mocked Coda/Eventbrite fetch). The schema change and backfill run only after Eric approves the dry run.

## 7. Left to the builder

- Exact form layout and copy beyond the labels above; reuse the compact field styles.
- Where the pure address helpers live (a new `web/venue-address.js` shared by app and Worker like `listing-readiness.js`, or in the Worker with a small copy of the validation in the app). Prefer one shared module.
- How the backfill dry run is produced (a script under `scripts/` that reads via the Worker's Coda helpers and prints a table, with a `--write` flag used only after approval).
