# East Side Tribe - Programming Planning Calendar

Tooling for EST program planning. A full-year planning calendar **deployed
standalone** at `plan.eastsidetribe.org` (Netlify). Leaders sign in (Firebase:
Google or an emailed link) to draft, propose, approve and publish events. The app
owns no data: it reads and writes the EST **Mission Control** doc in Superhuman Docs
(formerly Coda) through a Cloudflare Worker proxy that keeps the API tokens
server-side. Publishing approved events to Eventbrite also runs in that Worker, never
the browser. A second app, **gather**, lets members sign up for potluck and volunteer
slots.

**Start with [`CLAUDE.md`](CLAUDE.md)** — the why behind the architecture, the
non-negotiable decisions, current status, and gotchas.

## Components

| Path | What it is | Deploys to |
|------|-----------|-----------|
| `web/` | The planning calendar app — buildless static files (`index.html`, `styles.css`, `app.js`) | Netlify → `plan.eastsidetribe.org` |
| `gather/` | Member sign-up app (potluck / volunteer slots) — buildless, mobile-first | Netlify → `gather.eastsidetribe.org` |
| `shared/` | Browser code both apps use (`auth-firebase.js`); committed copies live in `web/` and `gather/` | (mirrored into each site) |
| `proxy/` | Cloudflare Worker: holds the Superhuman Docs + Eventbrite tokens; reads, role-gated writes, Eventbrite publish | Cloudflare Workers |
| `scripts/` | `sync-shared.sh` — copies `shared/` into both apps (`--check` = drift guard) | - |
| `docs/` | Architecture, deployment, runbooks; design specs + plans in `docs/superpowers/` | - |

## Quick start

No build step and no mock data — locally both apps read **live** data through the
deployed proxy (`localhost:8080` and `:8081` are on its CORS allowlist):

    npx -y live-server web --port=8080 --no-browser     # plan app → http://localhost:8080
    npx -y live-server gather --port=8081 --no-browser  # gather   → http://localhost:8081

Sign-in and writes locally need `localhost` in the Firebase authorized domains, and
local writes hit the real planning table — see
[`docs/deployment.md`](docs/deployment.md) → *Local development*. Opening
`web/index.html` via `file://` won't load data.

**Proxy:** in `proxy/`, copy `.dev.vars.example` to `.dev.vars` and fill in real
values, then `npm install && npm run dev`; tests: `npm test`. See
[`proxy/README.md`](proxy/README.md).

## Deploy

- **`web/` and `gather/`** → Netlify, auto-deployed on push to `main` by Netlify's
  own git integration (no build command; each site's base directory is its folder).
- **`proxy/`** → Cloudflare Workers, auto-deployed on push to `main` touching
  `proxy/**` by `.github/workflows/deploy-proxy.yml` (or `npm run deploy` in `proxy/`).
- **DNS stays at Hover** — only the `plan` / `gather` subdomain records; never move
  the nameservers (the apex carries the marketing site and Google Workspace email).

Full steps: [`docs/deployment.md`](docs/deployment.md),
[`docs/gather-deploy-runbook.md`](docs/gather-deploy-runbook.md).

## Source-control conventions

- `main` is always deployable. Do work on branches; open a PR into `main`.
- **Never commit secrets.** Tokens live in Worker secrets / `.dev.vars` (gitignored).
  See `proxy/.dev.vars.example`.
- Keep the apps buildless. After editing anything in `shared/`, run
  `./scripts/sync-shared.sh`.
