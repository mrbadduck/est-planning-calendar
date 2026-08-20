# Phase 2 design — the planning table (inverted flow)

Status: **design / not yet built.** Date: 2026-08-19. Supersedes the "where do
planning rows live?" open decision in `CLAUDE.md`.

## Why (the inversion)

Today `EST Events SRC` is an **aggregator**: most of its columns are formulas
pulling *from* Eventbrite / gCal, and events effectively "start" in Eventbrite. We
want to **invert** the flow so a program lead's work starts in the planning app:

```
plan → approve → publish to Eventbrite / gCal
```

Retrofitting authorship into an aggregator fights its grain, so we build a **new
table** and run it **in parallel** with the existing system (strangler pattern).
The new table sits **upstream**: on approve, an event publishes to Eventbrite/gCal,
which already sync back into `EST Events SRC` — so existing metrics, history, and
the website feed keep working untouched. The new table is **additive**.

**Endpoint deliberately deferred:** whether `EST Events SRC` is eventually replaced
or coexists permanently is *not* decided here ("design the table first, decide
later"). This spec is scoped so either outcome stays open.

## Scope

**In scope**
1. A new Coda table in Mission Control that *originates* planning events.
2. Wiring the app to read/write it, gated by real auth (Google sign-in + allowlist).
3. Reading the reference tables (Programs / People / Venues / Venue Types) so the
   editor's relation pickers work.

**Out of scope (future specs)**
- **Publish-out** to Eventbrite/gCal on approve (the genuinely hard new build;
  Eric already owns an Eventbrite Coda pack — `github.com/mrbadduck/eventbrite-coda-pack`
  — research better options first).
- **Migrating** metrics / website / history off `EST Events SRC`.
- The broader **event-lifecycle** surface (marketing emails, socials, budget,
  expenses, attendance, feedback). See "Designed to grow."

## The new table: `EST Program Planning`

*(Name provisional.)* Relations point at the **existing** entity tables — we do not
duplicate Programs / People / Venues.

### Authored core (what a lead fills in)
| Column | Type | Notes |
|---|---|---|
| Title | Text (display) | |
| Program(s) | Relation → `EST Programs SRC` (`grid-g87NFbtqN8`), **multiple** | crossover events; drives "email all related programs". App colors by the **primary (first)** program. |
| Leads | Relation → `EST People SRC` (`grid-X316Eql8dE`), multiple | |
| Venue Type | Relation → Venue Types (`grid-idEVRQX7SL`), single | first step of the cascade |
| Venue | Relation → `EST Venues SRC` (`grid-foC40iAOaX`), single | app filters options to the chosen Venue Type and hides `Closed/Unavailable?` venues |
| Venue (other) | Text | free-text fallback for a venue not yet in the DB |
| Event Description | Text (canvas) | **public promo copy** |
| Planning Notes | Text (canvas) | **internal**; seeded with a question template (see below) |

### Scheduling (the app's loose-planning model)
| Column | Type | Used when |
|---|---|---|
| Scheduling | Select: `Exact / Range / Month` | always |
| Date | Date | Exact |
| Start / End | Text (`HH:MM`) | Exact |
| All day | Checkbox | Exact |
| Window start / Window end | Date | Range |
| Target month | Text (`YYYY-MM`) | Month |

### Workflow
| Column | Type | Notes |
|---|---|---|
| Status | Select: `Idea / Draft / Confirmed / Approved` | lifecycle; `Approved` is VP-only |
| Created by / Edited by | Person | attribution |
| Approved by / Approved at | Person / Date | audit for the approve action |

### Publish seam (empty until publish-out is built — the dedup key)
| Column | Type | Notes |
|---|---|---|
| Published? | Checkbox | set when the event has been pushed out |
| Eventbrite Event | Relation → `Events EVENTBRITE` (`grid-sync-20456-Event`) | filled on publish |
| gCal Event | Relation → `Events GCAL` (`grid-sync-1003-Event`) | filled on publish |
| Linked EST Events SRC row | Relation → `EST Events SRC` (`grid-9TAt5vMMKH`) | ties the planning row to its aggregated twin; prevents duplicate rows when the Eventbrite/gCal import runs |

### Planning Notes — starter template
Pre-seed new rows with a short checklist of prompts (free-form now; several become
structured fields later, driving workflows):
- Do you need **supplies**? What?
- Are you **hiring vendors**? Who / budget?
- What **volunteer support** do you need?
- **Budget** needed / already approved?
- Any **collaborators / partner orgs**?
- **Marketing** plan (email, socials)?

## How it maps to the app

The app was *built* for this shape — `codaRowToEvent` / the mock `row()` columns
already define the normalized event. Going live is a **small** change, not a rewrite.

**Data layer**
- Read mapping: reuse the normalized event shape. Update column names/relations:
  `Program(s)` (take first for color, keep the list), `Venue`/`Venue (other)` →
  `location`, `Event Description` → `description`, add `planningNotes`.
- Replace the Phase-1 `eventsSrcRowToEvent` adapter with this planning-table
  mapping; `DB` points at the new table via the proxy.
- Writes: `create` / `update` / `remove` send `eventToCodaCells` (already present)
  against the new table.

**Editor UI changes (contained)**
- Program: multi-select relation.
- Venue: dependent cascade — Venue Type → filtered Venue list → "other" free text.
- Two text areas: Event Description (promo) + Planning Notes (seeded template).
- Approve stays VP-only, now driven by **real identity** (not the hardcoded
  `state.role`).

**Calendar rendering**
- Color by the **primary** program; show a small crossover indicator when >1.

## Proxy / config changes

- `CODA_TABLE_ID` → the new planning table id (once created).
- **New read endpoints for reference data** so the editor's pickers work: expose
  read-only lists for Programs, People, Venues, and Venue Types (either explicit
  routes like `/programs` `/people` `/venues` `/venue-types`, or a generic
  read-only `/table/:id` restricted to an allowlist of those four ids). *This is
  new — the Phase-1 proxy only serves `/rows` for one table.*
- Writes: set `ALLOW_WRITES=true` **and** require auth (below); swap the Worker
  secret to a **read+write** doc-scoped token.

## Auth (ships with writes — from `docs/architecture.md`, Phase 2)

- App: Google Identity Services sign-in; send the Google-signed ID token as
  `Authorization: Bearer <token>` on writes.
- Worker: verify the ID token against Google's public keys (`aud` = our client id,
  `iss` = accounts.google.com, `exp`) and check the email against an **EST-leads
  allowlist** (Worker var/secret) before any `POST/PUT/DELETE`. VP role (approve)
  comes from the same identity layer.

