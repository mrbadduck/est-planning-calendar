# Deployment

The app deploys **standalone** to Netlify at `plan.eastsidetribe.org`; the
proxy runs as a Cloudflare Worker. Auth is **phased** — Phase 1 is read-only with
no user login, Phase 2 adds in-app Firebase Authentication (Google + email
magic-link) before writes go live. See `docs/architecture.md` for the *why*.

## Local development (hot reload, no build step)

The app is buildless — three static files in `web/` (`index.html`, `styles.css`,
`app.js`). To edit with live reload:

    npx -y live-server web --port=8080 --no-browser

Then open `http://localhost:8080`. Saving any file in `web/` auto-reloads the page.
`live-server` is fetched on demand by `npx` — nothing is added to the repo, no
`package.json`, no build. (A `.claude/launch.json` config is checked in so the
in-editor preview can start the same server.)

**Local runs on live data.** There is no mock — `web/app.js` always uses
`CodaSource`, hitting the deployed Worker proxy. The Worker's `ALLOWED_ORIGIN`
allowlist includes `http://localhost:8080` (and `http://127.0.0.1:8080`) alongside
the deploy origin, so **reads work from localhost** — the proxy's read endpoints
(`GET /rows`, `GET /ref/*`) are unauthenticated. Use port **8080** locally to match.

**Sign-in and writes need one more step you must do once:** add `localhost` to the
**Firebase authorized domains** (Firebase Console → Authentication → Settings).
Until then, Firebase sign-in won't initialize on localhost (you'll see a harmless
"Not signed in" console notice), and since create/edit/approve require a verified
identity, writes stay unavailable locally. Reads and all UI/layout work are
unaffected.

⚠️ **Local writes hit the real `EST Planning Events SRC` table** — there's no staging
data. This is the same table the deployed site writes to, so it's no more dangerous
than editing on `plan.eastsidetribe.org`, but be deliberate when testing writes
locally.

Opening `web/index.html` directly with `file://` won't work for data — the `file://`
origin isn't in the CORS allowlist. Use the server.

## DNS — the one record to add (do NOT move nameservers)

`eastsidetribe.org` keeps its nameservers at **Hover**. It carries the Strikingly
marketing site (apex `A` / `www`) and **Google Workspace email** (`MX`, DKIM) — none
of which we touch. We only *add*/edit subdomains:

    plan  CNAME  harmonious-dodol-5e833b.netlify.app

Netlify's external-DNS custom-domain flow also needs a one-time
`subdomain-owner-verification` TXT record (added at Hover) to prove ownership of
`plan` before it will issue the cert. Adding/editing these subdomain records cannot
affect the apex site or email. (This is why we did **not** choose Cloudflare Access,
which would require migrating the whole zone to Cloudflare.)

## Phase 1 — App (web/) → Netlify at plan.eastsidetribe.org

1. Create a Netlify site from this repo: base directory `web/`, no build command,
   publish directory `web/`, deploy branch `main` (buildless — Netlify just serves
   the static files as-is). Netlify auto-deploys on every push to `main` that
   touches `web/`.
2. Site settings → **Domain management → Add a domain**: enter
   `plan.eastsidetribe.org`.
3. Verify ownership: Netlify issues a `subdomain-owner-verification` TXT record;
   add it at Hover.
4. Repoint DNS at Hover: `plan CNAME harmonious-dodol-5e833b.netlify.app` (the
   site's default Netlify subdomain). Once the CNAME and TXT resolve, Netlify
   auto-provisions a Let's Encrypt cert for `plan.eastsidetribe.org` — no manual
   HTTPS step.
5. App URL: `https://plan.eastsidetribe.org`
   (Netlify's default site URL, still live: `https://harmonious-dodol-5e833b.netlify.app`.)
   Embed test (deferred use): `https://plan.eastsidetribe.org/embed-test/`

## Phase 1 — Proxy (proxy/) → Cloudflare Workers (read-only)

The Worker runs on its free `*.workers.dev` URL — no custom domain, no DNS.

    cd proxy
    npm install
    npx wrangler secret put CODA_API_TOKEN     # a READ-scoped, doc-scoped token
    # In wrangler.toml or the dashboard, set the vars:
    #   CODA_DOC_ID    = "DYAz_wCVfv"
    #   CODA_TABLE_ID  = "<phase-1 read table, e.g. grid-9TAt5vMMKH for EST Events SRC>"
    #   ALLOWED_ORIGIN = "https://plan.eastsidetribe.org"
    npm run deploy

Scope the token to the Mission Control doc and **read-only** for Phase 1. `CORS` is
locked to `ALLOWED_ORIGIN` so only the app's origin can call the Worker from a
browser. Note the deployed Worker URL — it becomes the app's `CodaSource.base`.

CI (optional): add repo secret `CLOUDFLARE_API_TOKEN`, then the `deploy-proxy`
workflow deploys on pushes touching `proxy/`. The `CODA_API_TOKEN` secret is still
set once via `wrangler secret put` or the dashboard.

## Phase 1 — Wire the app to the proxy (read path only)

In `web/index.html`, swap `MockSource` for a `CodaSource` whose `base` is the
deployed Worker URL (the commented `CodaSource` in the file is the template).
Reshape the read mapping (`codaRowToEvent`) to the real table's column names.
**Success check:** open `https://plan.eastsidetribe.org` and confirm real EST rows
render — that proves the full path (browser → Pages → Worker → Superhuman Docs).

## Phase 2 — Auth + writes (before create/edit/approve go live)

1. Create a **Firebase project** (`est-planning-calendar`) and enable the
   **Google** and **Email link (magic-link)** sign-in providers (Firebase Console
   → Authentication → Sign-in method). The Firebase web config is public and safe
   to ship in the app.
2. App: add the Firebase Auth SDK (Google + email magic-link); on write requests,
   send the returned Firebase ID token as `Authorization: Bearer <token>`.
3. Worker: **verify** the ID token as a Firebase ID token (checking `iss` =
   `https://securetoken.google.com/est-planning-calendar`, `aud` = the Firebase
   project id, `exp`, via Google's public keys) and check the email against an
   **allowlist** (`resolvePerson` → `EST People SRC` → role, unchanged from the
   prior Google Sign-In setup) before allowing any `POST/PUT/DELETE`. Swap the
   Coda token to a **read+write** doc-scoped token.

## Secrets checklist

- Superhuman Docs token: **Worker secret only** (`CODA_API_TOKEN`) — never committed,
  never in the app. Read-scoped in Phase 1; read+write in Phase 2.
- `ALLOWED_ORIGIN`: Worker var = `https://plan.eastsidetribe.org`.
- Phase 2: the Firebase web config and `FIREBASE_PROJECT_ID` (`est-planning-calendar`)
  ship in the app / Worker var (public); the **allowlist** and the read+write Coda
  token live in the Worker.
- `CLOUDFLARE_API_TOKEN`: GitHub repo secret (for CI proxy deploys only).
- The legacy optional `APP_KEY` shared-secret path is superseded by the phased model
  above and is not used for the standalone deploy.
