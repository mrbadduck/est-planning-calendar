# Netlify Monorepo Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans or subagent-driven-development to execute. Many tasks here are **manual** (Netlify UI + Hover DNS) — those are the operator's; the repo/code tasks are automatable. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Host both front-end apps on **Netlify** from the one repo — `web/` → `plan.eastsidetribe.org`, `gather/` (new empty scaffold) → `gather.eastsidetribe.org` — moving the plan app off GitHub Pages, with **DNS staying at Hover** and the Cloudflare Worker untouched.

**Architecture:** Two Netlify sites, one monorepo. Each site: base directory = its dir, **no build command**, publish dir = its dir (buildless static). Custom domains via external CNAME (no nameserver move). The plan app's **origin is unchanged** (`plan.eastsidetribe.org`), so the Worker CORS allowlist, Firebase authorized domains, and Firebase config all keep working with zero changes. The API stays the Cloudflare Worker, called cross-origin exactly as today.

**Tech Stack:** Netlify (static hosting, external-CNAME custom domains, Let's Encrypt), Hover DNS, existing Cloudflare Worker.

---

## Context an implementer needs

- Current hosting: `web/` → GitHub Pages at `plan.eastsidetribe.org`, via `.github/workflows/deploy-pages.yml` (triggers on push to `main`, path `web/**`). Custom-domain file: `web/CNAME` = `plan.eastsidetribe.org`. Hover DNS record today: `plan CNAME mrbadduck.github.io`.
- The Worker (`proxy/`) deploys via `.github/workflows/deploy-proxy.yml` — **leave entirely as-is.**
- CORS allowlist: `proxy/wrangler.toml` → `ALLOWED_ORIGIN` currently `https://plan.eastsidetribe.org,http://localhost:8080,...`. The plan origin is unchanged by this migration, so no CORS change is needed for `plan`. (The `gather` origin gets added later, in the gather build — not here.)
- Firebase authorized domains already include `plan.eastsidetribe.org` + `localhost` (from the Firebase Auth unify). Origin unchanged → no Firebase change for `plan`.
- **Hard DNS constraint:** only ever *add/edit* the `plan`/`gather` **subdomain** CNAMEs at Hover. Never touch the apex/`www` (Strikingly) or `MX`/DKIM (Google Workspace) records, and never move nameservers.
- The `/shared` code-sharing mechanism (hoisting `web/auth-firebase.js` etc. into a shared dir) is **NOT** in this migration — it's first needed by the gather app, so it lives in the gather build plan.

---

## File Structure

- **Delete** `web/CNAME` (GitHub Pages custom-domain marker; Netlify owns the domain now).
- **Delete** `.github/workflows/deploy-pages.yml` (stop GH Pages auto-deploy; avoid double-deploy).
- **Create** `gather/index.html` (placeholder so Site 2 has something to serve).
- **Create** `netlify.toml` (repo root) — declares both sites' base/publish + security headers, so config is version-controlled rather than UI-only.
- **Modify** `CLAUDE.md`, `docs/deployment.md` — GitHub Pages → Netlify (after verified).

---

## Task 1 (manual): Stand up Netlify Site 1 for the plan app

- [ ] **Step 1: Create the Netlify team + connect the repo**

In Netlify, create a team (free tier — cleaner than Vercel's Hobby tier for a nonprofit/org). **Add new site → Import from GitHub →** authorize and select `mrbadduck/est-planning-calendar`.

- [ ] **Step 2: Configure Site 1 as buildless static from `web/`**

Site settings → Build & deploy:
- **Base directory:** `web`
- **Build command:** *(empty)*
- **Publish directory:** `web`
- **Branch to deploy:** `main`

(If `netlify.toml` from Task 5 is already merged, these come from it; setting them in the UI is still fine and idempotent.)

- [ ] **Step 3: Verify on the `*.netlify.app` URL BEFORE touching DNS**

Open the auto-assigned `https://<site>.netlify.app`. Confirm the calendar renders. (Sign-in/writes will 401 here only if the origin isn't yet a Firebase authorized domain — that's expected on the temporary netlify.app origin; the real test is on `plan.eastsidetribe.org` in Task 3, whose origin is already authorized.)

**Verification:** Site builds/publishes with no build command; `<site>.netlify.app` serves the calendar.

---

## Task 2 (manual): Cut the `plan` domain over to Netlify at Hover

- [ ] **Step 1: Add the custom domain in Netlify**

Site 1 → Domain management → **Add a domain** → `plan.eastsidetribe.org`. Netlify shows a **CNAME target** like `<site>.netlify.app` and marks the domain "awaiting external DNS."

- [ ] **Step 2: Repoint the `plan` CNAME at Hover**

At Hover DNS for `eastsidetribe.org`: **edit the existing `plan` CNAME** from `mrbadduck.github.io` → the Netlify target from Step 1. This is an edit of one subdomain record — do **not** touch apex/`www`/`MX`/DKIM. (Since nothing is launched yet, the brief TLS gap during propagation is acceptable — no cutover ceremony needed.)

- [ ] **Step 3: Let Netlify provision the cert**

Once DNS resolves to Netlify, it auto-provisions the Let's Encrypt cert (Domain management shows the domain going green / "Netlify DNS not required, certificate provisioned"). Wait for HTTPS to be valid on `https://plan.eastsidetribe.org`.

**Verification:** `https://plan.eastsidetribe.org` loads over a valid cert and is served by Netlify (check the `server`/`x-nf-request-id` response headers, or Netlify's Deploys log shows the hit).

---

## Task 3 (verify): Confirm the plan app fully works on Netlify

- [ ] **Step 1: Load + read path**

Open `https://plan.eastsidetribe.org`. Confirm: no console errors, the calendar renders, and events load (a `GET /rows` to the Worker succeeds — the origin is unchanged, so CORS passes).

- [ ] **Step 2: Auth + write path (origin unchanged, so this should just work)**

Sign in with Google (and once via magic link). Confirm the avatar + role resolve (`GET /me` → your role) and a role-gated edit persists (`PUT /rows/:id` succeeds). Because the origin is identical to the GH Pages origin, the Firebase authorized domains and the Worker CORS allowlist need no changes.

**Verification:** Read, sign-in (both methods), and a role-gated write all succeed on the Netlify-served `plan.eastsidetribe.org`. If any fail, STOP and diagnose before Task 4 (do not retire GH Pages until this passes).

---

## Task 4 (repo): Retire GitHub Pages for the plan app

Only after Task 3 passes.

- [ ] **Step 1: Remove the GH Pages custom-domain marker + workflow**

```bash
git rm web/CNAME
git rm .github/workflows/deploy-pages.yml
```

- [ ] **Step 2: Turn off Pages in the repo settings (manual)**

GitHub repo → Settings → Pages → set Source to **None** (fully retires the Pages site so it can't reclaim the domain).

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "chore(deploy): retire GitHub Pages for plan app (moved to Netlify)"
```
Append: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`

- [ ] **Step 4: Confirm no double-deploy**

Push to `main` (via PR merge). Confirm only Netlify deploys `web/` now (no `deploy-pages` run appears; `deploy-proxy` still runs for `proxy/**` changes as before).

**Verification:** A subsequent `web/**` change deploys via Netlify only; GitHub Actions shows no Pages deploy.

---

## Task 5 (repo + manual): Stand up the empty `gather` site + config

- [ ] **Step 1: Add a `gather/` placeholder**

Create `gather/index.html`:

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>EST · gather</title>
</head>
<body>
  <main style="font-family: system-ui, sans-serif; max-width: 32rem; margin: 4rem auto; padding: 0 1rem;">
    <h1>gather</h1>
    <p>East Side Tribe member sign-ups — coming soon.</p>
  </main>
</body>
</html>
```

- [ ] **Step 2: Add a version-controlled `netlify.toml` (repo root)**

```toml
# Two static sites from one monorepo. Each Netlify site sets its own base/publish
# in the UI; this file version-controls headers (and documents the layout).
# No build command — both apps are buildless static.

[[headers]]
  for = "/*"
  [headers.values]
    X-Frame-Options = "DENY"
    X-Content-Type-Options = "nosniff"
    Referrer-Policy = "strict-origin-when-cross-origin"
```

(Netlify applies `netlify.toml` per site relative to that site's base directory, so the same header block covers both `web/` and `gather/`.)

- [ ] **Step 3: Create Netlify Site 2 for `gather/` (manual)**

Same repo → new site → **Base directory `gather`**, no build command, **Publish directory `gather`**, branch `main`. Verify `<site2>.netlify.app` shows the placeholder.

- [ ] **Step 4: Add the `gather` domain + Hover record (manual)**

Site 2 → Domain management → add `gather.eastsidetribe.org` → note the Netlify target. At Hover: **add** a new `gather CNAME → <site2>.netlify.app` record (a brand-new subdomain record — nothing existing is touched). Wait for the cert.

- [ ] **Step 5: Commit the repo bits**

```bash
git add gather/index.html netlify.toml
git commit -m "feat(gather): empty Netlify-served scaffold + repo netlify.toml"
```
Append the `Co-Authored-By` trailer.

**Verification:** `https://gather.eastsidetribe.org` serves the placeholder over a valid cert. (Worker CORS + Firebase authorized domains for the `gather` origin are added later, in the gather build — not needed for a static placeholder.)

---

## Task 6 (docs): Update hosting references

- [ ] **Step 1: GH Pages → Netlify in prose**

Run: `grep -rniE "github pages|gh pages|mrbadduck\.github\.io|web/CNAME|deploy-pages" CLAUDE.md docs/deployment.md`
For each hit, revise to describe **Netlify** hosting (two sites from the monorepo, external-CNAME custom domains, DNS still at Hover, Worker unchanged). Update the Repo-map/deploy table in `CLAUDE.md` (`web/index.html` "Deploys to" → Netlify; add the `gather/` row) and the deployment doc's hosting section. Keep the DNS-stays-at-Hover rationale intact.

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md docs/deployment.md
git commit -m "docs: hosting is Netlify (two sites, one repo) — plan off GitHub Pages"
```
Append the `Co-Authored-By` trailer.

---

## Self-review notes

- **No Worker / Firebase / CORS changes for `plan`** — the origin is identical, which is the whole reason this migration is low-risk. The only cross-origin config work (adding the `gather` origin to `ALLOWED_ORIGIN` + Firebase authorized domains) belongs to the gather build, when `gather` actually calls the Worker.
- **Ordering guards against a broken cutover:** verify on `*.netlify.app`, then on `plan.eastsidetribe.org`, and only THEN retire GH Pages (Task 4). Never delete `web/CNAME`/`deploy-pages.yml` before Task 3 passes.
- **`/shared` code-sharing is deliberately out of scope here** (first needed by gather).