## Rollout (parallel-run)

1. **Create** `EST Program Planning` beside the existing tables — zero impact on
   `EST Events SRC` or its metrics.
2. **Seed** a few real upcoming ideas (or port the app's sample rows).
3. **Read-only first**: point the app at the new table, verify the calendar renders
   (mirrors how we validated Phase 1).
4. **Add auth + enable writes**: leads create/edit; VP approves.
5. **Later specs**: publish-out on approve (+ dedup via the publish-seam links);
   then the endpoint decision (replace vs. coexist).

## Designed to grow (vision — not built now)

The planning row is meant to become the program lead's **one-stop shop** across the
whole event lifecycle. The Planning Notes prompts are deliberately the seeds of
future structured fields + workflows:
- draft & send **marketing emails** (to attendees of all related Programs),
- publish to **socials**,
- **budget requests** and **expense** submission,
- **attendance** capture,
- **post-event feedback**.

Keep the schema and the app's data seam extensible so these attach to the same row
without another inversion.

## Open decisions

- **Table name** (`EST Program Planning`?).
- **Endpoint**: replace `EST Events SRC` vs. coexist (deferred).
- **Venue picker plumbing**: confirm the app filters Venue options by Venue Type
  client-side from the reference reads (vs. a server-side filtered endpoint).
- **Planning Notes template**: final question list + which (if any) start as
  structured fields vs. free text.
- **Auth specifics**: Google allowlist as a Worker var vs. a small list table;
  how VP (approve) role is expressed.
