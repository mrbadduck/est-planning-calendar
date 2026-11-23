# Deployment

The app deploys **standalone** to Netlify at `plan.eastsidetribe.org`; the
proxy runs as a Cloudflare Worker. Auth is **phased** — Phase 1 is read-only with
no user login, Phase 2 adds in-app Firebase Authentication (Google + email
magic-link) before writes go live. See `docs/architecture.md` for the *why*.

## Local development (hot reload, no build step)

The app is buildless — static files in `web/` (`index.html`, `styles.css`, and the
plain scripts listed in `docs/app-map.md`). To edit with live reload:

    npx -y live-server web --port=8080 --no-browser

Then open `http://localhost:8080`. Saving any file in `web/` auto-reloads the page.
`live-server` is fetched on demand by `npx` — nothing is added to the repo, no
`package.json`, no build. (A `.claude/launch.json` config is checked in so the
in-editor preview can start the same server.)

**Local runs on live data.** There is no mock — the app always uses
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

## Eventbrite sync (webhook + 15-minute sweep)

The Worker imports and refreshes events from Eventbrite into the planning table. It ships
**off**; turning it on is a deliberate step.

- **Secret `EB_WEBHOOK_SECRET`**: a long random string, the last segment of the webhook URL
  (`POST /webhooks/eventbrite/<secret>`; a wrong secret gets a 404). Set it with
  `cd proxy && npx wrangler secret put EB_WEBHOOK_SECRET`, and put the same value in
  `proxy/.dev.vars` for the script below.
- **Var `EB_SYNC_MODE`** (`proxy/wrangler.toml`): `off` (default) means the webhook and the sweep do
  nothing; `live` means they read Eventbrite and write Coda (imports and changes).
