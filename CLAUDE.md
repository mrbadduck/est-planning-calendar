# CLAUDE.md — East Side Tribe Planning Calendar

Context for Claude Code. Read this first, then `docs/architecture.md` and
`docs/deployment.md`. This file is the source of truth for *why* things are the
way they are; the docs cover deeper detail.

## What this is

A full-year program-planning calendar for **East Side Tribe (EST)**, a lay-led
Jewish community org. It is **deployed standalone** at `plan.eastsidetribe.org`
(GitHub Pages) and reads/writes EST's **Mission Control** doc in **Superhuman
Docs** through a proxy (this is Coda — renamed July 8, 2026; `docs.superhuman.com`,
`coda.io` links redirect, API still resolves at `coda.io/apis/v1`). Embedding the
app inside Mission Control is a possible later option, **not** the current path.
Program leads draft events in a low-commitment space *before* anything is
published; approved events later flow downstream to Eventbrite / Google Calendar /
Mailchimp — but that push happens in **Superhuman Docs automations, not this app.**

## Repo map

| Path | What | Deploys to |
|------|------|-----------|
| `web/index.html` | The calendar app — self-contained, vanilla JS, **no build step** | GitHub Pages |
| `web/embed-test/index.html` | "Did JS run in the embed?" validator — **deferred** (standalone is the current path) | GitHub Pages |
| `proxy/` | Cloudflare Worker holding the Superhuman Docs token server-side | Cloudflare Workers |
| `docs/` | architecture + deployment notes | — |
| `.github/workflows/` | auto-deploy web→Pages, proxy→Workers | — |

## Current status

- **App: complete and working on live data (no mock).** For local dev with hot
  reload: `npx -y live-server web --port=8080 --no-browser`, then open
  `http://localhost:8080` — no build step (see `docs/deployment.md` → *Local
  development*). The app always uses `CodaSource` (the live proxy); the Worker's
  CORS allowlist includes `localhost:8080`, so **reads work locally**. Sign-in and
  writes locally also need `http://localhost:8080` added to the Google OAuth
  client's authorized origins (one-time, in Google Cloud Console).
- **LIVE at `plan.eastsidetribe.org`** (GitHub Pages). Phase 1 + Phase 2 **Plans
  1, 2a & 2b-i shipped** (Aug 2026): leaders **sign in with Google** and
  create/edit/approve planning events that persist to `EST Planning Events SRC`,
  with server-verified identity + role gating and person-relation attribution.
  Proper types (native time; Month = `Date`=1st), refresh (button/focus/60s poll).
- **Proxy: deployed** at `est-planning-proxy.eastsidetribe.workers.dev` —
  **doc-scoped read+write** token, `ALLOW_WRITES="true"`, `GOOGLE_CLIENT_ID` set,
  CORS locked to an allowlist (the app origin + `localhost:8080` for local dev).
  Serves `GET /rows`, `GET /ref/:name`, `GET /me`
  (verifies the Google JWT → matches email to `EST People SRC` → role), and
  role-gated writes that inject person attribution. Points at
  `EST Planning Events SRC` (`grid--gYIvdD-cE`).
- **Mission Control doc identified:** doc id `DYAz_wCVfv`
  (`superhuman://docs/DYAz_wCVfv`). Real source tables: `EST Events SRC`
  (`grid-9TAt5vMMKH`), `EST Programs SRC` (`grid-g87NFbtqN8`), `EST People SRC`
  (`grid-X316Eql8dE`). **No dedicated planning table exists yet** — a page named
  "Planning Calendar" exists but holds no planning table. Where planning rows live
  (a new table vs. a status field on `EST Events SRC`) is a Phase 2 decision.
- **Not yet wired to live data.** Phase 1 lights up the read path end-to-end.

## Non-negotiable architecture decisions (don't relitigate without reason)

1. **Superhuman Docs (Coda) is the single source of truth.** A planning event is
   a rich relational record (program, leads, ticketing, banner, promotion). The
   app is a **thin view layer that owns no data** — it reads/writes only through
   the proxy.
