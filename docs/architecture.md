# Architecture

## Source of truth
The **Mission Control planning table** in Superhuman Docs (formerly Coda) is the
single source of truth. A planning event is a rich relational record (program,
leads, ticketing, banner, promotion) that the calendar merely *views*. The app
owns no data.

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
Superhuman Docs uses bearer-token auth, and anything in a browser embed is
readable. So the token lives in the **proxy** (`proxy/`), a Cloudflare Worker.
The app calls the Worker; the Worker calls Superhuman Docs. Use a doc/table-scoped
token to limit blast radius. Optional gating: an `APP_KEY` shared secret now, a
Google-login allowlist later.

## Embedding
Mission Control full-page embed = an iframe, sandboxed by default (scripts
blocked). Must run in **Compatibility mode**. `web/embed-test/` validates that
scripts execute before investing in wiring.

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
