# Firebase Auth Unify Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the planning app off direct Google Sign-In and onto **Firebase Authentication** (magic-link + Google), so both this app and the coming `gather` app share one identity provider and the shared Worker verifies exactly one token type.

**Architecture:** Firebase ID tokens are RS256 JWTs signed by Google's `securetoken` service — the same verification shape the Worker already uses for Google Sign-In, with a different issuer (`https://securetoken.google.com/<project>`), audience (`<project>`), and JWKS endpoint. We extract token verification into `proxy/src/auth.js` (pure claim-check unit-tested; signature verify wraps it), repoint `authIdentity`, and replace the browser's Google Identity Services (GIS) glue with a small Firebase ES module (`web/auth-firebase.js`) exposing `window.estAuth`. `resolvePerson` / role gating / attribution are unchanged. Hard cutover (no dual-verify) — nothing is launched and sessions are ephemeral.

**Tech Stack:** Cloudflare Worker (ES modules, WebCrypto), `node --test` (pure-module unit tests), buildless vanilla JS front-end, Firebase JS SDK v10 (modular, loaded from `gstatic` CDN — no bundler).

---

## Context an implementer needs

- **Current Worker verify** lives in `proxy/src/worker.js`:
  - `verifyGoogleIdToken(token, clientId)` (lines ~543-558) — checks `iss ∈ {accounts.google.com, https://accounts.google.com}`, `aud === clientId`, `exp`, `email_verified`, returns lowercased email. Keys via `googleKeys()` (line ~528) from `https://www.googleapis.com/oauth2/v3/certs`. `b64url()` helper at ~536.
  - `authIdentity(request, env, base, docId, auth)` (~594) pulls the Bearer token, calls `verifyGoogleIdToken`, then `resolvePerson(email, …)` (~576) which matches `All Emails` in `EST People SRC` and returns `{ personId, name, canWrite, canApprove }`. **Do not change `resolvePerson`.**
  - `/me` route at ~161 returns `{ signedIn, matched, name, canWrite, canApprove }`.
- **Current app auth** lives in `web/app.js` (~1473-1583): `GOOGLE_CLIENT_ID`, `saveToken`/`loadToken` (sessionStorage), `jwtClaims`, `renderAuth`, `fetchMe` (calls `/me` with the Bearer token), `onCredential` (GIS callback), `signOut`, `tokenExpMs`/`checkAuthFreshness`/`sessionExpired` (GIS re-prompt on expiry), `initAuth`/`gisReady` (GIS init). `index.html:11` loads GIS: `<script src="https://accounts.google.com/gsi/client" async></script>`, and `index.html:83` loads the app: `<script src="app.js"></script>` (classic script, runs before deferred modules).
- **State fields** used: `state.idToken`, `state.identity` (`{ signedIn, matched, name, canWrite, canApprove }`), `state.authPending`. `PROXY_BASE` is the Worker origin.
- **Repo test conventions:** Worker logic → `node --test` on **pure** exported functions (see `proxy/test/eventbrite.test.js`). Browser JS has no unit harness — verify with `node --check web/app.js` plus the Browser-pane preview (`plan` dev server via `npx -y live-server web --port=8080`). ESM module files can't be `node --check`ed cleanly without `.mjs`; verify `web/auth-firebase.js` in the browser (console shows no import/syntax errors) instead.

---

## File Structure

- **Create** `proxy/src/auth.js` — Firebase ID-token verification. Exports `firebaseClaims(payload, projectId, nowSec)` (pure) + `verifyFirebaseIdToken(token, projectId, now?)` (JWKS fetch + WebCrypto) + `b64url(s)`.
- **Create** `proxy/test/auth.test.js` — unit tests for `firebaseClaims`.
- **Modify** `proxy/src/worker.js` — import from `./auth.js`; repoint `authIdentity` to Firebase; delete `verifyGoogleIdToken`/`googleKeys`/`b64url` (moved). Update `/me` doc comment.
- **Modify** `proxy/wrangler.toml` + `proxy/.dev.vars.example` — add `FIREBASE_PROJECT_ID`.
- **Create** `web/auth-firebase.js` — ES module; initializes Firebase, exposes `window.estAuth` (`init`, `signInWithGoogle`, `sendEmailLink`, `completeEmailLinkIfPresent`, `signOut`).
- **Modify** `web/index.html` — drop the GIS `<script>`; add `<script type="module" src="auth-firebase.js"></script>`.
- **Modify** `web/app.js` — replace GIS glue with `window.estAuth` calls; simplify token-freshness (Firebase auto-refreshes).
- **Modify** `CLAUDE.md`, `docs/architecture.md`, `docs/deployment.md` — "Google Sign-In" → "Firebase Auth (Google + magic-link)".

