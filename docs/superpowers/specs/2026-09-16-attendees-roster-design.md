# Design — Attendees roster + registrant comms (v1: copy / mailto)

**Date:** 2026-09-16
**Status:** Design approved in brainstorming (2026-09-16). Ready for spec review → writing-plans.
**Scope:** v1 = a live per-event **roster** in the plan app's event workspace
(Eventbrite registrants ∪ gather claimants, resolved to EST people, with an
active-member badge), **segment filters**, row selection, and two actions —
**Copy emails** and **Email** (a `mailto:` with BCC). Leads then send from their
own mail accounts. No Worker-side sending, no comms log.

---

## 1. Context & goal

Members register for events on Eventbrite and claim potluck/volunteer slots in
`gather`, but a program lead using the plan app has **no way to reach those
people** about the event or their contribution. The motivating cases:

1. Email all registrants (share a private home address the day before; last-minute
   updates).
2. Email one or some volunteers to coordinate a contribution.
3. Email registrants who haven't signed up for a potluck/volunteer slot.

Rather than three fixed functions, v1 ships one concept — **roster → segments →
recipients** — that covers these and the cases not yet imagined (e.g. "nudge
claimants who haven't registered", "members only").

The private-address case also closes a gap the Eventbrite publish design
explicitly deferred (§5a: *delivering the exact address to registrants is out of
v1*). With this roster a lead can BCC every registrant from their own mailbox.

## 2. Decisions settled in brainstorming (don't relitigate)

1. **No sending rail in v1.** Leads copy addresses or open a `mailto:` and send
   from their personal accounts. Worker-side sending (Gmail API / transactional
   provider), a Coda `Comms Log`, and scheduled sends are all deferred. This
   removes a mailbox secret, DNS work, and a new table from v1.
2. **Plan may see registrant emails; gather never may.** Leads (write-authorized
   identities) legitimately need addresses. The gather member projection
   (`projectEventForMember`) is an allowlist that carries no email today and must
   not grow one. The roster route is plan-only and role-gated.
3. **One row per Eventbrite order**, not per ticket. The lead is communicating
   with the registrant (order buyer). Tickets are rolled up per row ("2 × General
   Admission").
4. **Person resolution happens in the Worker at read time**, by matching the
   order email against the People `All Emails` projection the Worker already
   holds for sign-in. This reproduces Coda's own rule (`Orders EVENTBRITE.EST
   Person = People.Filter(All Emails contains Email.lower())`), including manual
   corrections, because `All Emails` folds in the emails of manually-corrected
   orders. Coda's Orders sync stays the historical record; it is **not read** on
   this path. The roster is **live** (Eventbrite direct + short KV cache), not
   pack-sync latency.
5. **Roster = union of registrants and claimants.** A gather claimant with no
   matching order appears as its own row flagged *signed up, not registered*, so
   "go register" becomes a segment.
6. **Active-member badge reads one Coda-owned boolean.** A new formula column on
   `EST People SRC`, `Active Member`, initially
   `[Givebutter Plans].Filter(Status="active").Count() > 0`. When the nascent
   `EST Memberships SRC` relationship table lands (household members, service-only
   memberships), **only the Coda formula changes** — the Worker and app are
   untouched. Until then households and service-only members read as non-members;
   this is an accepted, labeled approximation, and the badge is non-blocking for
   the comms goal.
7. **Deploys are judicious.** Free-tier limits were hit in Aug 2026. Local testing
   first (`node --test`, `wrangler dev`, `live-server`); deploy once when the
   Worker route is ready for a live check, not as a verification loop.

## 3. Scope

**In (v1)**
- Coda: `Active Member` formula column on People; its id in `coda-columns.js`.
- Worker: `GET /roster/:rowId` (role-gated, `canWrite`), pure helpers in
  `proxy/src/roster.js` with unit tests, KV cache per event.
- App: the **Attendance** coming-soon stub becomes a live **Attendees** section:
  roster table, segment chips, per-slot chips, checkbox selection, **Copy
  emails**, **Email** (mailto BCC), refresh, summary counts. Works for past
  events too (attendance history for free).

**Out (designed-for, deferred)**
- Worker-side sending, merge fields, templates, `Comms Log`, scheduled sends.
- An "add to People" action for unmatched emails (Coda's `Add EST Person` button
  already covers this on the Orders table).
- Per-ticket / per-attendee rows; check-in status.
- Any change to gather's member-facing data.

## 4. Architecture & data flow

```
Lead opens event → Attendees section
   │  GET /roster/:rowId  (Bearer Firebase ID token; requires canWrite)
   ▼
Worker
   1. planning row (Coda, id-keyed) → Eventbrite Event ID, Title
   2. Eventbrite: GET /events/{ebId}/orders/?status=active&expand=attendees  (paged)
   3. Coda: slots for this event + their claims (existing gather reads)
   4. People slim projection (+ Active Member boolean)  — KV, already cached
   5. rosterFromSources(...)  → rows + summary                (pure, roster.js)
   ▼
{ rows:[...], summary:{...}, ebLinked, fetchedAt }   — KV per event, soft 60s / hard 5m
   ▼
App renders table + segments; selection → Copy emails / mailto BCC
```

## 5. Coda change

| Table | Column | Type | Formula |
|---|---|---|---|
| `EST People SRC` | `Active Member` | formula → boolean | `[Givebutter Plans].Filter(Status="active").Count() > 0` |

Add the column id to `PEOPLE_COLS.activeMember` in `proxy/src/coda-columns.js`
and to `slimPeopleRows` so the cached People snapshot carries it. The projection
stays ~100KB; nothing else about People leaves the Worker.

## 6. Worker

### Route: `GET /roster/:rowId`
- **Gate:** `authIdentity` → `canWrite` (Program Lead / Tribal Council); otherwise
  403. Never reachable from member routes. `EVENTBRITE_TOKEN` missing → `200
  { configured:false }` so the app renders a plain notice, not an error.
- **Inputs:** the planning row (Eventbrite Event ID via `PLANNING_COLS.eventbriteId`,
  title), Eventbrite orders (`?status=active&expand=attendees`, follow
  `pagination.continuation`), the event's slot rows + claim rows (reuse the
  gather read path), the People slim projection.
- **Cache:** KV key `roster:<rowId>` — soft 60s / hard 5m via `swrGet`. Busted by
  the claim write routes (`POST /claims`, `PUT|DELETE /claims/:id` — they know the
  slot → event) and honoring `?fresh=1` for the refresh button. Eventbrite's rate
  limit (1000/hr) is comfortably covered.
- **Errors:** an Eventbrite non-2xx returns `502 { error, status, message }` with
  the verbatim Eventbrite message; the app shows it inline with Retry. An empty
  roster is only ever returned when Eventbrite genuinely returned no orders.

### Response shape
```jsonc
{
  "configured": true,
  "ebLinked": true,                 // false when the row has no Eventbrite Event ID
  "fetchedAt": "2026-09-16T18:02:11Z",
  "summary": { "orders": 23, "tickets": 31, "claimants": 9, "unregisteredClaimants": 2, "members": 11, "unmatched": 4 },
  "rows": [
    {
      "key": "order:1234567890",    // stable client key: order id, or person:<id> / email:<addr> for claimant-only rows
      "kind": "order",              // "order" | "claimant"
      "name": "Dana Levy",
      "email": "dana@example.com",
      "personId": "i-abc123",       // null when unmatched
      "matched": true,
      "member": true,
      "orderStatus": "placed",
      "tickets": [ { "class": "General Admission", "qty": 2 } ],
      "claims": [ { "slotId": "i-s1", "kind": "Potluck", "label": "Dessert", "contribution": "kugel", "qty": 1 } ]
    }
  ]
}
```

### Pure helpers — `proxy/src/roster.js` (unit-tested, no I/O)
- `orderRows(orders)` → one row per active order: buyer name/email (lowercased),
  order id, status, ticket rollup by `ticket_class_name` summing `quantity` over
  non-cancelled, non-refunded attendees.
- `resolvePersonByEmail(email, peopleRows, cols)` → `{ personId, member }` or
  `{ personId:null, member:false }` (reuses `findPersonByEmail`).
- `claimantRows(slots, claimsBySlot, peopleRows, cols)` → one row per distinct
  claimant person with their claims; email = first `All Emails` entry (blank if
  none — the row still shows so the lead can see who signed up).
- `mergeRoster(orderRows, claimantRows)` → orders annotated with the matching
  claimant's claims (match on `personId`, else on email); claimants with no match
  appended as `kind:"claimant"` rows.
- `rosterSummary(rows)` → the counts above.
- `segmentPredicates` — the same predicate set the app uses (kept in one place;
  mirrored into `web/` like `shared/`): `all`, `registered`, `unregisteredClaimants`,
  `registeredNoClaim`, `members`, `nonMembers`, `slot:<id>`.

## 7. App — the Attendees section

- `SECTIONS`: `attendance` → `{ id:'attendees', label:'Attendees', live:true }`
  (keep `attendance` as an alias for existing deep links, or migrate the id).
  `renderAttendees` / `wireAttendees` follow the Planning/Publish pattern; the
  panel is read-only, so no autosave hooks.
- **Header:** summary line ("23 orders · 31 tickets · 9 signed up · 11 members"),
  a refresh button (`?fresh=1`), and `fetchedAt` as "updated 2m ago".
- **Segment chips:** All · Registered · Signed up, not registered · Registered,
  no sign-up · Members · Non-members · then one chip per slot (label, with kind
  icon). Chips show counts; single-select.
- **Table:** checkbox · name · member badge · tickets ("2 × GA") · sign-ups (slot
  label + contribution) · status chip (Registered / Not registered / Not in
  People). Email shown as a secondary line under the name. Sorted by name.
- **Selection:** per-row checkboxes + a select-all for the current segment.
  Switching segments clears selection. Footer shows "N selected".
- **Actions (footer):**
  - **Copy emails** → `navigator.clipboard.writeText(emails.join(', '))`,
    then a 2s "Copied N" confirmation; falls back to a selectable textarea if the
    clipboard API is unavailable.
  - **Email** → `mailto:?bcc=<emails>&subject=<event title>`; disabled with a
    hint ("Too many for a mail link — copy instead") once the URL exceeds ~1,900
    characters (roughly 60 addresses).
  - Rows with a blank email are excluded from both, with a count shown.
- **Not linked to Eventbrite:** claimant rows only, plus a note that registrants
  appear once the event is published to Eventbrite.
- **Not configured / error:** plain notice, or inline verbatim error + Retry.
- **Gating:** the rail item is visible to write-authorized users only (the route
  403s otherwise); signed-out users see the existing coming-soon board for it.

## 8. Privacy posture

- The roster response is served only to `canWrite` identities.
- `slimPeopleRows` gains a boolean, nothing else. `projectEventForMember` is
  unchanged and stays email-free; a test asserts no member-route projection
  contains an `email` key.
- Unmatched registrants are shown (name + email + tickets) but never
  auto-created as People rows.

## 9. Testing

- `proxy/test/roster.test.js` (node --test): order rollup (multi-ticket,
  cancelled/refunded attendees excluded), email match incl. case/whitespace,
  claimant union + merge by personId and by email, blank-email claimants, member
  flag projection, summary counts, every segment predicate, mailto length guard.
- Existing gather tests extended with the "member projection has no email"
  assertion.
- App: `node --check web/app.js`; local run (`live-server web`) against the
  Worker in `wrangler dev` with `.dev.vars`; one live check after the Worker
  deploy.

## 10. Config

- `PEOPLE_COLS.activeMember` (new column id) — code, not env.
- No new Worker vars or secrets. Reuses `EVENTBRITE_TOKEN`, `CODA_*`, `CACHE`.
