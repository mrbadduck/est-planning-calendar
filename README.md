# East Side Tribe - Programming Planning Calendar

Tooling for EST program planning. A full-year planning calendar **deployed
standalone** at `plan.eastsidetribe.org` (GitHub Pages), backed by the EST
**Mission Control** doc (Superhuman Docs, formerly Coda) through a proxy. Approved
events flow downstream into Eventbrite / Google Calendar / Mailchimp via Superhuman
Docs automations. (Embedding inside Mission Control is a possible later option, not
the current path.)

## Components

| Path | What it is | Deploys to |
|------|-----------|-----------|
| `web/index.html` | The planning calendar app (static, self-contained) | GitHub Pages → `plan.eastsidetribe.org` |
| `web/embed-test/` | Verify scripts run inside a Superhuman Docs embed (deferred) | same |
| `proxy/` | Cloudflare Worker holding the Superhuman Docs API token; reads planning rows (writes come with Phase 2 auth) | Cloudflare Workers |
| `docs/` | Architecture decisions + deployment notes | - |

## Quick start

**Run the app locally:** open `web/index.html` in a browser (it's self-contained;
uses in-memory mock data). No build step.

**Run the proxy locally:** see `proxy/README.md`.

## Deploy

- **App** -> GitHub Pages (auto, via `.github/workflows/deploy-pages.yml`).
  Enable once: Settings -> Pages -> Source: **GitHub Actions**, then set the custom
  domain `plan.eastsidetribe.org` and add `plan CNAME mrbadduck.github.io` at Hover.
  URL: `https://plan.eastsidetribe.org`
  (default Pages URL still works: `https://mrbadduck.github.io/est-planning-calendar/`).
- **Proxy** -> Cloudflare Workers (`npm run deploy` in `proxy/`, or the CI workflow
  once `CLOUDFLARE_API_TOKEN` is added as a repo secret). Phase 1 is read-only with
  CORS locked to the app origin; see `docs/deployment.md`.

Full steps: `docs/deployment.md`.

## Source-control conventions

- `main` is always deployable. Do work on branches; open a PR into `main`.
- **Never commit secrets.** Tokens live in Worker secrets / `.dev.vars` (gitignored).
  See `proxy/.dev.vars.example`.
- Keep the app's data layer swappable: it reads/writes through the proxy only, so
  the source of truth (Superhuman Docs) can change without touching the UI.
