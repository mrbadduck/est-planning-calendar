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

- **App: complete and working on in-memory mock data.** Open `web/index.html`
  in a browser to run it — no server, no build. Uses real EST programs/leads as
  sample rows. Edits reset on reload (mock has no persistence yet).
- **LIVE at `plan.eastsidetribe.org`** (GitHub Pages). Phase 1 + Phase 2 **Plans
  1, 2a & 2b-i shipped** (Aug 2026): leaders **sign in with Google** and
  create/edit/approve planning events that persist to `EST Planning Events SRC`,
  with server-verified identity + role gating and person-relation attribution.
  Proper types (native time; Month = `Date`=1st), refresh (button/focus/60s poll).
- **Proxy: deployed** at `est-planning-proxy.eastsidetribe.workers.dev` —
  **doc-scoped read+write** token, `ALLOW_WRITES="true"`, `GOOGLE_CLIENT_ID` set,
  CORS locked to the app origin. Serves `GET /rows`, `GET /ref/:name`, `GET /me`
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
3. **Downstream lives in Superhuman Docs, not here.** The app's scope ends at
   "approved." Eventbrite/gCal/Mailchimp/socials are Superhuman Docs automations.
4. **Keep the data-layer seam clean.** The app normalizes every event to one
   shape and converts Coda rows via `codaRowToEvent` / `eventToCodaCells`. Going
   live = swap `MockSource` for `CodaSource` (a commented template is in the file).
   **The UI must not change when the data source changes.**
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

Single file. All logic in one `<script>`. Key pieces, top to bottom:

- **Data layer** (the swappable part): `PROGRAMS`, `PEOPLE`, `MOCK_CODA_ROWS`
  (shaped like Coda's list-rows response), `codaRowToEvent`, `eventToCodaCells`,
  `MockSource` (in-memory), and a commented **`CodaSource`** template that hits
  the proxy. `const DB = MockSource;` is the single line to flip.
- **State**: `state` object (program year, current view, layers, role, events).
  Program year runs **Sep→Aug**.
- **Event model**: normalized event with `scheduling ∈ {exact, range, month}`.
  Undated "ideas" render in the left gutter (Calendar) / month footer (Overview),
  anchored to their rough week/month.
- **Two views**: `renderOverview()` (default — whole year, months as cards, weeks
  bucketed **weeknight Mon–Thu / weekend Fri–Sun**) and `renderMonths()`
  (detailed month grids with a left "Ideas" gutter). `applyView()` toggles them.
- **Editor**: `openEditor()` + `readForm()`; status lifecycle
  idea→draft→confirmed→approved; approve is VP-only (`state.role` is hardcoded
  `'vp'` in the mock — real gating comes with **Phase 2** Google auth + allowlist).
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
7. **Plan 2b-ii — NEXT:** editor relation pickers (multi-program; venue-type→venue
   cascade; Planning Notes template); source the program palette from
   `/ref/programs`; crossover coloring; full create-with-relations.

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
  (gitignored). `proxy/.dev.vars.example` is the template.
- Keep the app self-contained and buildless unless there's a strong reason to add
  tooling.
