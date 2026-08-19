# Architecture

## Source of truth
The **Mission Control** doc in Superhuman Docs (formerly Coda) is the single source
of truth — doc id `DYAz_wCVfv` (`superhuman://docs/DYAz_wCVfv`). A planning event is
a rich relational record (program, leads, ticketing, banner, promotion) that the
calendar merely *views*. The app owns no data.

Real source tables: `EST Events SRC` (`grid-9TAt5vMMKH`), `EST Programs SRC`
(`grid-g87NFbtqN8`), `EST People SRC` (`grid-X316Eql8dE`). **There is no dedicated
planning table yet** — a page named "Planning Calendar" exists but holds none.
Where planning rows live (a new table vs. a status field on `EST Events SRC`) is a
Phase 2 decision; Phase 1 simply reads one real table to prove the pipe.

## The app is a thin view layer
`web/index.html` renders a full-year calendar and an overview, and lets leads
create / edit / delete planning rows and (as VP) approve them. It reads and writes
only through the proxy. Two views:
- **Overview** (default): whole year, months as cards, weeks bucketed
  weeknight (Mon-Thu) / weekend (Fri-Sun). Undated ideas in a month footer.
- **Calendar**: detailed month grids with a left "Ideas" gutter for undated
  ideas, anchored to their rough week/month.

Program year runs Sep -> Aug.

## Token stays server-side (the proxy)
Superhuman Docs uses bearer-token auth, and anything in browser-side JS is readable
(whether embedded or standalone). So the token lives in the **proxy** (`proxy/`), a
Cloudflare Worker on its free `*.workers.dev` URL. The app calls the Worker; the
Worker calls Superhuman Docs. Use a **doc/table-scoped** token — **read-scoped**
until writes are enabled — to limit blast radius.

## Auth is phased
The app is public at `plan.eastsidetribe.org`, so we protect **writes**, not reads
(planning data is low-stakes; writing to live EST tables is not).

- **Phase 1 — read-only + CORS lock.** The Worker exposes only `GET /rows`, holds a
  read-scoped token, and sets CORS to allow just `https://plan.eastsidetribe.org`.
  No user login. Enough to confirm the whole flow end-to-end.
- **Phase 2 — in-app Google Sign-In.** When create/edit/approve go live, the app
  uses Google Identity Services to sign the lead in and sends the Google-signed ID
  token to the Worker as a Bearer. The Worker **verifies the JWT** (Google's public
  keys; `aud`/`iss`/`exp`) and checks the email against an **EST-leads allowlist**
  before any write. This also yields per-person attribution and VP-only approve.

Cloudflare Access (a login wall in front of everything, zero app code) was
considered and rejected: it needs `eastsidetribe.org`'s zone on Cloudflare, i.e. a
nameserver migration — see **Hosting & DNS**.

## Hosting & DNS
The app is a static, buildless page, so it deploys to **GitHub Pages** from `web/`
(the `deploy-pages` workflow) and is served at **`plan.eastsidetribe.org`** via a
single DNS record at Hover:

    plan  CNAME  mrbadduck.github.io

Only a **subdomain** record is added; the apex `A`/`www` (the Strikingly marketing
site) and the `MX`/DKIM (Google Workspace email) on `eastsidetribe.org` are never
touched, so the main site and email can't be affected. Hover stays the registrar
and DNS host — **we do not move nameservers to Cloudflare.** GitHub provisions the
HTTPS certificate for the custom domain; keep a `web/CNAME` file so the setting
survives redeploys.

## Embedding (deferred)
Standalone hosting is the current path, so the Mission Control embed is not on the
critical path. If we ever embed: a full-page embed is a sandboxed iframe that
blocks scripts by default and must run in **Compatibility mode**; `web/embed-test/`
validates that scripts execute before investing in embed-dependent work.

## Downstream lives in Superhuman Docs, not the app
Once a row is **approved**, Superhuman Docs automations/buttons push it to
Eventbrite, the public Google Calendar, Mailchimp, and socials. The app's scope
ends at "approved."

## Reference calendars
US + Jewish holidays and partner-org calendars are read-only overlays. Live plan:
Hebcal JSON for Jewish holidays; shared Google Calendars synced into Superhuman
Docs tables and read through the proxy.

## Data-layer seam
The app normalizes every event to one shape and transforms Superhuman Docs rows
via `codaRowToEvent` / `eventToCodaCells`. Going live = point the data layer at
the proxy; the UI does not change.
