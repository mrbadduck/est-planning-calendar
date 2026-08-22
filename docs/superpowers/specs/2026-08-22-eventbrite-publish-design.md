# Design — Publish to Eventbrite (direct-from-Worker + observability)

**Date:** 2026-08-22
**Status:** Design approved in brainstorming (2026-08-22). Ready for spec review → writing-plans.
**Scope:** v1 = create + basic ticketing/capacity + publish a single Eventbrite event from the planning app, with a first-class observability layer. gCal, banner images, and council templates are designed-for but sequenced later.

---

## 1. Context & goal

The planning app already lets leads plan → approve events (`EST Planning Events SRC`, written through the Cloudflare Worker proxy with Google-verified role gating). The next step in the inverted flow is **publish-out**: on demand, push an approved planning event to **Eventbrite** so it goes live, and link it back so metrics/history keep working.

**Goal (v1):** a program lead can create and publish a **basic** Eventbrite event entirely from the app — core details, capacity, and a basic ticket (free or single paid tier) — click **Publish to Eventbrite**, and get **Open in Eventbrite ↗** once linked. Advanced config (recurring series, multiple ticket types, seatmaps, promo codes) stays in Eventbrite's own UI.

## 2. Decisions settled in brainstorming (don't relitigate)

1. **Direct-from-Worker, not via the Coda pack.** A new role-gated Worker route calls the Eventbrite API directly (create → ticket → publish), holding an EST Eventbrite **private token** as a Worker secret (same posture as the Coda token). Rationale: Coda's eventual-consistency lag made action-through-Coda janky for a synchronous button (measured 25–50s + retry/poll machinery with the Planning-Notes button). The Worker already holds tokens, gates by role, and verifies Google identity.
2. **This revises CLAUDE.md principle #3's *letter*** ("downstream lives in Superhuman Docs automations, not this app") but keeps its **spirit**: the token never reaches the browser, and the app stays a thin view. Update principle #3 to: *downstream publish is a **server-side** concern (the Worker), never the browser; Coda remains the aggregation/observability store.*
3. **Observability is a v1 requirement, not a nice-to-have** — it's what makes "direct" safe. See §6. Without it the Worker is a black box; with it we beat the pack on debuggability.
4. **The pack keeps its job:** `eventbrite-coda-pack` continues to **sync Eventbrite data back into Coda** (Events/Orders/Discounts sync tables) for metrics and `EST Events SRC`. We are not touching that. We only add a **forward** push, in the Worker.
5. **Shared identity (req 2):** all Eventbrite writes use one EST org token; no per-person Eventbrite attribution. The human actor is captured in **our** Publish Log instead (§6).
6. **Ticketing is in v1 (no hidden defaults):** publish requires ≥1 ticket class + a venue-or-online setting, so v1 surfaces **capacity + a basic ticket toggle** (free / single paid tier) rather than silently inventing a default.
7. **Organizer-app deep-link (req 5) is downgraded** to an honest web link (`eventbrite.com/myevent?eid={id}`). Research confirmed **no reliable deep link** opens a specific event's check-in screen in the Organizer app (iOS registers universal links for the attendee app only; Android verifies `com.eventbrite.organizer` for the domain but the intercepted paths are undocumented). Copy will say "tap through to Check-In in the Eventbrite Organizer app."

## 3. v1 scope

