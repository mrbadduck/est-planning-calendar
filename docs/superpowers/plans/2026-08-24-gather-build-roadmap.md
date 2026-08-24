# `gather` Build — Phased Implementation Roadmap

> **For agentic workers:** This is a DECOMPOSITION roadmap. Phase 1 is specced to executable detail (build it via subagent-driven-development / executing-plans). **Phases 2–4 get their own detailed bite-sized plans authored right before each is built** — a from-scratch buildless front-end and live-schema-dependent work are best planned at execution time, not speculatively now. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Build the member-facing `gather` app (potluck/volunteer slot sign-ups) per the approved design (`docs/superpowers/specs/2026-08-24-gather-member-app-design.md`): members sign in, browse published upcoming events, and claim/unclaim slots; leads author slots via a minimal builder in the plan app.

**Architecture:** Coda holds two new tables (Slots, Claims); the shared Cloudflare Worker gains member routes (guardrailed) + find-or-create People; `gather/` is a new buildless mobile-first app on Netlify reusing the Firebase auth from a shared module; the plan app gains a minimal slot builder. Firebase Auth (already unified) is the identity provider.

**Prerequisites (must land first):**
- **Firebase Auth unify — ✅ DONE** (shipped 2026-08-24; Worker verifies Firebase ID tokens).
- **Netlify monorepo migration** (`docs/superpowers/plans/2026-08-24-netlify-monorepo-migration.md`) — stands up the `gather.eastsidetribe.org` site and the monorepo hosting. Phase 1 (backend) does NOT depend on it; Phase 2 (the app) does.

---

## Decomposition — four phases

| Phase | What | Depends on | Detail status |
|---|---|---|---|
| **1 — Foundation** | Coda Slots + Claims tables; Worker member routes + find-or-create People; lead slot routes | Firebase unify (done) | **Full detail below** |
| **2 — gather app** | The member front-end (home, event detail, claim/unclaim, my sign-ups) + the `/shared` code-sharing mechanism | Phase 1 + Netlify migration | Scoped below → own plan at build |
| **3 — Slot builder** | The "Volunteers & potluck" editor in the plan app | Phase 1 | Scoped below → own plan at build |
| **4 — Email deliverability** | Domain-aligned magic-link sending (spam fix) | Firebase unify | Scoped below → own plan at build |

