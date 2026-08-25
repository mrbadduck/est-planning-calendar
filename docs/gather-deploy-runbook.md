# gather — deploy & validate runbook

The gather app (member sign-ups) is **code-complete** across all 5 slices. This is
the one-time infra stand-up + per-slice validation. Build spec:
`docs/superpowers/specs/2026-08-24-gather-build-handoff.md`.

Nothing here touches the apex / `www` / `MX` / DKIM records — only the **new
`gather` subdomain**. DNS stays at Hover (non-negotiable, per `CLAUDE.md`).

---

## What shipped (code)

- **Worker** (`proxy/`): member routes `GET /member/me`, `GET /events`,
  `GET /events/:id`, `POST /claims`, `DELETE /claims/:id`, `GET /me/claims`, and
  lead-gated `GET/POST/PUT/DELETE /slots`. Pure helpers in `proxy/src/gather.js`
  (unit-tested, 53 passing). New `[vars]` in `wrangler.toml`:
  `CODA_SLOTS_TABLE`, `CODA_CLAIMS_TABLE`, `CODA_PEOPLE_TABLE`; `ALLOWED_ORIGIN`
  now includes `https://gather.eastsidetribe.org` + `localhost:8081`.
  **No new secret** — reuses the existing read+write `CODA_API_TOKEN`.
- **gather app** (`gather/`): mobile-first `index.html` + `styles.css` + `app.js`,
  Firebase sign-in via the shared `auth-firebase.js`.
- **Shared** (`shared/auth-firebase.js`): canonical copy; committed mirrors in
  `web/` and `gather/`; drift guard `./scripts/sync-shared.sh --check`.
- **Plan app** (`web/`): the "Volunteers & potluck" editor section is now **live** —
  a minimal slot builder (add / reorder / remove Potluck & Volunteer slots).

## Step 1 — deploy the Worker

The proxy auto-deploys to Cloudflare Workers via GitHub Actions on push to `main`
(see `.github/workflows/`). So **merging this branch deploys the Worker**, new
`[vars]` included. To deploy manually instead:

```bash
cd proxy && npx wrangler deploy
```

Smoke-check it's live and gather-aware (should be `401 sign in`, not `404`):

```bash
curl -s https://est-planning-proxy.eastsidetribe.workers.dev/events | head
```

## Step 2 — create the gather Netlify site

Second Netlify site from this same repo:

- **Base directory:** `gather`
- **Publish directory:** `gather`
- **Build command:** *(none — buildless; `auth-firebase.js` is a committed mirror)*
- After first deploy, add the custom domain **`gather.eastsidetribe.org`** in the
  Netlify site UI. Netlify shows the target `‹site›.netlify.app`.

> If you later prefer the repo-root `shared/` as the single source at deploy time,
> set the build command to `cp -r ../shared/. .` — but the committed mirror already
> makes that optional. After editing anything in `shared/`, run
> `./scripts/sync-shared.sh` and commit the mirrors (CI can gate with `--check`).

## Step 3 — DNS at Hover (subdomain only)

Add, next to the existing `plan` record (never touch apex / `www` / `MX` / DKIM):

- `gather  CNAME  ‹site›.netlify.app`
- the one-time `subdomain-owner-verification` **TXT** Netlify shows, if asked.

Netlify auto-provisions the TLS cert once the CNAME resolves.

## Step 4 — Firebase authorized domains

Firebase console → **Authentication → Settings → Authorized domains**, add:

- `gather.eastsidetribe.org`
- `localhost` (for local dev on `:8081`) — usually already present.

Same Firebase project as the plan app (`est-planning-calendar`) — one identity
pool across both apps.

## Step 5 — local dev (optional)

```bash
npx -y live-server gather --port=8081 --no-browser   # gather
npx -y live-server web    --port=8080 --no-browser   # plan
```

Reads/writes hit the live Worker (CORS allows both localhost ports). Sign-in needs
`localhost` in Firebase authorized domains (Step 4).

---

## Per-slice validation (do in the browser, signed in on gather)

1. **Slice 0 — identity.** Sign in with a **never-before-seen** email (Google or
   magic-link). A new row appears in `EST People SRC` with `Notes` =
   "Self-onboarded via gather ‹date›". The app shows you signed in (avatar).
2. **Slice 1 — home list.** Only `Published? = true` **and** date ≥ today events
   show; drafts don't. Spot-check the `/events` payload has **no internal fields**
   (no Planning Notes, no attribution, no street address).
3. **Slice 2 — detail.** Open a published event with slots → the sign-up sheet
   renders (filled vs. open, each claim's contribution), plus a "Register on
   Eventbrite" button (from the row's Eventbrite URL). Location is **coarse**
   (venue name only).
4. **Slice 3 — claim / unclaim.** Claim a slot → `remaining` drops; unclaim →
   restores. From a **second** member account, confirm you **cannot** delete the
   first member's claim (`DELETE /claims/:id` → 403). Oversubscription is allowed
   (benign), not an error. Check "My sign-ups".
5. **Slice 4 — slot builder.** In the plan app, open a saved event → **Volunteers
   & potluck** → add a Potluck/Volunteer slot. It appears in gather on that event
   once the event is published.

## Known caveat — email deliverability (pre-member-launch)

Firebase magic-link emails send from `…firebaseapp.com` with no `eastsidetribe.org`
DKIM, so they **land in spam**. Fine for testing (use Google sign-in). Before real
member launch, gather needs **domain-aligned sending** — Identity Platform custom
SMTP, or Admin-SDK-generated links via a provider — with SPF/DKIM on a **sending
subdomain** at Hover (safe/additive; never the apex Workspace MX/DKIM). Roadmap.
