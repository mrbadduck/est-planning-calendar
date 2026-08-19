# East Side Tribe - Programming Planning Calendar

Tooling for EST program planning. A full-year planning calendar that embeds into
the EST **Mission Control** doc (Superhuman Docs, formerly Coda), backed by the
Mission Control planning table. Approved events flow downstream into Eventbrite /
Google Calendar / Mailchimp via Superhuman Docs automations.

## Components

| Path | What it is | Deploys to |
|------|-----------|-----------|
| `web/index.html` | The planning calendar app (static, self-contained) | GitHub Pages / Cloudflare Pages |
| `web/embed-test/` | Tiny page to verify scripts run inside a Superhuman Docs embed | same |
| `proxy/` | Cloudflare Worker holding the Superhuman Docs API token, exposing read/write of planning rows | Cloudflare Workers |
| `docs/` | Architecture decisions + deployment notes | - |

## Quick start

**Run the app locally:** open `web/index.html` in a browser (it's self-contained;
uses in-memory mock data). No build step.

**Run the proxy locally:** see `proxy/README.md`.

## Deploy

- **App** -> GitHub Pages (auto, via `.github/workflows/deploy-pages.yml`).
  Enable once: Settings -> Pages -> Source: **GitHub Actions**.
  URL: `https://<username>.github.io/<repo>/` (embed target for Mission Control).
- **Proxy** -> Cloudflare Workers (`npm run deploy` in `proxy/`, or the CI workflow
  once `CLOUDFLARE_API_TOKEN` is added as a repo secret).

Full steps: `docs/deployment.md`.

## Source-control conventions

- `main` is always deployable. Do work on branches; open a PR into `main`.
- **Never commit secrets.** Tokens live in Worker secrets / `.dev.vars` (gitignored).
  See `proxy/.dev.vars.example`.
- Keep the app's data layer swappable: it reads/writes through the proxy only, so
  the source of truth (Superhuman Docs) can change without touching the UI.
