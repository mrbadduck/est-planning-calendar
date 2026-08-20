# Proxy (Superhuman Docs API)

A Cloudflare Worker that holds the Superhuman Docs (Coda) API token server-side
and exposes planning rows to the calendar app. The token never reaches the browser.
Reads (`GET /rows`, `GET /ref/*`) are unauthenticated; writes are gated by Google
Sign-In + role (verified server-side). CORS is an allowlist in `ALLOWED_ORIGIN`
(comma-separated) — the deploy origin `plan.eastsidetribe.org` plus
`http://localhost:8080` / `http://127.0.0.1:8080` for local dev. The Worker reflects
the request's Origin when it's on the list. See `../docs/architecture.md`.

## Local dev
    cp .dev.vars.example .dev.vars   # fill in real values (gitignored)
    npm install
    npm run dev

## Deploy
    npm install
    npx wrangler secret put CODA_API_TOKEN   # first time only
    npm run deploy

Set `CODA_DOC_ID`, `CODA_TABLE_ID`, `ALLOWED_ORIGIN` as vars in `wrangler.toml`
or the Cloudflare dashboard. See `../docs/deployment.md`.
