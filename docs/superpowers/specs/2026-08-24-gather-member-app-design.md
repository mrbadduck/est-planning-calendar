# `gather` — member-facing app (design)

Status: **design / approved, not yet built.** Date: 2026-08-24.
Prereqs (own short handoff specs): **Netlify monorepo migration**, **Firebase Auth
unify** (see §9).

## Why

EST runs many events that need attendees to **claim a slot** — potlucks ("who's
bringing dessert?") and volunteer-needing events ("who's on setup?"). These are
two shapes of one workflow. 2026 research found no free, API-driven external tool:
SignUpGenius's API is paid + read-only (can't create sheets); consumer potluck
tools (Perfect Potluck, Meal Train) have no API; volunteer platforms (InitLive,
Galaxy Digital) are paid/enterprise.

The real need is a **live "what's still needed" view** so a member can decide what
to bring — that's an **app over shared state, not a form**. A Coda form-view could
collect submissions, but it can't show the live filled-vs-open picture, can't
unclaim, and has no per-member history. So we build a second, member-facing app.

`gather` is the first slice of a longer arc: the eventual **member home base** (my
events, my sign-ups, RSVPs, household, dues/giving, preferences). We design
identity + schema to grow there, but **build only the sign-up slice now.**

## Relationship to the planning app

Two apps, **one Coda brain**:

- The **planning app** (leads, `plan.eastsidetribe.org`) authors events and — new
  in this work — **defines the slots** on an event.
- **`gather`** (members, `gather.eastsidetribe.org`) lets members **fill** those
  slots.

