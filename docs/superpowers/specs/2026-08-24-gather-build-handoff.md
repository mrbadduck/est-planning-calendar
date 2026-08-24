# gather build — combined Worker + client handoff

Status: **handoff for a fresh session.** Date: 2026-08-24.

**Goal:** Build the member-facing `gather` app (potluck/volunteer slot sign-ups),
building **each Worker route together with its client consumer** so every slice is
validated in-app (real sign-in in the browser) as it lands. This **supersedes the
"backend-first" split** in the roadmap — routes and app ship together per vertical
slice.

**Read first:**
- Design: `docs/superpowers/specs/2026-08-24-gather-member-app-design.md`
- Phased roadmap (scope + open items): `docs/superpowers/plans/2026-08-24-gather-build-roadmap.md`
- Netlify migration (for `/shared` + the gather site): `docs/superpowers/plans/2026-08-24-netlify-monorepo-migration.md`

---

## Already done — do NOT rebuild

- **Firebase Auth** (Google + email magic-link) is live and unified. The Worker
  verifies Firebase ID tokens (`proxy/src/auth.js`, `verifyFirebaseIdToken`);
  `authIdentity` → `{matched, email, canWrite, canApprove, personId, name}`;
  `resolvePerson` maps email → `EST People SRC` → role. The browser side is
  `web/auth-firebase.js` exposing `window.estAuth` ({init, signInWithGoogle,
  sendEmailLink, completeEmailLinkIfPresent, signOut}).
- **Netlify hosting** is live for the plan app (`plan.eastsidetribe.org`). The
  `gather/` placeholder + repo `netlify.toml` are on `main`. **The gather Netlify
  site + `gather.eastsidetribe.org` CNAME may not be created yet** — Slice 0 covers it.
- **Coda tables** (Mission Control doc `DYAz_wCVfv`), on a "gather · slots & claims"
  page: **`EST Slots SRC` = `grid-hvmYYZAZYv`**, **`EST Claims SRC` = `grid-xpPt3WxUR3`**.
- **`proxy/src/coda-columns.js`** — the central map of **stable column ids** (each
  commented with its human name) for Planning / Slots / Claims / People.
- **`proxy/src/gather.js`** — pure, unit-tested helpers: `slotRemaining`,
  `validateClaimInput`, `projectEventForMember`. **`projectEventForMember` is the
  member-projection allowlist** — it returns ONLY public fields and a
  `gather.test.js` test proves internal fields (Planning Notes, attribution, etc.)
  can't leak. Id-based.
- **Auth path is id-hardened** (rename-proof sign-in/role gate).

## Non-negotiable conventions

- **Reference Coda columns by id, via `coda-columns.js`** — never by name. Read rows
  with `useColumnNames=false` (`readAllRows(url, auth, { byId:true })`); write cells
  with `{ column: <id> }`. (`readAllRows`'s default is still name-keyed for legacy
  callers — pass `{byId:true}` for all new gather reads.)