- **Cron**: `*/15 * * * *` runs the sweep, which catches anything a webhook missed. In `off` mode it is a no-op.
- **Webhook script**: `node scripts/eb-webhook.mjs` lists the org's webhooks and prints what it would
  create (GET only). `node scripts/eb-webhook.mjs --apply` registers
  `event.created,event.published,event.updated,event.unpublished` to the Worker URL; it refuses if
  `EB_WEBHOOK_SECRET` is missing or a webhook to the Worker already exists. Tokens come from
  `proxy/.dev.vars` and are never printed; the path secret is masked. **Run the dry run first.**
  The create route (`POST /v3/organizations/{org}/webhooks/`) is unconfirmed: if `--apply` gets a
  4xx, nothing was created (the script prints Eventbrite's `error_description`); the manual
  fallback is `POST /v3/webhooks/` with the same body.
- **Before going live**: the Coda select `Publish status` needs the option `Removed from Eventbrite`.
- **Known limit**: the sweep reads at most 1,200 planning rows. Past that, a run does no imports
  (rows past the cap would look unlinked and be duplicated); changes to the rows it read still flow
  in, and the console and one Publish Log record say why. Fix that before the backfill.

**Switch on:** merge (CI deploys with `EB_SYNC_MODE=off`), `wrangler secret put EB_WEBHOOK_SECRET`,
run the script with `--apply`, set `EB_SYNC_MODE = "live"` in `proxy/wrangler.toml` and deploy.
Then a **one-push smoke test**: push one event from plan, wait ~60 s, and check that its row's
`Last from Eventbrite` stays empty and the listing markers show "matches Eventbrite".
**Switch off in an emergency:** set `EB_SYNC_MODE = "off"` and redeploy. (Optionally delete the
webhook in Eventbrite too; the Worker ignores it while off.)

## Google Calendar sync (Worker, 15-minute sweep)

The Worker puts every approved, dated event on the *East Side Tribe Events* calendar and keeps
it current (decision 0010). It ships **off**.

**1. Service account** (EST-owned, not a personal login):
1. In Google Cloud (an EST-owned project), enable the Google Calendar API.
2. Create a service account (for example `est-planning-gcal`), then add a JSON key and download it.
3. In Google Calendar, open *East Side Tribe Events* > Settings and sharing > Share with specific
   people, add the service account's email, and give it **Make changes to events**.
4. From the same page, copy the **Calendar ID**.

**2. Secret and var:**
- `cd proxy && npx wrangler secret put GOOGLE_SA_KEY` (paste the whole JSON key).
- `GCAL_CALENDAR_ID` in `proxy/wrangler.toml` = the Calendar ID. Unset counts as `off`.

**3. `GCAL_MODE`** (`proxy/wrangler.toml`):
- `off` (default): nothing happens.
- `shadow`: the Worker works out each add, update and remove and records it in the Publish Log
  (Target `gCal`). It never calls Google Calendar.
- `live`: it calls Google Calendar.

**Cron:** `3,18,33,48 * * * *`, its own invocation, at most 15 changes per run. A row's error is
logged to the Publish Log once a day per action and status; the Worker console gets every one.

**Preconditions** (all before step 1 of the cutover):
- Phase A is live: `EB_SYNC_MODE=live`, and its import has caught up, so every upcoming EST
  Eventbrite event has a planning row. Check this; the link script and the Worker only know
  events that have a planning row.
- Publish Log options: add `gCal` to Target (it should already exist) and `gcal-insert`,
  `gcal-update`, `gcal-delete`, `gcal-shadow`, `gcal-sweep`, `gcal-sync` to Action. Optional: Coda stores an
  unknown select value as plain text.
- The service account and `GOOGLE_SA_KEY` are set up (above).

**Legacy events with no planning row.** OneTable potlucks, retreats and 50+ dinners made by the
gCal button or Freshen Up are on the calendar but not in plan. They stay as they are until Phase
C's backfill brings them into plan. Don't recreate them by hand in plan before then: that would
put a second copy on the calendar. The link script's dry run lists the upcoming ones as
"Frozen until Phase C".

**Cutover order** (plan Task 13):
1. Merge with `GCAL_MODE=off`.
2. **Link existing calendar events** so the Worker updates them rather than adding second ones.
   Run `node scripts/link-gcal-ids.mjs` (dry run, GET only), read the tables, then
   `node scripts/link-gcal-ids.mjs --apply`. For rows dated yesterday or later with a blank
   `gCal Event ID`, it copies the event id from `EST Events SRC` or the Events EVENTBRITE sync
   table (matched by Eventbrite id), or from the planning row's own `gCal Event` lookup, using
   only Events GCAL rows on the *East Side Tribe Events* calendar. It refuses `--apply` while two
   sources disagree. Unmatched rows are listed for Eric to link by hand, or the Worker inserts
   them. Token from `proxy/.dev.vars`, never printed. Coda applies writes ~28 s later.
3. `GCAL_MODE=shadow` for a week. Each day, compare the Publish Log `gCal` rows with what the
   Zap and the rule did. What to expect:
   - "Would update" for every linked row, every day: expected. Shadow never stores a hash, so it
     can't tell an unchanged event from a changed one. Its log is de-duplicated per day.
   - "Would add" for an event the Zap already put on the calendar (one published during the
     shadow week): the row needs re-linking (step 4 does it), not a sign of drift.
4. **In one sitting**, in this order:
   1. Turn off the Zapier Zap "New Event EB→GCal" and delete its Eventbrite webhook.
   2. Turn off the Coda rule "Daily Event Freshen Up".
   3. **Re-run the link script**: dry run, read it, then `--apply`. This links the events the Zap
      made during the shadow week.
   4. Wait ~30 s for Coda to apply the writes (re-run the dry run: 0 to link).
   5. Set `GCAL_MODE=live` and redeploy.
   6. Let one sweep run (`3,18,33,48` past the hour).
   7. Check: the Publish Log `gCal` rows for that run are updates, not adds, for linked events;
      no errors. Delete the 4 orphan calendar events from the audit by hand.
5. Next day: every approved upcoming event in plan has exactly one calendar event.

**Switch off in an emergency:** `GCAL_MODE = "off"` and redeploy.

## Write overlay (Durable Object, decision 0012)

The Worker remembers its own Coda writes until Coda applies them, and merges them into its
reads. It ships **off**; turning it on is a deliberate step.

- **Binding and migration** (`proxy/wrangler.toml`): `[[durable_objects.bindings]]`
  `name = "OVERLAY"`, `class_name = "WriteOverlay"` (exported from `src/worker.js`, defined in
  `src/overlay-do.js`), and `[[migrations]] tag = "v1"`, `new_sqlite_classes = ["WriteOverlay"]`.
  The first deploy with this creates the class; it makes no call to it while the switch is off.
- **Var `OVERLAY_MODE`**: `off` (default) means no Durable Object call: writes answer
  `overlaid: false`, reads are unchanged, `/mutation` asks Coda, and saves wait ~28 s as
  before. `live` turns the overlay on.
- **Migration tags and #40/#41.** Neither #40 (Eventbrite sync) nor #41 (Google Calendar)
  declares a `[[migrations]]` block (checked 2026-11-23), so `v1` is the Worker's first tag.
  Tags apply in order and an applied tag is never edited: whichever PR lands first, any later
  Durable Object change adds the next tag (`v2`, `v3`, …) after the ones already deployed,
  and a branch that also adds a tag renumbers on rebase.
- **Free-plan limits (verify before the flip, from Cloudflare's current pricing page):**
  SQLite-backed Durable Objects are on the Workers Free plan; about 100,000 Durable Object
  requests a day, 13,000 GB-s of duration a day, 5 GB of stored data, and daily caps on rows
  read and written (about 5 million and 100,000). EST's volume (one record call per write,
  one read call per read, an alarm every 5 s only while something is pending) is far below
  these. **Also verify** whether a Durable Object call counts toward the 50 subrequests an
  invocation allows; until then, count each as one (the sync-runner follow-up in
  `docs/roadmap.md` depends on the answer).

**Before the flip** (Eric, after merge):
1. `cd proxy && npx wrangler deploy --dry-run`: the bundle builds and the binding and
   migration are listed.
2. The read-only `/columns` check: every planning column the app or the Worker writes is a
   plain (non-calculated) column, and its relations point at People, Programs, Venues or
   Venue Types, the tables whose names the merge knows. **Done 2026-11-23** (read-only).
   Repeat it if columns change in Coda before the flip.
3. Set `OVERLAY_MODE = "live"` in `proxy/wrangler.toml` in a small PR; CI deploys it on merge.
4. Make one edit by hand in plan. The button says **Saving…** for about a second, not half a
   minute. Watch the Worker logs (`npx wrangler tail`): no `overlay:` lines (the overlay
   logs only problems), and `GET /mutation/<requestId>` answering `completed: true` within
   ~30 s. Check the Publish Log has no new error rows.
5. Once `live` has held for a while, the "after the flip" help PR: tighten
   `web/help/guide.md` (saves usually take a moment) and add the whats-new line (plan
   `2026-11-23-write-through-overlay.md`, Deferred).

**Switch off in an emergency:** set `OVERLAY_MODE = "off"` and redeploy. Nothing is lost:
every write went to Coda first; the overlay only held copies.

**Rollback (remove the class):** a plain revert can't remove a Durable Object class. First
set `OVERLAY_MODE = "off"` and deploy. Then, in one commit, remove the `[[durable_objects.bindings]]` block, the
`export { WriteOverlay } from './overlay-do.js';` line in `src/worker.js` (a deleted class
can't still be exported), and add a migration that deletes the class (this also deletes its
stored entries, which are copies), and deploy:

    [[migrations]]
    tag = "v2"
    deleted_classes = ["WriteOverlay"]

Keep the `v1` block above it. Use the next unused tag if `v2` is taken by then.

## Secrets checklist

- Superhuman Docs token: **Worker secret only** (`CODA_API_TOKEN`) — never committed,
  never in the app. Read-scoped in Phase 1; read+write in Phase 2.
- `ALLOWED_ORIGIN`: Worker var = `https://plan.eastsidetribe.org`.
- Phase 2: the Firebase web config and `FIREBASE_PROJECT_ID` (`est-planning-calendar`)
  ship in the app / Worker var (public); the **allowlist** and the read+write Coda
  token live in the Worker.
- `EB_WEBHOOK_SECRET`: Worker secret (see Eventbrite sync above).
- `GOOGLE_SA_KEY`: Worker secret, the calendar service account's JSON key (see Google Calendar sync above).
- `CLOUDFLARE_API_TOKEN`: GitHub repo secret (for CI proxy deploys only).
- The legacy optional `APP_KEY` shared-secret path is superseded by the phased model
  above and is not used for the standalone deploy.