---

## Task 0: Prerequisites — Firebase console setup (manual, one-time)

**No code.** The human operator does this in the Firebase/Google Cloud console and collects values later tasks paste in. All collected values are **public** (safe to commit) except none-are-secret here (Firebase web config is public by design).

- [ ] **Step 1: Create/link the Firebase project**

In the [Firebase console](https://console.firebase.google.com/), click **Add project** and select the **existing Google Cloud project** that owns the OAuth client `463482291986-…` (so Google sign-in reuses the same project). Complete the wizard (Analytics optional/off).

- [ ] **Step 2: Register a Web app**

Project → **Add app → Web (`</>`)**, nickname "EST Planning + gather". **Do not** enable Firebase Hosting. Copy the `firebaseConfig` object it shows — you need `apiKey`, `authDomain`, `projectId`, `appId` (and `messagingSenderId`, `storageBucket` if shown). Record the **`projectId`** separately — the Worker needs it.

- [ ] **Step 3: Enable sign-in providers**

Build → **Authentication → Get started**. Under **Sign-in method**, enable:
- **Google** (pick a support email).
- **Email/Password** → within it toggle **Email link (passwordless sign-in)** ON.

- [ ] **Step 4: Authorized domains**

Authentication → **Settings → Authorized domains**. Ensure present: `localhost`, `plan.eastsidetribe.org`. (Add `gather.eastsidetribe.org` later when that app lands. Firebase adds `<project>.firebaseapp.com` automatically.)

- [ ] **Step 5: Record values for later steps**

Write these where the implementer can paste them:
- `FIREBASE_PROJECT_ID` = the `projectId` (e.g. `est-…`).
- The full `firebaseConfig` (apiKey/authDomain/projectId/appId/…).

**Verification:** In Authentication → Sign-in method, both **Google** and **Email link** show *Enabled*. Authorized domains include `localhost` + `plan.eastsidetribe.org`.

---

## Task 1: Worker — Firebase token verification module (TDD)

**Files:**
- Create: `proxy/src/auth.js`
- Test: `proxy/test/auth.test.js`

- [ ] **Step 1: Write the failing test**

Create `proxy/test/auth.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { firebaseClaims } from '../src/auth.js';

const PROJ = 'est-demo';
const NOW = 1_760_000_000;                 // fixed "now" in seconds
const good = () => ({
  iss: `https://securetoken.google.com/${PROJ}`,
  aud: PROJ,
  sub: 'uid123',
  exp: NOW + 3600,
  email: 'Leah@example.org',
  email_verified: true,
});

