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

## The new table: `EST Planning Events SRC`

Relations point at the **existing** entity tables — we do not duplicate Programs /
People / Venues.

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
| Date | Date | **Exact** (the day) **and Month** (the 1st of the target month) |
| Start / End | **Time** (native) | Exact |
| All day | Checkbox | Exact |
| Window start / Window end | Date | Range |

Coda has no native "month" type, so `Month` scheduling reuses `Date` set to the
**1st** and the app renders month-only when `Scheduling = Month` — no separate
`Target month` column. Proper types throughout (this revises Plan 1, which used
text `Start`/`End` and a `Target month` text column).

### Workflow
| Column | Type | Notes |
|---|---|---|
| Status | Select: `Idea / Draft / Confirmed / Approved` | lifecycle; `Approved` is VP-only |
| Created by / Edited by | Relation → `EST People SRC` | attribution — see note (not Coda-person, not native) |
| Approved by | Relation → `EST People SRC` | set at approve |
| Approved at | Date/Time | set at approve (a specific action, distinct from "last modified") |

**Attribution — why relations, not native metadata or person columns:** writes go
through the proxy on **one shared API token**, so Coda's native *Created/Modified
by* would attribute every write to the token account, not the lead. Instead, Plan 2
auth yields the lead's **Google-verified email**; the Worker matches it to an
`EST People SRC` row **by email** and writes that row as the `Created by` /
`Edited by` / `Approved by` relation. Leads can sign in with any email and still
resolve to their real person row. Native **Created on / Last modified on**
timestamps are used as-is (free) — we add no columns for those.

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
- Read mapping (`planningRowToEvent`, shipped in Plan 1): normalized event shape;
  `Program(s)` first → color + keep the list, `Venue`/`Venue (other)` → `location`,
  `Event Description` → `description`, `planningNotes`. For `Scheduling = Month`,
  derive the month from `Date` (the 1st); `Start`/`End` are native time — normalize
  whatever the proxy returns to `HH:MM`.
- Writes: `create` / `update` / `remove` send `eventToCodaCells` against the new
  table (times as native time, relations as target-table row ids, attribution
  relations from the email→person match).

**Refresh (Plan 1 fetches once on load — this fixes that)**
- A manual **Refresh** button (re-fetch + re-render).
- Re-fetch on **tab focus** (`visibilitychange`).
- Light **auto-poll** every ~60s while the tab is visible.
- After a successful write, re-fetch so the lead's own change appears immediately.
- If polling makes the Worker chatty, add a ~30s response cache in the Worker
  (still free tier). True push (Coda webhook → Durable Object → WebSocket) is a
  later plan, only if needed.

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
  `iss` = accounts.google.com, `exp`) before any `POST/PUT/DELETE`.
- **Identity + authorization via email→person match:** the Worker looks the
  verified email up in `EST People SRC` (match on any of the person's emails). The
  matched person row is the attribution written to `Created by` / `Edited by` /
  `Approved by`. **Authorization is *not* "anyone in `EST People SRC`"** (that's
  every attendee) — it requires the person to have a **leadership role** (a
  leadership-status / wave field on the person row; exact field TBD in Plan 2).
  **VP (approve)** is a higher role/flag on the same record. No lead-level match →
  writes rejected; non-VP → approve rejected. This match doubles as the allowlist
  *and* the attribution source, so leads sign in with any email on their record.

## Rollout (parallel-run)

1. **✅ Plan 1 (done):** table created + seeded; proxy repointed; app renders it
   read-only.
2. **✅ Plan 2a (done, Aug 2026) — read-side polish:** retyped the schema
   (Start/End → native time, dropped `Target month` → Month uses `Date`=1st,
   attribution → `EST People SRC` relations); added `/ref/:name` proxy endpoints;
   added refresh (button + tab-focus + 60s poll). Still read-only.
3. **Plan 2b — auth + editor + writes:** Google sign-in + email→person match;
   `ALLOW_WRITES=true` + read+write token; the editor (multi-program, venue cascade,
   notes template); create/edit/approve with attribution + VP-only approve.
4. **Later specs**: publish-out on approve (+ dedup via the publish-seam links);
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

- **Endpoint**: replace `EST Events SRC` vs. coexist (deferred).
- **Venue picker plumbing**: confirm the app filters Venue options by Venue Type
  client-side from the reference reads (vs. a server-side filtered endpoint).
- **Planning Notes template**: final question list + which (if any) start as
  structured fields vs. free text.
- **Leadership role fields**: which `EST People SRC` field marks a person as an
  authorized **lead** (write access) vs. a **VP** (approve) — confirm during Plan 2
  (candidates: a leadership-status / leadership-wave field).
- **Native time format**: normalize whatever `valueFormat=simpleWithArrays` returns
  for the native `Start`/`End` time columns to `HH:MM` (confirm the exact format via
  a proxy curl during Plan 2a).