Build order: **1 → (2 ∥ 3) → 4** (Phase 4 before member launch, since magic-link is gather's primary path). Phase 1 can start immediately, in parallel with the Netlify migration.

---

# Phase 1 — Foundation (Coda tables + Worker routes) — FULL PLAN

## Context for the implementer

- Mission Control doc id: `DYAz_wCVfv`. Planning events table: `EST Planning Events SRC` = `grid--gYIvdD-cE`. People: `EST People SRC` = `grid-X316Eql8dE`.
- The Worker (`proxy/src/worker.js`) is route-dispatched on `url.pathname.split('/')`. Helpers exist: `json(obj, status, cors)`, `readAllRows(url, auth)` (returns `{ok, items:[{id, name, values}]}`), `resolvePerson(email, base, docId, auth)` → `{personId, name, canWrite, canApprove}` or `null`, and `authIdentity(request, env, base, docId, auth)` → `null` (no token) | throws (invalid → 401) | `{matched, email, canWrite, canApprove, personId?, name?}`. `base`/`docId`/`auth` (Coda bearer headers) are in scope in the fetch handler.
- **Guardrails (design decision):** member routes require a valid Firebase token; reads are **member-projected** (public fields only — never internal Planning Notes, attribution, or full address); a member may insert/delete only **their own** claims.
- **Live-schema confirmations to resolve at build** (from the design's open decisions): exact `EST People SRC` columns to set on create (Full Name + which email column + a source/flag); the `Events EVENTBRITE` public-URL field for the CTA; the coarse/public-location field. Resolve each with a `table_columns_read` / a probe `readAllRows` before writing the dependent code — these are verification steps, not placeholders.

## File structure (Phase 1)

- **Coda (via MCP `table_create` or the Coda UI):** new `EST Slots SRC` + `EST Claims SRC` tables.
- **Create** `proxy/src/gather.js` — pure helpers: `projectEventForMember(row, slots, claims, callerPersonId)`, `slotRemaining(slot, claims)`, `validateClaimInput(body)`. Exported for unit tests.
- **Create** `proxy/test/gather.test.js` — unit tests for the pure helpers.
- **Modify** `proxy/src/worker.js` — add member + slot routes to the dispatch; add `findOrCreatePerson`.
- **Modify** `proxy/wrangler.toml` — add `CODA_SLOTS_TABLE`, `CODA_CLAIMS_TABLE` vars.

## Task 1.1 — Create the Coda tables

- [ ] **Slots** (`EST Slots SRC`): `Event` (relation → `EST Planning Events SRC`, single), `Kind` (select: Potluck / Volunteer), `Label` (text, display), `Needed qty` (number), `Sort order` (number).
- [ ] **Claims** (`EST Claims SRC`): `Slot` (relation → Slots, single), `Member` (relation → `EST People SRC`, single), `Contribution detail` (text, display), `Qty` (number, default 1), `Notes` (text), `Created on` (native created-time).
- [ ] Record the two `grid-...` ids; add to `proxy/wrangler.toml` `[vars]` as `CODA_SLOTS_TABLE` / `CODA_CLAIMS_TABLE`. Seed 1–2 slot rows on a published event for testing.

**Verification:** both tables exist with the exact columns/relations; a manual test claim row resolves its Slot + Member relations.

## Task 1.2 — Pure helpers + unit tests (TDD)

Write `proxy/test/gather.test.js` first, then `proxy/src/gather.js`. Cover:
- `slotRemaining({neededQty:3}, [{qty:1},{qty:1}])` → `1`; never negative; oversubscription returns `0` (not negative) but is allowed.
- `validateClaimInput` — rejects missing `slot`; defaults `qty` to `1`; coerces/limits `qty` to a sane positive integer; trims strings.
- `projectEventForMember` — asserts the output contains ONLY public fields (title, date/scheduling, coarse location, public description, eventbrite URL, slots with `remaining` + `mineClaimed`) and NEVER internal fields (planning notes, attribution, exact address). This test is the security contract — make it explicit and strict.

**Verification:** `cd proxy && node --test` green, including the projection-omits-internal-fields assertion.

## Task 1.3 — Worker member routes

Add to the `worker.js` dispatch (member routes require a valid Firebase token via `authIdentity`; on `null` token → 401; reads are member-projected):

- [ ] `GET /member/me` → verify token; **find-or-create** the People row (Task 1.4); return `{ id, name }`.
- [ ] `GET /events` → planning rows where `Published? = true` and date ≥ today, each `projectEventForMember` with its Slots (+ per-slot `remaining` and `mineClaimed` for the caller). Reads Slots/Claims for the listed events.
- [ ] `GET /events/:id` → one event's projection + its slots + claims (claimant display name + contribution — the "what's coming" view).
- [ ] `POST /claims` (body `{ slot, contributionDetail, qty, notes }`) → `validateClaimInput`; resolve caller's personId; insert a Claim with `Member` = caller. (Best-effort `remaining>0` check; oversubscription accepted per design.)
- [ ] `DELETE /claims/:id` → load the claim; **verify its `Member` === caller's personId** (else 403); delete.
- [ ] `GET /me/claims` → the caller's claims across events.

**Verification (curl against `wrangler dev` with a real Firebase token):** anon → 401 on member routes; `/events` omits internal fields; a claim inserts and `remaining` decrements; a second member cannot delete the first's claim (403); `/me/claims` returns only the caller's.

## Task 1.4 — Find-or-create People

- [ ] `findOrCreatePerson(email, name, base, docId, auth)`: match `email` against `All Emails` in `EST People SRC` (reuse `resolvePerson`'s matcher); if found, return it; else **create** a People row with the verified name + email + a source flag (e.g. `Source = "gather self-signup"` — confirm the exact column at build), then return it. Used by `GET /member/me` and before any `POST /claims`.

**Verification:** a never-seen verified email creates exactly one People row (flagged self-onboarded); a known email matches without creating.

## Task 1.5 — Lead slot routes (for the Phase 3 builder)

- [ ] `POST /slots` (create), `PUT /slots/:id` (edit), `DELETE /slots/:id` — **role-gated to `canWrite`** (Program Lead/Tribal Council), writing the Slots table. Mirror the existing `/rows` write posture (auth → 403 if not `canWrite`).

**Verification:** a lead token can create/edit/delete a slot; a plain member token → 403.

---

# Phase 2 — gather app (SCOPED — own plan at build)

Mobile-first buildless app in `gather/`, on Netlify, reusing Firebase auth via the **`/shared` mechanism** (introduced here): move `web/auth-firebase.js` → `shared/auth-firebase.js`, add a trivial deploy-time copy (`cp -r ../shared ./shared`) as each Netlify site's build command so both `web/` and `gather/` load `shared/auth-firebase.js` at runtime (still no bundler); update the plan app's `index.html` reference and re-verify sign-in.

Surfaces (from design §5): **Home** = published upcoming events (via `GET /events`); **Event detail** = details always + "Register on Eventbrite" CTA + (if slots) the live sign-up sheet with claim/unclaim; **My sign-ups** = the caller's claims. Coarse location only (full address deferred). No registration resolution in v1.

Also here: add the `gather` origin to the Worker `ALLOWED_ORIGIN` allowlist and to Firebase Authorized domains.

Its detailed plan (components, state, exact DOM/handlers, TDD where testable, browser verification) is authored when Phase 1 + Netlify are done.

---

# Phase 3 — Slot builder in the plan app (SCOPED — own plan at build)

Build the "Volunteers & potluck" coming-soon stub in the event workspace into a minimal editor: add/remove a slot (Kind, Label, Needed qty), reorder (Sort order), writing via the lead-gated `/slots` routes from Phase 1. Templates deferred. Show a "these go live to members once the event is published" note.

Detailed plan authored at build (it plugs into the existing `SECTIONS`/`renderSection` machinery in `web/app.js`).

---

# Phase 4 — Email deliverability (SCOPED — own plan at build)

**Problem (confirmed live 2026-08-24):** Firebase's default magic-link sender `noreply@est-planning-calendar.firebaseapp.com` has no `eastsidetribe.org` DKIM alignment → lands in spam. Tolerable for the plan app (leads use Google) but **blocking for gather** (magic-link is the primary member path). This partly reverses the earlier "Firebase kills the email-DNS concern" assumption.

Decision to make in this phase's plan (pick one):
- **(a) GCP Identity Platform custom SMTP** — upgrade Firebase Auth to Identity Platform, configure custom SMTP through a domain-aligned relay.
- **(b) Self-send the link** — generate the sign-in link server-side (Firebase Admin SDK `generateSignInWithEmailLink`) in the Worker and send via a provider (e.g. Resend) authenticated for `eastsidetribe.org`.

Either way: add **SPF/DKIM records for a sending subdomain** (e.g. `mail.eastsidetribe.org`) at Hover — safe/additive, **never** the apex Workspace `MX`/DKIM. Template polish (from-name/copy) is a minor add-on, not the fix.

Detailed plan (chosen approach + exact DNS records + verification via a deliverability test) authored at build, before member launch.

---

## Roadmap self-review

- **Phase 1 is independent and buildable now** (backend only; no Netlify/front-end dependency) — good first chunk to execute in parallel with the Netlify migration.
- **The projection security contract** (`projectEventForMember` omits all internal fields) is called out as an explicit, unit-tested requirement — it's the main correctness risk of exposing planning rows to members.
- **Concurrency:** claim-per-row + computed `remaining` means only benign oversubscription (accepted); no lost-update. No datastore change from Coda.
- **Deferred to their phases, deliberately:** the `/shared` mechanism (Phase 2, where it's first needed), the `gather` CORS/Firebase-domain additions (Phase 2), and domain-aligned email (Phase 4, before member launch).
- Per the design's open items, Phase 1 has explicit **live-schema confirmation steps** (People columns, EB URL field, coarse-location field) rather than guessed values.