- **The UI must not learn the Coda row shape** (design decision #4) — normalize
  server-side; the gather client consumes the semantic JSON the Worker returns
  (`projectEventForMember`'s output), never raw Coda cells.
- **Buildless** front-ends; `node --check` after JS edits; pure logic → `node --test`.

## Confirmed live schema (column ids in `coda-columns.js`)

- **Planning** (`grid--gYIvdD-cE`), member-public fields (`PLANNING_COLS`): `title`,
  `publicSummary`, `publicDescription`, `scheduling`/`date`/`start`/`end`/`allDay`/
  `windowStart`/`windowEnd`, `venue`/`venueOther`, `addressVisibility`,
  **`eventbriteUrl`** (the CTA — a direct text column on the row, no relation hop),
  **`published`** (the visibility gate). EXCLUDE all internal fields.
- **People** (`grid-X316Eql8dE`, `PEOPLE_COLS`): find-or-create writes `fullName`,
  `firstName`, `lastName`, **`emailManual`** (`Email (Manual Input)` — the writable
  email; `allEmails` is a read-only formula that *combines* it, so writing
  `emailManual` makes future matches work). Match on `allEmails`; role via
  `leadershipStatus`.
- **Slots** (`SLOT_COLS`): `label`, `event`→Planning, `kind` (Potluck/Volunteer),
  `neededQty`, `sortOrder`.
- **Claims** (`CLAIM_COLS`): `contributionDetail`, `slot`→Slots, `member`→People,
  `qty`, `notes`.

---

## The build — vertical slices (each ends in an in-app validation)

Add `CODA_SLOTS_TABLE=grid-hvmYYZAZYv` + `CODA_CLAIMS_TABLE=grid-xpPt3WxUR3` to
`proxy/wrangler.toml` `[vars]` up front.

### Slice 0 — gather app shell, `/shared`, auth, find-or-create
- **Netlify Site 2** for `gather/` + `gather.eastsidetribe.org` (if not up) — see the
  Netlify migration plan; brand-new subdomain, add records at Hover (never touch
  apex/`www`/MX/DKIM).
- **`/shared` mechanism:** move `web/auth-firebase.js` → `shared/auth-firebase.js`;
  give each Netlify site a deploy-time copy (`cp -r ../shared ./shared` as the build
  command) so both apps load `shared/auth-firebase.js` at runtime (still no bundler).
  Update the plan app's `index.html` reference and **re-verify plan sign-in**.
- Add `https://gather.eastsidetribe.org` (+ its dev origin) to the Worker
  `ALLOWED_ORIGIN` and to **Firebase Authorized domains**.
- **Worker `GET /member/me`:** verify Firebase token → `findOrCreatePerson` → `{id, name}`.
- **`findOrCreatePerson(email, name, …)`:** match `email` against `allEmails`; if
  found return it; else create a People row (`fullName` + `firstName`/`lastName` +
  `emailManual`) flagged self-onboarded (decide: a new `Source` column vs. a `Notes`
  marker), return it. Used by `/member/me` and before every `POST /claims`.
- **Client:** mobile-first gather shell; Firebase sign-in via `estAuth`; call `/member/me`.
- **Validate in-app:** sign in on gather with a never-seen email → a People row is
  minted (check Coda) → the app shows "you're in".

### Slice 1 — home list
- **Worker `GET /events`:** planning rows where `published=true` AND date ≥ today;
  `projectEventForMember` each (list mode — no claimant names), reading each event's
  Slots + Claims for `remaining`/`mineClaimed`. Member-token-gated; member-projected.
- **Client:** home = list of published upcoming events.
- **Validate:** published events show, drafts don't, and the response contains **no
  internal fields** (spot-check the payload).

### Slice 2 — event detail + Eventbrite CTA + slot sheet
- **Worker `GET /events/:id`:** projection with `includeClaimants:true` (slots +
  each slot's claims: name + contribution + qty).
- **Client:** detail view — details always + a prominent **"Register on Eventbrite"**
  (from `eventbriteUrl`) + the live sign-up sheet (filled vs. open). **Coarse location
  only** (venue name / other; no street address).
- **Validate:** open a published event with slots → sheet renders with what's coming.

### Slice 3 — claim / unclaim / my sign-ups
- **Worker `POST /claims`** (body `{slot, contributionDetail, qty, notes}`):
  `validateClaimInput`; resolve caller's `personId` (find-or-create); insert a Claim
  with `member`=personId, `slot`=slot id (relations written as **row ids**).
- **Worker `DELETE /claims/:id`:** SECURITY — verify ownership by **Member row id**,
  not display name (read the claim row WITHOUT `simpleWithArrays` so the relation
  comes back as a rich `{rowId}` object; compare to caller `personId`; 403 if not
  owner), then delete.
- **Worker `GET /me/claims`:** the caller's claims across events.
- **Client:** claim/unclaim controls (+ a "what are you bringing?" input); a "My
  sign-ups" view.
- **Validate:** claim → `remaining` decrements; unclaim → restores; a second member
  cannot delete the first's claim (403). Oversubscription is allowed (benign) — not
  an error.

### Slice 4 — lead slot builder (plan app)
- **Worker `POST/PUT/DELETE /slots`** — role-gated to `canWrite`; writes Slots
  (`event`, `kind`, `label`, `neededQty`, `sortOrder`, all by id).
- **Client:** build the plan app's "Volunteers & potluck" coming-soon stub into a
  minimal slot editor (add/remove/reorder) on the event workspace; note "these go
  live to members once the event is published".
- **Validate:** a lead adds slots on a published event → they appear in gather.

---

## Implementation notes / gotchas

- **Member vs lead:** member routes need any matched signed-in person (`authIdentity`
  → `matched`); `/slots` needs `canWrite`. `null` token → 401.
- **Concurrency:** claim-per-row + computed `remaining` (never stored) → only benign
  oversubscription, no lost update. Do NOT move claims off Coda.
- **DELETE ownership is the main security risk** — get the row-id comparison right.
- **Projection is the other security risk** — `/events` + `/events/:id` return ONLY
  `projectEventForMember` output. Never hand raw Coda rows to the client.
- **Testing:** pure logic → `node --test` (extend `gather.test.js`). Routes: unit
  cases can't cover the token path, so validate live in-app (member sign-in) + `curl`
  the anon/lead/403 cases. `node --check` the browser JS after edits.
- **Email deliverability (separate, pre-launch):** Firebase magic-link emails land in
  spam (default `…firebaseapp.com` sender, no `eastsidetribe.org` DKIM). Fine while
  testing (use Google sign-in), but **before member launch** gather needs
  domain-aligned sending (Identity Platform custom SMTP or Admin-SDK-generated links
  via a provider; SPF/DKIM on a sending subdomain at Hover). Roadmap Phase 4.

## Open items to confirm at build
- Self-onboarded flag: a new `Source` column on People vs. a `Notes` marker.
- `Address visibility` handling (there's a lead-set select on the planning row) — v1
  shows coarse/venue-name only; decide how/if to honor it.
- `/shared` layout: repo-root `/shared` vs. `web/shared` mirrored — pick whatever
  Netlify's per-site deploy-copy handles most simply.

## Suggested workflow for the new session
Brainstorm is done (design approved). Go straight to per-slice execution: for each
slice, write the Worker route (id-based, TDD the pure bits) + its client consumer,
deploy the Worker, then validate in the browser by signing in on gather. Use the
subagent-driven flow if desired, but keep the human-in-the-loop in-app validation
between slices — that's the whole point of building them together.