2. **The token never reaches the browser.** Coda uses bearer-token auth; anything
   in client-side JS is readable (embed or standalone). So the token lives in the
   **proxy**. Use a **doc/table-scoped** token — **read-scoped** until writes are
   turned on — to limit blast radius.
3. **Downstream publish is a *server-side* concern (the Worker), never the
   browser.** *(Revised Aug 2026 — was "downstream lives in Superhuman Docs
   automations, not this app.")* Publish-out (Eventbrite now; gCal next) runs
   **in the proxy** on demand via a role-gated route (`POST /publish/eventbrite`),
   holding an Eventbrite **private token** as a Worker secret — same posture as
   the Coda token; the app stays a thin view. We went direct-from-Worker (not
   through a Coda pack action) because Coda's eventual-consistency lag made a
   synchronous "Publish" button janky. Coda still owns **aggregation +
   observability**: the `eventbrite-coda-pack` keeps syncing Eventbrite → Coda
   for metrics/`EST Events SRC`, and every publish attempt is logged to a
   `Publish Log` Coda table (+ status fields on the planning row). Mailchimp/
   socials remain future downstream work. Design:
   `docs/superpowers/specs/2026-08-22-eventbrite-publish-design.md`.
4. **Keep the data-layer seam clean.** The app normalizes every event to one
   shape and converts Coda rows via `planningRowToEvent` / `eventToCodaCells`
   inside `CodaSource` (the single data source; the in-memory mock was removed).
   **The UI reads only normalized events — it must not learn the Coda row shape.**
5. **Deploy standalone, keep DNS at Hover.** The app ships to GitHub Pages at
   `plan.eastsidetribe.org` via a single `plan CNAME mrbadduck.github.io` record.
   `eastsidetribe.org` also carries the Strikingly marketing site (apex/`www`) and
   **Google Workspace email** (`MX`, DKIM) — so we **never move nameservers**;
   adding a subdomain record can't disturb those. This is exactly why Cloudflare
   Access (which needs the whole zone on Cloudflare) was rejected.
6. **Auth is phased.** Phase 1: read-only proxy + CORS lock — no user login, near
   zero code, enough to confirm the flow. Phase 2 (before create/edit/approve go
   live): in-app **Google Sign-In**; the app sends the signed ID token to the
   Worker, which **verifies the JWT and checks an email allowlist** before any
   write. Writes are what needs gating; reads of planning data are low-stakes.

## Hard technical constraints (learned the hard way — verify before assuming)

- **DNS stays at Hover — never move the nameservers.** `eastsidetribe.org` carries
  the Strikingly site (apex/`www`) and live Google email (`MX`, DKIM); only ever
  *add* the `plan` subdomain record. (This is why Cloudflare Access is off the
  table — it would require the zone on Cloudflare.)
- **If we ever embed** (not the current path): Superhuman Docs embeds are sandboxed
  and block scripts by default — a custom JS app needs **Compatibility mode**, and
  `web/embed-test/` validates that *before* investing in embed-dependent work.
- **The Coda API does not expose row-layout definitions.** You can't "render the
  doc's layout" in the app. Build the edit form from column metadata + our own
  layout config, and deep-link to the doc for rich editing (ticketing, banner).
- **Coda API tokens can be scoped to a single doc/table** — use that.

## How the app (`web/index.html`) is built

Split into `web/index.html` + `web/styles.css` + `web/app.js` (buildless; all
logic in `app.js`). Key pieces of `app.js`, top to bottom:

- **Data layer**: `PROGRAMS`/`PEOPLE` (built-in palette + editor picker seeds,
  the programs list is replaced live from `/ref/programs`), `MOCK_REFS` (built-in
  holiday/partner overlays, still awaiting Hebcal), `planningRowToEvent` /
  `eventToCodaCells`, and **`CodaSource`** — the single live data source hitting
  the proxy. `const DB = CodaSource;` (the in-memory mock was removed).
- **State**: `state` object (program year, current view, layers, role, events).
  Program year runs **Sep→Aug**.
- **Event model**: normalized event with `scheduling ∈ {exact, range, month}`.
  Undated "ideas" render in the left gutter (Calendar) / month footer (Overview),
  anchored to their rough week/month.
- **Two views**: `renderOverview()` (default — whole year, months as cards, weeks
  bucketed **weeknight Mon–Thu / weekend Fri–Sun**) and `renderMonths()`
  (detailed month grids with a left "Ideas" gutter). `applyView()` toggles them.
- **Editor = a section-model workspace** (`SECTIONS` registry; rail + `#wpanel`):
  live sections **Planning** (`renderPlanning`/`wirePlanning`) + **Publish**
  (`renderPublish`/`wirePublish`, gated on approved), plus a muted **Coming soon**
  group (Budget/Comms/Volunteers/Attendance/Feedback) whose panels host the
  feedback board. `openEditor(ev, section)` resets to Planning unless a section is
  passed; `readForm()` null-guards every field (only the active section's inputs
  exist in the DOM). Status lifecycle idea→draft→confirmed→approved; approve gated
  server-side (Tribal Council). **Internal** description lives in Planning;
  **Public summary/description** (sent to Eventbrite) live in Publish.
- **URL deep-links**: `?event=<rowId>&section=<id>` two-way synced (`syncUrl`/
  `clearUrl`/`openFromUrl`); a **Copy link** header button shares the current view.
- **Feedback/Ideas board** (`feedbackBoardHTML`/`wireFeedback`): a votable roadmap
  board — a global header CTA (`#feedbackBtn`) + a context-tagged board in each
  coming-soon section. Backed by the Coda `Roadmap Feedback` table
  (`grid-pP5rwauO2j`) via Worker `GET/POST /feedback` + `POST /feedback/:id/vote`
  (new var `CODA_FEEDBACK_TABLE`). Design/plan:
  `docs/superpowers/specs|plans/2026-08-22-event-workspace*`.
- **`openInfo()`**: the legend/key modal (the round "i" button).
- **`layoutSticky()`**: measures header heights into `--bar-h`/`--wh-h` so the
  sticky weekday row + month headers stack correctly; self-corrects on load,
  resize, and view switch.

### App gotchas (things that already bit us)

- All calendar grid columns use `minmax(0,1fr)`, **not** bare `1fr` — that's what
  keeps columns equal and clips long chips instead of stretching. Don't revert.
- **Class-name collision watch:** the month grid is `.mgrid`; the modal body is
  `.mbody`. Keep them distinct (they collided once and broke the calendar grid).
- Coloring is intentional: planning events by **program** (hue), **status** by
  chip treatment (dashed→tint→solid→filled+lock); reference calendars muted.
- No `localStorage` in the app today (it was built as an artifact). Once
  self-hosted this is fine to add, but real persistence should come from the Coda
  backing, not browser storage.
- After any JS edit, sanity-check by extracting the `<script>` and running
  `node --check` on it.

## Next steps (priority order)

**Phase 1 — stand up the spine (deploy + read-only) — ✅ DONE (Aug 2026).**
App live at `plan.eastsidetribe.org` (GitHub Pages) → Worker
`est-planning-proxy.eastsidetribe.workers.dev` (read-only) → Coda. See
`docs/deployment.md`.

**Phase 2 — writes + auth. Resolved: planning rows live in a NEW table,
`EST Planning Events SRC` (`grid--gYIvdD-cE`) — the app originates events
(inverting the old Eventbrite-first flow). See `docs/phase2-planning-table.md`.**

4. **Plan 1 — ✅ DONE (Aug 2026):** table created + seeded; proxy repointed; app
   reads it read-only.
5. **Plan 2a — ✅ DONE (Aug 2026):** proper types (native time; Month=`Date`=1st);
   `/ref/:name` endpoints; refresh (button/focus/60s poll).
6. **Plan 2b-i — ✅ DONE (Aug 2026):** Google sign-in + Worker JWT verify +
   email→`EST People SRC` match + role gate (write = Program Lead/Tribal Council;
   approve = Tribal Council); role-gated writes inject person attribution; scalar
   create/edit/approve persist. See `docs/phase2-plan-2b-i-auth-writes.md`.
7. **Plan 2b-ii — editor relation pickers + full create-with-relations:**
   - **2b-ii-a — ✅ DONE (Aug 2026):** real program palette + generated colors from
     `/ref/programs`; multi-program editor picker (writes the `Program(s)`
     relation); crossover `+N` marker.
   - **2b-ii-b — ✅ DONE (Aug 2026):** slim `/ref/people` `{id,name,lead}`
     projection (1128 rows → ~100KB); **Leads** chip list (write-authorized only:
     Program Lead/Tribal Council); **Volunteers** typeahead over all people (new
     `Volunteers` relation column added to the planning table); **Venue** cascade
     (Venue Type → filtered Venue, hides closed) + `Venue (other)`; **Planning
     Notes** template seeded on new events. All persist as relations. See
     `docs/phase2-plan-2b-ii-b-relations.md`.

8. **Plan 2b-iii — Planning Notes as per-row Google Docs (Aug 2026, deployed):**
   internal notes moved out of the Coda `Planning Notes` canvas column into a
   **per-event Google Doc**. Coda provisions it via a **row button** (official
   Google Drive pack *Copy file*, template → shared folder) — the app triggers it
   through a role-gated `POST /notes-doc` proxy route that **pushes the button by
   its stable id** (`CODA_NOTES_BUTTON_ID`), then fast-polls until the URL lands.
   The editor shows a read-only `/preview` iframe + "Edit in Google Docs". The URL
   read is **anchored to the column id** (`CODA_NOTES_COL_ID`), resolved to the
   current name server-side via list-columns — rename-proof. Legacy `Planning
   Notes` text is read-only-if-present, no longer written. Design +
   plan: `docs/superpowers/specs/2026-08-20-planning-notes-google-docs-design.md`,
   `docs/superpowers/plans/2026-08-20-planning-notes-google-docs.md`.

**Later:**

8. **References live:** Hebcal JSON for Jewish holidays; shared Google Calendars
   synced into Superhuman Docs and read via the proxy.
9. **Downstream automations** in Superhuman Docs (approved → Eventbrite/gCal/
   Mailchimp/socials).
10. **Polish:** real mobile layout; active conflict warnings; per-person
    layer-toggle persistence. Consider a 2-token split (read-only doc token +
    planning-write token) to tighten the Worker's write scope.
11. **(Optional) Embed** inside Mission Control — validate `web/embed-test/` first.

## Open decisions

- Weeknight/weekend grain in Overview vs. splitting Friday out from the weekend.
- Endpoint of the inversion: eventually replace `EST Events SRC` vs. coexist
  (deferred — "design the table first"; see `docs/phase2-planning-table.md`).

Resolved (Aug 2026): standalone hosting on **GitHub Pages** at
`plan.eastsidetribe.org` (not Cloudflare Pages/Access — keeps DNS at Hover); auth
is **phased** (read-only + CORS now, Google login + allowlist for writes);
planning rows live in a **new table** `EST Planning Events SRC` (not a status
field on `EST Events SRC`) — the app originates events, inverting the flow.

## Conventions

- `main` is always deployable. Work on branches, PR into `main`.
- **Never commit secrets.** Tokens live in Worker secrets / `.dev.vars`
  (gitignored). `proxy/.dev.vars.example` is the template. Secrets in use:
  `CODA_API_TOKEN`, and `EVENTBRITE_TOKEN` (EST-org private token for publish-out —
  `wrangler secret put EVENTBRITE_TOKEN`). **To rotate:** the `eventbrite-coda-pack`
  repo had a Coda API key committed in `.coda.json` — rotate it.
- Keep the app self-contained and buildless unless there's a strong reason to add
  tooling.