test('firebaseClaims returns the lowercased email for a valid token', () => {
  assert.equal(firebaseClaims(good(), PROJ, NOW), 'leah@example.org');
});
test('firebaseClaims rejects a wrong issuer', () => {
  assert.throws(() => firebaseClaims({ ...good(), iss: 'https://securetoken.google.com/other' }, PROJ, NOW), /bad iss/);
});
test('firebaseClaims rejects a wrong audience', () => {
  assert.throws(() => firebaseClaims({ ...good(), aud: 'other' }, PROJ, NOW), /bad aud/);
});
test('firebaseClaims rejects an expired token', () => {
  assert.throws(() => firebaseClaims({ ...good(), exp: NOW - 1 }, PROJ, NOW), /expired/);
});
test('firebaseClaims rejects a missing subject', () => {
  assert.throws(() => firebaseClaims({ ...good(), sub: '' }, PROJ, NOW), /no subject/);
});
test('firebaseClaims rejects an unverified email', () => {
  assert.throws(() => firebaseClaims({ ...good(), email_verified: false }, PROJ, NOW), /unverified/);
});
test('firebaseClaims rejects a missing email', () => {
  assert.throws(() => firebaseClaims({ ...good(), email: '' }, PROJ, NOW), /no email/);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd proxy && node --test test/auth.test.js`
Expected: FAIL — `Cannot find module '../src/auth.js'`.

- [ ] **Step 3: Write the minimal implementation**

Create `proxy/src/auth.js`:

```js
// Firebase ID-token verification (RS256 via the securetoken JWKS).
// Same shape as the old Google Sign-In verify, different iss/aud/keys.

export function b64url(s) {
  s = String(s).replace(/-/g, '+').replace(/_/g, '/');
  s += '='.repeat((4 - s.length % 4) % 4);
  const bin = atob(s), u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return u;
}

// Pure claim validation — throws on any bad claim, else returns lowercased email.
export function firebaseClaims(payload, projectId, nowSec) {
  if (payload.iss !== `https://securetoken.google.com/${projectId}`) throw new Error('bad iss');
  if (payload.aud !== projectId) throw new Error('bad aud');
  if (!payload.exp || nowSec > payload.exp) throw new Error('expired');
  if (!payload.sub) throw new Error('no subject');
  const email = String(payload.email || '').toLowerCase();
  if (!email) throw new Error('no email');
  if (payload.email_verified !== true && payload.email_verified !== 'true') throw new Error('email unverified');
  return email;
}

// Firebase publishes RS256 public keys in JWK form here (importable directly).
let _jwks = null, _jwksExp = 0;
async function firebaseKeys() {
  if (_jwks && Date.now() < _jwksExp) return _jwks;
  const r = await fetch('https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com');
  const j = await r.json();
  _jwks = {}; for (const k of j.keys) _jwks[k.kid] = k;
  _jwksExp = Date.now() + 3600_000;                  // ~1h; keys rotate slowly
  return _jwks;
}

// Verifies signature + claims. Returns the lowercased email or throws (-> 401).
export async function verifyFirebaseIdToken(token, projectId, now = Date.now()) {
  const p = String(token || '').split('.');
  if (p.length !== 3) throw new Error('malformed token');
  const header = JSON.parse(new TextDecoder().decode(b64url(p[0])));
  const payload = JSON.parse(new TextDecoder().decode(b64url(p[1])));
  const jwk = (await firebaseKeys())[header.kid];
  if (!jwk) throw new Error('unknown signing key');
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64url(p[2]), new TextEncoder().encode(`${p[0]}.${p[1]}`));
  if (!ok) throw new Error('bad signature');
  return firebaseClaims(payload, projectId, Math.floor(now / 1000));
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd proxy && node --test test/auth.test.js`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add proxy/src/auth.js proxy/test/auth.test.js
git commit -m "feat(proxy): Firebase ID-token verification module (auth.js) + unit tests"
```

---

## Task 2: Worker — repoint authIdentity + config, remove Google verify

**Files:**
- Modify: `proxy/src/worker.js`
- Modify: `proxy/wrangler.toml`
- Modify: `proxy/.dev.vars.example`

- [ ] **Step 1: Import the new module**

At the top of `proxy/src/worker.js`, after the existing imports (near the `import` for `ical.js`/`eventbrite.js`), add:

```js
import { verifyFirebaseIdToken } from './auth.js';
```

- [ ] **Step 2: Repoint `authIdentity` to Firebase**

In `proxy/src/worker.js`, replace this line inside `authIdentity` (~597):

```js
  const email = await verifyGoogleIdToken(m[1], env.GOOGLE_CLIENT_ID);
```

with:

```js
  const email = await verifyFirebaseIdToken(m[1], env.FIREBASE_PROJECT_ID);
```

- [ ] **Step 3: Delete the now-unused Google verify code**

In `proxy/src/worker.js`, delete the block `// --- Google ID-token verification (RS256 via JWKS) ---` through the end of `verifyGoogleIdToken` — i.e. remove `googleKeys()`, `b64url()`, and `verifyGoogleIdToken()` (~526-558). `b64url` now lives in `auth.js`; confirm nothing else in `worker.js` references `b64url`, `googleKeys`, or `verifyGoogleIdToken`:

Run: `cd proxy && grep -nE "b64url|googleKeys|verifyGoogleIdToken" src/worker.js`
Expected: no matches.

- [ ] **Step 4: Update the `/me` doc comment**

In `proxy/src/worker.js`, change the header comment line (~14) from:

```js
 *   GET    /me          verify Google token -> { signedIn, name, canWrite, canApprove }
```

to:

```js
 *   GET    /me          verify Firebase token -> { signedIn, name, canWrite, canApprove }
```

- [ ] **Step 5: Add `FIREBASE_PROJECT_ID` to config**

In `proxy/wrangler.toml`, under `[vars]`, add (replace `est-…` with the real projectId from Task 0):

```toml
FIREBASE_PROJECT_ID = "est-planning-calendar"   # Firebase project id; verified as the ID-token iss/aud
```

You may leave `GOOGLE_CLIENT_ID` in place (still referenced as the public OAuth client for Google-through-Firebase and harmless), or remove it if nothing references it — check:

Run: `cd proxy && grep -nE "GOOGLE_CLIENT_ID" src/worker.js`
Expected: no matches → then remove the `GOOGLE_CLIENT_ID` line from `wrangler.toml` and `.dev.vars.example` too.

In `proxy/.dev.vars.example`, add:

```
FIREBASE_PROJECT_ID=est-planning-calendar
```

- [ ] **Step 6: Verify the whole Worker test suite still passes**

Run: `cd proxy && node --test`
Expected: PASS — all existing tests (`eventbrite`, `ical`) plus `auth` green; no import errors.

- [ ] **Step 7: Commit**

```bash
git add proxy/src/worker.js proxy/wrangler.toml proxy/.dev.vars.example
git commit -m "feat(proxy): verify Firebase ID tokens in authIdentity; drop Google Sign-In verify"
```

---

## Task 3: Firebase browser module (`web/auth-firebase.js`)

**Files:**
- Create: `web/auth-firebase.js`
- Modify: `web/index.html`

- [ ] **Step 1: Create the Firebase auth module**

Create `web/auth-firebase.js` (paste the real `firebaseConfig` from Task 0). This is an ES module loaded via `<script type="module">`; it exposes a tiny global bridge so the classic `app.js` can call it:

```js
// Firebase auth for the EST apps. Buildless: modular SDK straight from the CDN.
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import {
  getAuth, onIdTokenChanged, signOut as fbSignOut,
  GoogleAuthProvider, signInWithPopup,
  sendSignInLinkToEmail, isSignInWithEmailLink, signInWithEmailLink,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';

// Public config (safe to commit) — from Firebase console (Task 0).
const firebaseConfig = {
  apiKey: 'REPLACE',                                   // from the Web-app registration (Task 0 Step 2)
  authDomain: 'est-planning-calendar.firebaseapp.com',
  projectId: 'est-planning-calendar',
  appId: 'REPLACE',                                    // from the Web-app registration (Task 0 Step 2)
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const EMAIL_KEY = 'est-emailForSignIn';

window.estAuth = {
  // app.js calls this once with callbacks; we stream ID tokens as they change.
  init({ onToken, onSignedOut }) {
    onIdTokenChanged(auth, async (user) => {
      if (user) onToken(await user.getIdToken());
      else onSignedOut();
    });
  },
  async signInWithGoogle() {
    await signInWithPopup(auth, new GoogleAuthProvider());
  },
  async sendEmailLink(email) {
    const url = window.location.origin + window.location.pathname;   // return here, no query
    await sendSignInLinkToEmail(auth, email, { url, handleCodeInApp: true });
    try { localStorage.setItem(EMAIL_KEY, email); } catch (_) {}
  },
  // Call on load: if the URL is a sign-in link, complete it. Returns true if it did.
  async completeEmailLinkIfPresent() {
    if (!isSignInWithEmailLink(auth, window.location.href)) return false;
    let email = '';
    try { email = localStorage.getItem(EMAIL_KEY) || ''; } catch (_) {}
    if (!email) email = window.prompt('Confirm your email to finish signing in') || '';
    if (!email) return false;
    await signInWithEmailLink(auth, email, window.location.href);
    try { localStorage.removeItem(EMAIL_KEY); } catch (_) {}
    // strip the sign-in params from the URL so a refresh doesn't re-trigger.
    history.replaceState(null, '', window.location.origin + window.location.pathname);
    return true;
  },
  async signOut() { await fbSignOut(auth); },
};

// Let app.js know the bridge is ready (it may have loaded first — classic script).
window.dispatchEvent(new Event('estauth:ready'));
```

- [ ] **Step 2: Swap the script tags in `index.html`**

In `web/index.html`, delete line 11:

```html
<script src="https://accounts.google.com/gsi/client" async></script>
```

and change the app script (line ~83) from:

```html
<script src="app.js"></script>
```

to:

```html
<script type="module" src="auth-firebase.js"></script>
<script src="app.js"></script>
```

- [ ] **Step 3: Verify the module loads in the browser**

Start the dev server (Browser pane): `preview_start` with a `launch.json` entry running `npx -y live-server web --port=8080 --no-browser` (port 8080), open `http://localhost:8080`.
Then check `read_console_messages` — expected: **no** import/syntax errors, and `window.estAuth` is defined (verify via `javascript_tool`: `typeof window.estAuth`　→ `"object"`). Sign-in won't work end-to-end until Task 4 wires `app.js`.

- [ ] **Step 4: Commit**

```bash
git add web/auth-firebase.js web/index.html
git commit -m "feat(web): Firebase auth browser module + load it before app.js"
```

---

## Task 4: Rewire `app.js` auth glue to `window.estAuth`

Replace GIS-specific code with `estAuth` calls. Firebase persists the session and auto-refreshes the ID token (streamed via `onIdTokenChanged`), so the manual sessionStorage persistence and GIS re-prompt/expiry code are removed.

**Files:**
- Modify: `web/app.js`

- [ ] **Step 1: Replace the sign-in constants/helpers block**

In `web/app.js`, replace lines ~1473-1481 (from the `/* ---- Google sign-in … */` banner through `loadToken`) with:

```js
/* ---- Firebase sign-in (identity + role gating via the Worker /me) -------- */
// Token lifecycle is owned by Firebase (auth-firebase.js). We keep the latest
// ID token in memory for the Authorization header; Firebase persists the session
// and streams refreshed tokens via estAuth.init's onToken callback.
function jwtClaims(t){ try{ return JSON.parse(atob(String(t).split('.')[1].replace(/-/g,'+').replace(/_/g,'/'))); }catch(_){ return {}; } }
```

(This deletes `GOOGLE_CLIENT_ID`, `TOKEN_KEY`, `saveToken`, `loadToken`; keeps `jwtClaims`. `initials`/`roleLabel` on the following lines stay.)

- [ ] **Step 2: Replace `renderAuth`'s signed-out branch with a Firebase sign-in control**

In `web/app.js` `renderAuth()`, replace the `else` branch (currently lines ~1504-1508 rendering `#gbtn` + `google.accounts.id.renderButton`) with:

```js
  } else {
    el.innerHTML = `<div class="acct">
        <button class="btn ghost" id="signInBtn">Sign in</button>
        <div class="acct-menu" id="signInMenu" role="menu" hidden>
          <button class="btn ghost" id="googleBtn" role="menuitem">Continue with Google</button>
          <div class="signin-or">or</div>
          <form id="emailLinkForm" class="signin-email">
            <input id="emailLinkInput" type="email" required placeholder="you@email.com" autocomplete="email">
            <button class="btn primary sm" type="submit">Email me a link</button>
          </form>
        </div>
      </div>`;
    el.querySelector('#signInBtn').addEventListener('click', e=>{ e.stopPropagation(); const m=el.querySelector('#signInMenu'); m.hidden=!m.hidden; });
    el.querySelector('#googleBtn').addEventListener('click', async ()=>{ try{ await window.estAuth.signInWithGoogle(); }catch(err){ toast('Google sign-in failed','err'); } });
    el.querySelector('#emailLinkForm').addEventListener('submit', async e=>{
      e.preventDefault();
      const email = el.querySelector('#emailLinkInput').value.trim();
      if(!email) return;
      try{ await window.estAuth.sendEmailLink(email); toast('Check your email for a sign-in link'); el.querySelector('#signInMenu').hidden=true; }
      catch(err){ toast('Could not send sign-in link','err'); }
    });
  }
```

- [ ] **Step 3: Replace `onCredential`/`signOut` with Firebase token handlers**

In `web/app.js`, replace `onCredential` and `signOut` (~1549-1550) with:

```js
// Called by estAuth whenever Firebase yields a (refreshed) ID token.
async function onFirebaseToken(token){ state.idToken = token || null; state.authPending = !!token; renderAuth(); await fetchMe(); }
function onFirebaseSignedOut(){ state.idToken=null; state.identity=null; state.authPending=false; renderAuth(); applyView(); }
async function signOut(){ try{ await window.estAuth.signOut(); }catch(_){} }   // onFirebaseSignedOut clears state
```

- [ ] **Step 4: Fix `fetchMe`'s 401 branch (it referenced the now-deleted `saveToken`)**

In `web/app.js` `fetchMe()` (~1544), replace:

```js
    else { state.identity = null; if(r.status===401){ state.idToken=null; saveToken(null); } } // stale/expired token -> drop it
```

with:

```js
    else { state.identity = null; if(r.status===401){ state.idToken=null; } } // token rejected -> drop it; Firebase re-yields on next refresh
```

- [ ] **Step 5: Delete the GIS token-freshness code**

In `web/app.js`, delete `tokenExpMs`, `sessionExpired`, `_reauthT`, and `checkAuthFreshness` (~1552-1572) — Firebase auto-refreshes, so none are needed. Then check where `checkAuthFreshness` was called and remove those calls:

Run: `grep -nE "checkAuthFreshness|sessionExpired|tokenExpMs" web/app.js`
Expected after deletion: **only** any call-sites remain. Remove each call-site line (they were invoked on tab-focus and the 60s poll). Re-run the grep; expected: no matches.

- [ ] **Step 6: Replace `initAuth`/`gisReady` with estAuth wiring**

In `web/app.js`, replace `initAuth` and `gisReady` (~1573-1583) with:

```js
function initAuth(){
  const start = () => {
    window.estAuth.init({ onToken: onFirebaseToken, onSignedOut: onFirebaseSignedOut });
    window.estAuth.completeEmailLinkIfPresent().catch(()=>{});   // finish a magic-link return, if any
  };
  if(window.estAuth) start();
  else window.addEventListener('estauth:ready', start, { once:true });   // module may load after app.js
}
```

- [ ] **Step 7: Syntax-check the app**

Run: `node --check web/app.js`
Expected: no output (exit 0). Fix any reference the deletions missed (e.g. a lingering `google.accounts` or `loadToken` call):

Run: `grep -nE "google\.accounts|loadToken|saveToken|GOOGLE_CLIENT_ID|gisReady|onCredential" web/app.js`
Expected: no matches.

- [ ] **Step 8: Commit**

```bash
git add web/app.js
git commit -m "feat(web): rewire app auth to Firebase (Google + magic-link) via estAuth"
```

---

## Task 5: End-to-end verification (browser)

**No file changes** — prove both sign-in paths work against the real Worker + Coda. Requires the Worker deployed (or `wrangler dev`) with `FIREBASE_PROJECT_ID` set, and `http://localhost:8080` present in Firebase authorized domains (Task 0) and in the Worker CORS allowlist (already there).

- [ ] **Step 1: Serve the app**

`preview_start` the `plan` dev server (`npx -y live-server web --port=8080 --no-browser`); open `http://localhost:8080`.

- [ ] **Step 2: Google path**

Click **Sign in → Continue with Google**, complete the popup. Verify via `read_page`/`read_console_messages`: the avatar renders, and a `GET /me` request (`read_network_requests`) returns `{ signedIn:true, matched:true, canWrite:… }` for a lead account. Confirm the account menu shows the correct role label.

- [ ] **Step 3: Role-gated write still works**

As a lead, open an event and confirm edit/approve controls appear per role and a save persists (watch the `PUT /rows/:id` request succeed). This proves attribution (`resolvePerson` on the Firebase email) is intact.

- [ ] **Step 4: Magic-link path**

Sign out. Click **Sign in**, enter a lead's email, submit → expect the "check your email" toast and a Firebase email. Open the link (same browser) → the app returns, `completeEmailLinkIfPresent` runs, `/me` resolves the same identity. Confirm the URL's sign-in params are stripped after completion.

- [ ] **Step 5: Reload persistence**

Reload the page while signed in → the session restores (Firebase persistence) and the avatar reappears without re-authing.

- [ ] **Step 6: Capture proof**

`computer {action:"screenshot"}` of the signed-in state + the role menu; note the `/me` response body for the record. (No commit — verification only.)

---

## Task 6: Cleanup + docs

**Files:**
- Modify: `CLAUDE.md`, `docs/architecture.md`, `docs/deployment.md`

- [ ] **Step 1: Update prose references from Google Sign-In → Firebase**

Search and update the auth descriptions:

Run: `grep -rniE "google sign-in|google sign in|GIS|accounts\.google\.com/gsi|Google Identity" CLAUDE.md docs/`
For each hit, revise to describe **Firebase Authentication (Google + email magic-link), verified in the Worker as Firebase ID tokens; `resolvePerson`/role gate unchanged.** Key spots: `CLAUDE.md` (the auth bullets in "Non-negotiable decisions" #6 and the Plan 2b-i status line) and `docs/architecture.md` / `docs/deployment.md` auth sections. Keep it factual and short; don't rewrite unrelated content.

- [ ] **Step 2: Note the local-dev auth origin change**

In `docs/deployment.md` (Local development), replace the note about adding `localhost:8080` to the **Google OAuth client** authorized origins with: add `localhost` to the **Firebase authorized domains** (Authentication → Settings). Keep the CORS-allowlist note as-is.

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md docs/architecture.md docs/deployment.md
git commit -m "docs: describe Firebase Auth (Google + magic-link) replacing direct Google Sign-In"
```

---

## Self-review notes

- **Spec coverage:** This plan implements the §9 "Firebase Auth unify" prereq of the gather design (`docs/superpowers/specs/2026-08-24-gather-member-app-design.md`) — provider swap on both Worker verify and the plan app, `resolvePerson`/roles unchanged, magic-link + Google, Google-sent email (no Resend). The gather **member routes** and **find-or-create People** are intentionally NOT here — they belong to the gather build plan (this prereq only unifies the *existing* app so the Worker verifies one token type).
- **Cutover:** hard swap (no dual Google+Firebase verify) is deliberate — nothing launched, sessions ephemeral; a signed-in lead simply re-signs-in after deploy. Deploy the Worker (`FIREBASE_PROJECT_ID` set) and the web change together.
- **Type consistency:** `firebaseClaims(payload, projectId, nowSec)` and `verifyFirebaseIdToken(token, projectId, now)` signatures match across `auth.js`, its test, and the `worker.js` call site. `state.identity` shape (`{signedIn,matched,name,canWrite,canApprove}`) and the `/me` response are unchanged, so all downstream `canWrite`/`canApprove` consumers in `app.js` keep working.
- **Deferred to the Netlify migration:** hoisting `web/auth-firebase.js` into the shared `/shared` dir so `gather` reuses it — left in `web/` here; the Netlify spec relocates it.
```
