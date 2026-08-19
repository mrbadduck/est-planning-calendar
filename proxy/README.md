# Proxy (Superhuman Docs API)

A Cloudflare Worker that holds the Superhuman Docs (Coda) API token server-side
and exposes read/write of the planning table to the calendar app. The token
never reaches the browser.

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