Both are thin view layers over the same Coda tables through the **same Cloudflare
Worker** (decisions #1, #4 in `CLAUDE.md` hold unchanged).

## Settled decisions (resolved during brainstorm)

1. **Hosting:** monorepo → **two Netlify sites** (`web/` → plan, `gather/` →
   gather), external-CNAME custom domains, DNS stays at Hover. (Prereq migration.)
2. **Auth:** **Firebase Authentication** as the single identity provider for
   **both** apps — magic-link (email-link) primary + Google shortcut. Google-signed
   ID tokens, verified in the Worker much as it already verifies Google Sign-In.
   Google sends the magic-link emails (no Resend, no email-DNS). (Prereq: unify the
   plan app onto Firebase too, §9.)
3. **One shared Worker**, extended with member routes, held safe by two guardrails:
   **(a)** per-route audience/role gating; **(b)** a member-write path scoped so a
   member can only insert/delete **their own** claim rows. Chosen over a separate
   Worker because Firebase fronting auth means member routes are already
   JWT-authenticated (not raw-public), and one Worker/one deploy is real
   operational value for a lay-led org.
4. **Data in Coda**, two new tables (**Slots**, **Claims**). Claim is a
   **first-class row with a payload** (what I'm bringing / my contribution), not a
   join. "Remaining" is **computed**, never stored — so the only concurrency effect
   is benign oversubscription, explicitly accepted (low contention; direct Coda
   access is itself an admin value-add).
5. **Identity = open signup** ("belonging by default"): a verified email with no
   `EST People SRC` row → the Worker **finds-or-creates** one. Mailchimp is
   **downstream/optional**, never in the hot path.
6. **Slot authoring = a minimal builder in the plan app** (the "Volunteers &
   potluck" section, today a stub), not Coda-only and not a full template builder.
7. **Code-sharing:** a shared `/shared/*.js` module copied/symlinked into each
   publish dir at deploy — one source of truth for the Coda-normalization seam,
   staying buildless.

## Scope

**In (v1)**
1. `gather`: sign in → browse **published upcoming events** → open one → see
   details + (if present) the **live sign-up sheet** → **claim / unclaim** a slot
   with a contribution payload → **view/manage my sign-ups**.
2. A prominent **"Register on Eventbrite"** CTA on each event (Eventbrite owns
   registration in v1).
3. A **minimal slot builder** in the plan app so leads author slots.
4. Worker member routes + member-projected reads + find-or-create People.

**Out (future — designed for, not built)**
- Eventbrite **registration sync + resolution** — indicating "you're already
  registered," and the features it would unlock: **full-address reveal** and
  **registration-gated slot claiming**. v1 shows slots to any signed-in member and
  only **coarse/public location** (mirroring the existing Eventbrite public-city
  posture).
- **Reusable slot templates** (Dessert/Setup/Cleanup one-click, like the council
  description templates).
- **Notifications / nudges** ("3 of 4 dessert slots filled").
- Rolling **volunteer-kind claims up into the event-level `Volunteers` relation**
  (that relation is left untouched in v1 — see §3).
- **SMS OTP** (A2P 10DLC + no free tier; deferred).
- The broader member home base (dues, household, RSVPs, preferences).

## Architecture

```
Netlify (gather/)  ──┐                       ┌── Firebase Auth (Google project)
                     │   Google-signed JWT   │      magic-link + Google
member's phone ──────┤ ────────────────────► │
                     │                       └── verified in Worker
Netlify (web/)   ──┐ │
  (plan, leads)    │ ▼
                   Cloudflare Worker (one, shared)  ── member routes + lead routes
                     │  resolvePerson(email) → {person, canWrite, canApprove}
                     ▼
                   Coda (Mission Control): Planning Events + People + new Slots/Claims
```

## 3. Data model — two new Coda tables

Relations point at existing tables; we do not duplicate People or Events.

### Slots
| Column | Type | Notes |
|---|---|---|
| Event | Relation → `EST Planning Events SRC` (`grid--gYIvdD-cE`), single | the event this slot belongs to |
| Kind | Select: `Potluck / Volunteer` | drives labeling/grouping in both apps |
| Label | Text (display) | "Dessert", "Setup 5–6pm", "Greeter" |
| Needed qty | Number | how many claims this slot wants (e.g. Dessert ×3) |
| Sort order | Number | lead-controlled ordering within an event |

### Claims (first-class, with payload)
| Column | Type | Notes |
|---|---|---|
| Slot | Relation → Slots, single | |
| Member | Relation → `EST People SRC` (`grid-X316Eql8dE`), single | the claimant's person row |
| Contribution detail | Text (display) | "grandma's kugel", "bringing a folding table" |
| Qty | Number | usually 1; supports "I'll bring 2 desserts" |
| Notes | Text | optional |
| Created on | Date/Time | native (free) |

**Remaining is computed, not stored:** `remaining(slot) = Needed qty − Σ(Qty of
its Claims)`. Because each claim is an independent **insert** (not a mutation of a
`claimed_by[]` array), concurrent claims can't lose-update; the only race is two
claims pushing a slot to `Needed qty + 1` — benign and accepted.

**Existing `Volunteers` relation (planning table, from Plan 2b-ii-b) is left
as-is** for v1 — a coarse, lead-managed, event-level list. Slot claims are the new
fine-grained structure. Reconciling the two (e.g. volunteer claims rolling up into
`Volunteers`) is deliberately deferred, not solved here.

## 4. Identity & auth

- **Provider:** Firebase Auth (in the existing Google Cloud project). Members sign
  in with a **magic link** (Google-sent) or **Google**. The app sends the Firebase
  **ID token** as `Authorization: Bearer <token>`.
- **Worker verify:** validate the Firebase ID token against Google's public keys
  (`iss = https://securetoken.google.com/<project>`, `aud = <project>`, `exp`) —
  the same posture, different issuer/audience, as today's Google Sign-In verify.
- **Open signup / find-or-create:** on a member's first authenticated request, the
  Worker matches the verified email against `All Emails` in `EST People SRC`. **No
  match → create** a People row with the verified name + email, flagged
  self-onboarded (so admins can spot auto-created rows). (Two simultaneous
  first-requests could create duplicate rows — benign; admins can merge. Harden
  later if needed.)
- **Roles** (unchanged `resolvePerson` logic): **member** = any signed-in person;
  **lead/council** = `canWrite` / `canApprove`. Slot authoring is lead-gated;
  claiming is member-gated.
- **Guardrail:** member-write routes verify the claim's `Member` resolves to the
  caller's own person before insert/delete — a member can never touch another's
  claim, and the Coda write-token scope is never the blast radius for a member-route
  bug.

## 5. Worker — new/changed routes

All member routes require a valid Firebase token; reads are **member-projected**
(public fields only — never internal Planning Notes, attribution, or full address).

| Route | Who | Purpose |
|---|---|---|
| `GET /member/me` | member | verify token; find-or-create person; return `{ id, name }` |
| `GET /events` | member | published, upcoming events (projected) + their slots with `remaining` + `mineClaimed` |
| `GET /events/:id` | member | one event's detail + slots + claims (claimant name + contribution — the "what's coming" view) |
| `POST /claims` | member | body `{ slot, contributionDetail, qty, notes }`; inserts a claim with `Member` = caller |
| `DELETE /claims/:id` | member | delete **own** claim only (Worker checks ownership) |
| `GET /me/claims` | member | the caller's claims across all events |
| `POST /slots`, `PUT /slots/:id`, `DELETE /slots/:id` | lead/council | slot authoring (plan-app builder) |

**Published gate:** `/events` returns planning rows where `Published? = true` and
the event date is ≥ today. The **Eventbrite CTA URL** comes from the row's
`Eventbrite Event` relation (→ the synced EB event's public URL).

## 6. `gather` surfaces (mobile-first)

- **Home:** a list of **published, upcoming** events. Tap any to open.
- **Event detail:** always shows event details + a prominent **"Register on
  Eventbrite"** CTA. If the event has slots, shows the **live sign-up sheet**
  (filled vs. open, with each claim's contribution) and **claim / unclaim**
  controls. **Coarse/public location only** in v1 (full address deferred to the
  registration-unlock feature).
- **My sign-ups:** the member's own claims across events; unclaim/manage.
- **No registration resolution in v1:** any signed-in member can see and claim
  slots; the "already registered → unlock address/slots" gating is future work.

## 7. Plan-app addition — minimal slot builder

Build the "Volunteers & potluck" stub in the event workspace into a **minimal slot
editor**: add a slot (Kind, Label, Needed qty), remove a slot, reorder (Sort
order). Writes to the Slots table via the lead-gated `/slots` routes. **Templates
deferred.** Because a published event's slots become member-visible immediately,
the section shows a short "these are live to members once the event is published"
note.

## 8. Code-sharing (two buildless apps)

Introduce `/shared/*.js` at the repo root (or `web/shared`, mirrored) holding the
one-source-of-truth pieces both apps use: the Coda-normalization seam
(`planningRowToEvent` and friends), the Firebase client glue, and fetch/error
helpers. **Copied or symlinked into each Netlify publish dir at deploy** so both
sites can `<script src>` it at runtime — **no bundler, still buildless.** This
prevents drift on the normalization seam `CLAUDE.md` treats as sacred (decision
#4).

## 9. Deliverables & sequencing

Three small, independent specs; do the two prereqs before gather's member routes go
live so the shared Worker only ever verifies **one** token type:

1. **Netlify monorepo migration** (short handoff) — both apps to Netlify, DNS at
   Hover, GH Pages retired. Independent of auth.
2. **Firebase Auth unify** (short handoff) — stand up Firebase in the Google
   project; migrate the **plan** app off direct Google Sign-In onto Firebase
   (leads keep "Sign in with Google"); swap the Worker's verify to Firebase ID
   tokens. `resolvePerson` / role gate unchanged.
3. **`gather`** (this design) — the substantive build: Slots/Claims tables, member
   routes + find-or-create, the gather app, and the plan-app slot builder.

## Testing

- **Worker:** unit-test the published/upcoming filter, member projection (asserts
  no internal fields leak), claim ownership check (a member can't delete another's
  claim), and find-or-create (match vs. create). Extend the existing `proxy/test`.
- **Claim flow:** integration test claim → remaining decrements (computed) →
  unclaim → restores; oversubscription is allowed and surfaced, not errored.
- **Auth:** verify a lead token can author slots and a plain member token cannot;
  a member token can claim/unclaim.
- After any app JS edit, `node --check` the extracted script (repo convention).

## Open decisions / to confirm during planning

- **Self-onboarded People row:** exact `EST People SRC` columns to set on create
  (Full Name + which email column + a source/flag field) — confirm field names
  against the live table during the plan.
- **Eventbrite CTA URL:** confirm the synced `Events EVENTBRITE` row exposes a
  public URL the Worker can read for the CTA.
- **Coarse location field:** confirm what "public/coarse location" reads from
  (reuse the Eventbrite `AREA_CITY`/`AREA_REGION` posture vs. a venue field).
- **Shared-JS placement:** repo-root `/shared` vs. `web/shared` mirrored — pick the
  layout that Netlify's per-site base dir + a deploy-time copy handles most simply.