**In:**
- Create an Eventbrite event (draft) from a planning event's fields.
- Capacity + one basic ticket class: **free**, or **single paid tier** (price + currency USD).
- Map the app's venue relation → an Eventbrite venue (create under the org, cache the id); or **online** if no venue.
- Rich description via **Structured Content** (the app's `Event Description` body).
- **Publish** the event.
- **Idempotent re-push** ("Update Eventbrite") — editing then re-publishing updates the same event, never duplicates.
- **Open in Eventbrite ↗** (web `myevent?eid=` link) once linked.
- **Observability** (§6): Coda `Publish Log` table, planning-row status fields, in-app error surfacing, Workers Logs.

**Out (designed-for, sequenced later):**
- Banner image upload (Eventbrite's 3-step media→S3 flow — the fiddliest piece).
- Council templates (description footer / standard FAQ; leads edit only the body).
- Google Calendar push (fast-follow; method — Worker service account vs official Coda gCal pack — decided then).
- Multiple ticket types, recurring series, seatmaps, promo codes → Eventbrite UI.
- Eventbrite webhooks for live sales/attendee sync back (a later reverse-sync improvement; the pack's sync tables already cover coarse sync).

## 4. Architecture & data flow

```
Lead in app ──"Publish to Eventbrite"──▶ Worker  POST /publish/eventbrite {rowId}
                                          │  (verify Google JWT → role; load row via Coda)
                                          ▼
                     Eventbrite API (private token, server-side):
                       1. create draft event (if no stored EB id)     POST /organizations/{org}/events/
                       2. ensure venue (create+cache) OR online        POST /organizations/{org}/venues/
                       3. ensure ticket class (create/update)          POST /events/{id}/ticket_classes/
                       4. set description body (Structured Content)     POST /events/{id}/structured_content/{v+1}/
                       5. publish                                       POST /events/{id}/publish/
                                          │
                     write-back to Coda (existing /rows write path):
                       • planning row: Eventbrite Event ID, Eventbrite URL,
                         Publish status, Last published at, Last publish error
                       • Publish Log: append one attempt row (§6)
                                          ▼
     App re-renders row → "Open in Eventbrite ↗" (success) or inline error (failure)

     (unchanged) eventbrite-coda-pack later SYNCS the new event back into
     Coda's Events EVENTBRITE table → EST Events SRC aggregation → metrics/site.
```

The forward push and the pack's reverse sync **meet at the Eventbrite event id**: the Worker stores the id on the planning row immediately after create; when the pack next syncs, the `Eventbrite Event` **relation** (already a column) resolves to the same event, tying the planning row to its aggregated twin (dedup key).

## 5. The publish seam — Worker route

**`POST /publish/eventbrite`** — role-gated, body `{ rowId }`.

Gating (see §9 open decision): require `ALLOW_WRITES=true`, a verified identity with `canWrite`, **and** the planning row's `Status == Approved`. Approval stays Tribal-Council-only upstream; a program lead may then publish their approved event.

Orchestration (each step idempotent; store progress so a retry resumes, never duplicates):

1. **Load** the planning row (Coda) → normalized event. Read stored `Eventbrite Event ID`.
2. **Create-once:** if no stored id → `POST /organizations/{EVENTBRITE_ORG_ID}/events/` with:
   - `event.name.html` = title
   - `event.start`/`event.end` = `{ timezone: "America/Chicago", utc: <ISO Z> }` (derive UTC from the app's date + time + program tz)
   - `event.currency` = `"USD"`, `event.capacity` = capacity, `event.listed` per a "listed?" flag (default true)
   - `event.summary` = first ≤140 chars of description (plain)
   - **Immediately write the returned `id` + `url` back to the planning row** (before later steps) so a mid-sequence failure can't cause a duplicate on retry.
3. **Venue:** if the event has a venue relation → ensure an Eventbrite venue: reuse the cached `Eventbrite Venue ID` from `EST Venues SRC` if present, else `POST /organizations/{org}/venues/` (name + address) and **cache the id back on the venue row**; set `event.venue_id`. If no venue → set `event.online_event = true`.
4. **Ticket class:** ensure exactly one basic ticket class for v1:
   - free → `{ name, free:true, quantity_total: capacity }`
   - paid → `{ name, cost: "USD,<cents>", quantity_total: capacity }`
   - create if none stored; update if a stored ticket-class id exists (capacity/price changes). Store the ticket-class id on the row.
5. **Description:** `GET /events/{id}/structured_content/` → take `page_version_number` (or 0) + 1 → `POST /events/{id}/structured_content/{v+1}/` with a single `text` module carrying the description HTML. (Versioned write; re-POSTing the same version is a silent no-op — always increment.)
6. **Publish:** `POST /events/{id}/publish/`. (Prereqs now satisfied: ticket class + venue/online + start/end/tz/currency.)
7. **Write-back & log:** set `Publish status=published`, `Last published at=now`, clear `Last publish error`; append a `Publish Log` success row.

On any step failure: set `Publish status=error`, `Last publish error=<verbatim Eventbrite message>`, append a `Publish Log` error row (with the step + HTTP status), and return the error to the app. Because the EB id is stored after step 2, re-clicking resumes from where it failed rather than creating a second event.

**Re-push / update:** if a stored EB id exists, the same route updates the event (`POST /events/{id}/`), ticket class, and structured content, then re-publishes if needed. The app labels the button **Update Eventbrite** once linked.

### Payload builders (pure, unit-tested — see §10)
- `eventToEventbritePayload(ev)` → the `event.*` create/update body (name, start/end utc+tz, currency, capacity, summary, listed).
- `ticketClassPayload(ev)` → free/paid ticket body.
- `structuredContentBody(htmlDescription)` → the `modules:[{type:'text',...}]` shape.
- `venuePayload(venue)` → name + address.
- `toEventbriteUtc(date, time, tz)` → `{ timezone, utc }` (reuses the app's date/time semantics; all-day and timed).

## 6. Observability (the linchpin)

Four layers, cheapest to deepest:

1. **In-app result** — the Publish button resolves synchronously to success ("Open in Eventbrite ↗") or the **verbatim Eventbrite error**. No silent black box.
2. **Planning-row status fields** (visible in app *and* Coda; also the idempotency key):
   | Column | Type | Purpose |
   |---|---|---|
   | `Eventbrite Event ID` | text | stored on create; idempotency key |
   | `Eventbrite URL` | text | `myevent?eid=` link target |
   | `Publish status` | select (unpublished / publishing / published / error) | row-level state |
   | `Last published at` | date-time | when it last succeeded |
   | `Last publish error` | text | verbatim message from the last failure |
   | `Eventbrite Ticket Class ID` | text | so re-push updates, not duplicates |

   (Existing `Published?`, `Eventbrite Event` relation, `Linked EST Events SRC row` stay — the relation still resolves via the pack's reverse sync.)
3. **A Coda `Publish Log` table** — the Worker appends one row per attempt (this is the pack-quality "see what happened where I work" that made direct feel risky to lose):
   | Column | Type |
   |---|---|
   | When | date-time |
   | Planning Event | relation → `EST Planning Events SRC` |
   | Actor | relation → `EST People SRC` (from the verified identity) |
   | Target | select (Eventbrite / gCal) |
   | Action | select (create / update / ticket / structured-content / publish) |
   | Result | select (ok / error) |
   | Eventbrite ID | text |
   | Eventbrite URL | text |
   | HTTP status | number |
   | Message | text (verbatim on error) |

   Written through the **existing Coda `/rows`-style write path** (new table id in Worker config). Eric can build views/alerts on it in Coda.
4. **Cloudflare Workers Logs / `wrangler tail`** — structured `console.log` per step for deep debugging; enable Workers Logs (or Logpush) so history is queryable. This layer also addresses the **general** "we can't debug what the planning app does" gap; v1 establishes the audit-row pattern, which can later cover *all* Worker writes.

## 7. Auth, token & config

- **`EVENTBRITE_TOKEN`** (Worker **secret**) — an EST-org private token (Account → Developer → API Keys / private token). Server-side only. Never in the app.
- **`EVENTBRITE_ORG_ID`** (Worker var) — the EST org (`1080997994263` per the pack; confirm).
- **`CODA_PUBLISH_LOG_TABLE`** (Worker var) — the new Publish Log table id.
- Reuses existing `ALLOW_WRITES`, `GOOGLE_CLIENT_ID`, `CODA_*`, role gating (`authIdentity` → `canWrite`).
- **Security follow-through:** rotate the Coda API key committed in `eventbrite-coda-pack/.coda.json` (exposed regardless of this work).

## 8. App UX

- Editor gains (for a write-authorized lead on an **approved** event): **Capacity**, a **Ticket** control (Free / Paid + price when paid), and a **Publish to Eventbrite** button. Once linked, the button becomes **Update Eventbrite** and an **Open in Eventbrite ↗** link appears; `Publish status` shows as a badge.
- Errors render inline (the verbatim Eventbrite message).
- Copy near "Open in Eventbrite": "Opens this event in Eventbrite — on your phone, tap through to Check-In in the Eventbrite Organizer app."
- All new fields read/write through the existing normalized-event seam (`planningRowToEvent` / `eventToCodaCells`); the UI never learns Eventbrite's shapes.

## 9. Open decisions (resolve during spec review or planning)

1. **Publish gating:** proposed = `canWrite` + row `Status==Approved`. Alternative = require `canApprove` (Tribal Council) to publish. *Recommendation:* the proposed rule (leads publish their approved events) matches req 1; confirm.
2. **Paid tickets in v1:** confirm single paid tier is in v1 (needs the org's Eventbrite payout setup, which is Eventbrite's concern, not ours), or restrict v1 to **free only** and add paid with banners later.
3. **Venue caching location:** proposed = an `Eventbrite Venue ID` column on `EST Venues SRC`. Confirm writing to the venues table is acceptable (vs a separate map table).
4. **`listed` default:** public (listed) by default, with a per-event "unlisted" toggle? Proposed default = listed/public.
5. **gCal method** (fast-follow, not now): Worker service-account vs official Coda gCal pack — deferred.

## 10. Test plan

- **Unit (`node --test`, no deps — mirrors the `ical.js` pattern):** the pure payload builders — `eventToEventbritePayload`, `ticketClassPayload` (free & paid), `structuredContentBody`, `venuePayload`, `toEventbriteUtc` (timed + all-day, tz→UTC). These are the correctness-critical mappers.
- **Idempotency:** a unit-level orchestration test with a **mocked fetcher** asserting: (a) create is skipped when an EB id is already stored; (b) a failure after "create" still stores the id so a retry doesn't create a second event; (c) re-push updates rather than duplicates ticket class / structured content.
- **End-to-end (manual/scripted against the real EST org — Eventbrite has no true sandbox):** create a **draft** test event via the route, verify fields/ticket/description in Eventbrite, publish, confirm `Publish status=published` + `Publish Log` success row + `Open in Eventbrite` link, then **unpublish/delete** the test event. Repeat once to prove idempotency.
- **Observability:** assert a `Publish Log` row is written on both success and a forced failure (e.g. missing required field), with the verbatim message.
- **Auth:** unauth / non-lead / lead-on-unapproved-row → 401/403; lead-on-approved → proceeds.

## 11. Suggested build sequence (for writing-plans)

1. Coda schema: add planning-row status columns + create the `Publish Log` table (+ `Eventbrite Venue ID` on venues). *(MCP, no code.)*
2. Worker: Eventbrite client + pure payload builders + unit tests.
3. Worker: `POST /publish/eventbrite` orchestration + write-back + Publish Log; config/secrets.
4. App: capacity + ticket fields, Publish/Update button + states, Open-in-Eventbrite, error surfacing.
5. End-to-end verify against the EST org (draft → publish → unpublish); confirm observability.
6. Docs: update CLAUDE.md principle #3; note token/secret setup.

Later specs: banner image; council templates; gCal fast-follow; webhook reverse-sync.
