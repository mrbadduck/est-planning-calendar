# Deployment

## App (web/) -> GitHub Pages
1. Push to `main`.
2. One-time: repo **Settings -> Pages -> Source: GitHub Actions**.
3. The `deploy-pages` workflow publishes `web/` on every push that touches it.
4. App URL: `https://<username>.github.io/<repo>/`
   Embed URL for Mission Control (Compatibility mode).
   Embed test: `https://<username>.github.io/<repo>/embed-test/`

Alternative: Cloudflare Pages (project root `web/`, no build command).

## Proxy (proxy/) -> Cloudflare Workers
Manual:
    cd proxy
    npm install
    npx wrangler secret put CODA_API_TOKEN     # paste doc/table-scoped token
    # set CODA_DOC_ID / CODA_TABLE_ID / ALLOWED_ORIGIN in wrangler.toml or dashboard
    npm run deploy

CI (optional): add repo secret `CLOUDFLARE_API_TOKEN`, then the `deploy-proxy`
workflow deploys on pushes touching `proxy/`. Worker secrets (CODA_API_TOKEN)
are still set once via `wrangler secret put` or the dashboard.

## Wiring the app to the proxy
In `web/index.html`, swap `MockSource` for a `CodaSource` whose `base` is the
deployed Worker URL. The commented `CodaSource` in the file is the template.
Set the Worker's `ALLOWED_ORIGIN` to the app's Pages origin.

## Secrets checklist
- Superhuman Docs token: Worker secret only (never committed, never in the app).
- Optional `APP_KEY`: Worker secret + sent by the app as `X-App-Key`.
- `CLOUDFLARE_API_TOKEN`: GitHub repo secret (for CI proxy deploys only).
