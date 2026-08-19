# CLAUDE.md — East Side Tribe Planning Calendar

Context for Claude Code. Read this first, then `docs/architecture.md` and
`docs/deployment.md`. This file is the source of truth for *why* things are the
way they are; the docs cover deeper detail.

## What this is

A full-year program-planning calendar for **East Side Tribe (EST)**, a lay-led
Jewish community org. It embeds into EST's **Mission Control** doc in
**Superhuman Docs** (this is Coda — renamed July 8, 2026; `docs.superhuman.com`,
`coda.io` links redirect, API still resolves at `coda.io/apis/v1`). Program leads
draft events in a low-commitment space *before* anything is published; approved
events later flow downstream to Eventbrite / Google Calendar / Mailchimp — but
that push happens in **Superhuman Docs automations, not this app.**

## Repo map

| Path | What | Deploys to |
|------|------|-----------|
| `web/index.html` | The calendar app — self-contained, vanilla JS, **no build step** | GitHub Pages |
| `web/embed-test/index.html` | "Did JS run in the embed?" validator | GitHub Pages |
| `proxy/` | Cloudflare Worker holding the Superhuman Docs token server-side | Cloudflare Workers |
| `docs/` | architecture + deployment notes | — |
| `.github/workflows/` | auto-deploy web→Pages, proxy→Workers | — |

## Current status

- **App: complete and working on in-memory mock data.** Open `web/index.html`
  in a browser to run it — no server, no build. Uses real EST programs/leads as
  sample rows. Edits reset on reload (mock has no persistence yet).
- **Proxy: skeleton only.** Not configured or deployed. Needs real doc/table IDs
  and a token.
- **Embed: not yet validated** in a real Superhuman Docs embed.
- **Not yet wired to live data.** The whole point of the next phase.

## Non-negotiable architecture decisions (don't relitigate without reason)

1. **Superhuman Docs (Coda) is the single source of truth.** A planning event is
   a rich relational record (program, leads, ticketing, banner, promotion). The
   app is a **thin view layer that owns no data** — it reads/writes only through
   the proxy.
2. **The token never reaches the browser.** Coda uses bearer-token auth; anything
   in a client-side embed is readable. So the token lives in the **proxy**. Use a
   **doc/table-scoped** token to limit blast radius.
3. **Downstream lives in Superhuman Docs, not here.** The app's scope ends at
   "approved." Eventbrite/gCal/Mailchimp/socials are Superhuman Docs automations.
4. **Keep the data-layer seam clean.** The app normalizes every event to one
   shape and converts Coda rows via `codaRowToEvent` / `eventToCodaCells`. Going
   live = swap `MockSource` for `CodaSource` (a commented template is in the file).
   **The UI must not change when the data source changes.**

## Hard technical constraints (learned the hard way — verify before assuming)

- **Superhuman Docs embeds are sandboxed and block scripts by default.** A custom
  JS app won't run unless the embed uses **Compatibility mode**. Validate with
  `web/embed-test/` *before* building more embed-dependent work.
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
  `'vp'` in the mock — real gating comes with proxy auth).
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

1. **[USER] Real schema.** Get the Mission Control **doc ID**, planning **table
   ID**, and **column list** — names, which columns are relations (Program→Programs,
   Leads→People), and which are downstream fields (ticketing, banner, Eventbrite/
   gCal IDs). Or connect the Superhuman Docs MCP so it can be read directly. This
   blocks the live swap.
2. **Validate the embed.** Deploy `web/`, drop `…/embed-test/` into a Mission
   Control full-page embed in Compatibility mode, confirm the green line renders.
3. **Configure + deploy the proxy.** `proxy/`: `wrangler secret put
   CODA_API_TOKEN`; set `CODA_DOC_ID` / `CODA_TABLE_ID` / `ALLOWED_ORIGIN`;
   `npm run deploy`.
4. **Swap `MockSource → CodaSource`** in `web/index.html` (base = Worker URL) and
   reshape `MOCK_CODA_ROWS` column names to match the real table.
5. **References live:** Hebcal JSON for Jewish holidays; shared Google Calendars
   synced into Superhuman Docs and read via the proxy.
6. **Downstream automations** in Superhuman Docs (approved → Eventbrite/gCal/
   Mailchimp/socials).
7. **Polish:** real mobile layout; active conflict warnings (overlaps / holiday
   collisions at save time); per-person layer-toggle persistence.

## Open decisions

- Weeknight/weekend grain in Overview vs. splitting Friday out from the weekend.
- Auth on the proxy: shared `APP_KEY` (quick) vs. Google-login allowlist (real
  per-lead gating + attribution).
- Hosting: GitHub Pages (wired) vs. Cloudflare Pages (would unify with the Worker).

## Conventions

- `main` is always deployable. Work on branches, PR into `main`.
- **Never commit secrets.** Tokens live in Worker secrets / `.dev.vars`
  (gitignored). `proxy/.dev.vars.example` is the template.
- Keep the app self-contained and buildless unless there's a strong reason to add
  tooling.
