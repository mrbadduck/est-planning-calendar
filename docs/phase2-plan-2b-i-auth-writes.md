# Phase 2 · Plan 2b-i — auth + write spine

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`).

**Goal:** Let a signed-in leader edit planning events that actually persist to Coda, with server-verified identity, role gating (write = Program Lead ∪ Tribal Council; approve = Tribal Council), and person-relation attribution. Relation-field editing (program/leads/venue pickers) is **Plan 2b-ii**.

**Architecture:** Google Identity Services (ID-token) sign-in in the app → the Worker **verifies the Google JWT** (JWKS/RS256, `aud`/`iss`/`exp`/`email_verified`), matches the email to an `EST People SRC` row via `All Emails`, and derives role from `Leadership Status`. Writes are gated on that identity and the Worker **injects attribution** (Created/Edited/Approved by = the matched person; Approved at = now). The app sends only **scalar** cells in this plan (Title, Date, Start, End, All day, Venue (other), Status, Event Description, Planning Notes, scheduling); Program(s)/Leads/Venue relations are left untouched until 2b-ii.

**Security note:** the Worker is the trust boundary. Never trust client-supplied identity/attribution — the Worker derives both from the verified token. The app's `state.role` (hardcoded `'vp'`) is replaced by real identity from `/me`.

**Verification model:** `node --check`; `curl` for Worker shape; **end-to-end sign-in in the browser** at plan.eastsidetribe.org (JWT + role can only be exercised with a real Google token, so the main auth verification is Task 6).

**Branch:** `phase2b-i-auth-writes`.

---

### Task 1: [USER] Google OAuth client + Worker config/secrets

- [ ] **Step 1 [USER]: Create a Google OAuth Client ID.** Google Cloud Console → APIs & Services → Credentials → *Create OAuth client ID* → type **Web application**. Authorized JavaScript origins: `https://plan.eastsidetribe.org`. (No client secret is used for ID-token sign-in.) Copy the **Client ID** (looks like `…apps.googleusercontent.com`).
- [ ] **Step 2 [USER]: Create a read+WRITE, doc-scoped Coda token** (replacing the read-only one) and set it: `cd proxy && npx wrangler secret put CODA_API_TOKEN`.
- [ ] **Step 3: Set Worker vars** in `proxy/wrangler.toml`: `GOOGLE_CLIENT_ID = "<the client id>"` and `ALLOW_WRITES = "true"`. Commit.
- [ ] **Step 4 [USER]: `cd proxy && npm run deploy`** after Tasks 2/4 land (deploy once the Worker code is ready, not here).

---

### Task 2: Worker — JWT verification + identity resolution + `/me`

**Files:** Modify `proxy/src/worker.js`.

- [ ] **Step 1: Add the auth helpers** (near the bottom, by `readAllRows`). This is the security crux — implement exactly:

```javascript
// --- Google ID-token verification (RS256 via JWKS) ---
let _jwks = null, _jwksExp = 0;
async function googleKeys() {
  if (_jwks && Date.now() < _jwksExp) return _jwks;
  const r = await fetch('https://www.googleapis.com/oauth2/v3/certs');
  const j = await r.json();
  _jwks = {}; for (const k of j.keys) _jwks[k.kid] = k;
  _jwksExp = Date.now() + 3600_000;            // ~1h; keys rotate slowly
  return _jwks;
}
function b64url(s) {
  s = String(s).replace(/-/g, '+').replace(/_/g, '/');
  s += '='.repeat((4 - s.length % 4) % 4);
  const bin = atob(s), u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return u;
}
async function verifyGoogleIdToken(token, clientId) {
  const p = String(token || '').split('.');
  if (p.length !== 3) throw new Error('malformed token');
  const header = JSON.parse(new TextDecoder().decode(b64url(p[0])));
  const payload = JSON.parse(new TextDecoder().decode(b64url(p[1])));
  const jwk = (await googleKeys())[header.kid];
  if (!jwk) throw new Error('unknown signing key');
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64url(p[2]), new TextEncoder().encode(`${p[0]}.${p[1]}`));
  if (!ok) throw new Error('bad signature');
  if (payload.iss !== 'accounts.google.com' && payload.iss !== 'https://accounts.google.com') throw new Error('bad iss');
  if (payload.aud !== clientId) throw new Error('bad aud');
  if (!payload.exp || Date.now() / 1000 > payload.exp) throw new Error('expired');
  if (payload.email_verified !== true && payload.email_verified !== 'true') throw new Error('email unverified');
  return String(payload.email || '').toLowerCase();
}

// --- email -> EST People SRC person + role ---
const PEOPLE_TABLE = 'grid-X316Eql8dE';
const ALL_EMAILS_COL = 'c-6HV3jKCecV';
const WRITE_STATUSES = ['Program Lead', 'Tribal Council'];
const APPROVE_STATUSES = ['Tribal Council'];
async function resolvePerson(email, base, docId, auth) {
  const u = new URL(`${base}/docs/${docId}/tables/${PEOPLE_TABLE}/rows`);
  u.searchParams.set('useColumnNames', 'true');
  u.searchParams.set('valueFormat', 'simpleWithArrays');
  u.searchParams.set('query', `${ALL_EMAILS_COL}:"${email}"`);
  const r = await fetch(u.toString(), { headers: auth });
  if (!r.ok) return null;
  const row = ((await r.json()).items || [])[0];
  if (!row) return null;
  const st = row.values['Leadership Status'];
  const list = st == null || st === '' ? [] : (Array.isArray(st) ? st : [st]);
  return {
    personId: row.id,
    name: row.values['Full Name'] || email,
    canWrite: list.some(s => WRITE_STATUSES.includes(s)),
    canApprove: list.some(s => APPROVE_STATUSES.includes(s)),
  };
}
// Returns { identity } (403-worthy states carried as flags) or throws for a 401.
async function authIdentity(request, env, base, docId, auth) {
  const hdr = request.headers.get('Authorization') || '';
  const m = hdr.match(/^Bearer\s+(.+)$/i);
  if (!m) return null;                                   // no token
  const email = await verifyGoogleIdToken(m[1], env.GOOGLE_CLIENT_ID); // throws if invalid
  return await resolvePerson(email, base, docId, auth);  // null if no person match
}
```

- [ ] **Step 2: Add the `GET /me` route** (in the router, e.g. after the `ref` block). It reports who the caller is and what they can do — the app uses it to gate the UI.

```javascript
      if (parts[0] === 'me' && request.method === 'GET') {
        let id = null;
        try { id = await authIdentity(request, env, base, docId, auth); }
        catch (e) { return json({ error: 'invalid token' }, 401, cors); }
        if (!id) return json({ signedIn: false }, 200, cors);       // valid-but-unmatched or no token
        return json({ signedIn: true, name: id.name, canWrite: id.canWrite, canApprove: id.canApprove }, 200, cors);
      }
```

- [ ] **Step 3: Widen CORS to accept the auth header.** In `corsHeaders`, add `Authorization` to `Access-Control-Allow-Headers` (currently `Content-Type, X-App-Key`).
- [ ] **Step 4: `node --check`** (copy to `.mjs`). Commit: `git commit -m "feat(proxy): Google JWT verify + /me identity/role"`.
- [ ] **Step 5 (empirical, during Task 6): confirm the `All Emails` query.** After deploy, verify `resolvePerson` returns a row for a known leader's email. **Fallback if Coda's `query` doesn't match a formula list column:** replace the query with `readAllRows` over `PEOPLE_TABLE` + `.find(row => (row.values['All Emails']||[]).map(x=>String(x).toLowerCase()).includes(email))` (1128 rows / ~6 pages — acceptable; cache per-isolate if needed).

---

### Task 3: App — Google sign-in + `/me` + UI gating (still no writes)

**Files:** Modify `web/index.html`.

- [ ] **Step 1: Load GIS + a sign-in control.** Add `<script src="https://accounts.google.com/gsi/client" async></script>` in `<head>`. Add a header auth slot (near `#addBtn`) showing a "Sign in with Google" button when signed out and the person's name + "Sign out" when signed in.
- [ ] **Step 2: Add an `auth` module.** `const GOOGLE_CLIENT_ID = '<same client id>';` (public). On load, `google.accounts.id.initialize({ client_id: GOOGLE_CLIENT_ID, callback: onCredential })`. `onCredential({credential})` stores the JWT (`state.idToken = credential`), then calls `fetchMe()`.
- [ ] **Step 2b: `PROXY_BASE`-relative auth fetches.** `fetchMe()` → `GET ${PROXY_BASE}/me` with `Authorization: Bearer ${state.idToken}` → set `state.identity = { name, canWrite, canApprove }` (or null). Re-render the auth slot + re-`applyView()` so gates update.
- [ ] **Step 3: Replace `state.role`.** Everywhere approve is gated on `state.role==='vp'`, gate on `state.identity?.canApprove`. Gate the editor's Save/create/delete on `state.identity?.canWrite`; when not signed in or not a writer, the editor is read-only with a "Sign in to edit" note. The calendar itself stays readable to everyone (reads are unauthenticated).
- [ ] **Step 4: Attach `Authorization` on writes.** In `CodaSource.create/update/remove`, add header `Authorization: Bearer ${state.idToken}`. (These still throw/short-circuit until Task 5 turns them on.)
- [ ] **Step 5: `node --check`.** Commit: `git commit -m "feat(app): Google sign-in + /me gating (replaces hardcoded role)"`.

---

### Task 4: Worker — write gating + attribution injection

**Files:** Modify `proxy/src/worker.js` (the `rows` POST/PUT/DELETE handlers).

- [ ] **Step 1: Gate + augment writes.** Before forwarding a POST/PUT/DELETE `/rows`, resolve identity and enforce:
  - resolve `id = await authIdentity(...)`; on throw → `401`; if `!id || !id.canWrite` → `403 { error:'not authorized' }`.
  - Parse the JSON body. Detect **approve**: any cell whose `column` is `Status` and `value` is `Approved`. If approving and `!id.canApprove` → `403 { error:'approval requires Tribal Council' }`.
  - **Inject attribution cells** (person relation value = the row id as a single-element array `[id.personId]`; time as ISO):
    - POST (create): add `Created by` and `Edited by` = `[id.personId]`.
    - PUT (update): add/replace `Edited by` = `[id.personId]`.
    - Approve (either): add `Approved by` = `[id.personId]`, `Approved at` = current ISO date.
  - Re-serialize and forward the augmented body to Coda (keep DELETE as-is — no body — but still gated).
- [ ] **Step 2:** keep the `ALLOW_WRITES` master switch (now `"true"`), so writes require **both** the flag and a `canWrite` identity.
- [ ] **Step 3: `node --check`.** Commit: `git commit -m "feat(proxy): gate writes on role + inject person attribution"`.
- [ ] **Step 4 (empirical, Task 6): confirm the relation write shape** — that Coda accepts `{column:'Created by', value:['i-…']}` for a single lookup (adjust to bare `'i-…'` if it wants a scalar).

---

### Task 5: App — scalar write cells + wire save/delete/approve

**Files:** Modify `web/index.html`.

- [ ] **Step 1: Rewrite the write cell builder for the new table (scalar subset only).** Replace the old `eventToCodaCells` column set with: `Title`, `Date` (YYYY-MM-DD or empty), `Start`/`End` (`HH:MM` text — Coda's time column accepts it), `All day`, `Venue (other)` (from `location`), `Status` (capitalized), `Event Description` (from `description`), `Planning Notes`, `Scheduling` (capitalized), `Window start`, `Window end`. For `Scheduling='Month'`, write `Date` = `${targetMonth}-01` and no window. **Do NOT send** `Program(s)`/`Leads`/`Venue` relations or any attribution (Worker injects attribution; relations are 2b-ii).
- [ ] **Step 2: Turn on `CodaSource.create/update/remove`** to actually call the proxy with the Bearer header (remove the read-only `alert/throw`). After a successful write, call `refresh()` so the change (and Worker-injected attribution) appears.
- [ ] **Step 3:** the editor shows Program/Leads/Venue as **read-only current values** in this plan (a "pickers coming in the next step" note), since we don't write them yet.
- [ ] **Step 4: `node --check`.** Commit: `git commit -m "feat(app): persist scalar edits + status/approve via authed writes"`.

---

### Task 6: Ship + end-to-end verification

- [ ] **Step 1: [USER] redeploy the Worker** (`cd proxy && npm run deploy`) with the read+write token, `GOOGLE_CLIENT_ID`, `ALLOW_WRITES=true`.
- [ ] **Step 2: Land the app on main** → Pages deploys.
- [ ] **Step 3: Browser end-to-end** at plan.eastsidetribe.org:
  - Signed out → calendar reads fine; editor is read-only; no "Sign in" errors.
  - **Sign in as a Tribal Council member** (you) → `/me` returns `canWrite/canApprove: true`; edit a seed event's Status Idea→Confirmed and Save → it persists (verify via MCP that `Edited by` = your person row); move one to **Approved** → persists with `Approved by`/`Approved at`.
  - Confirm the `All Emails` query matched (Task 2 Step 5) and the relation write shape (Task 4 Step 4); apply the noted fallbacks if not.
  - (If possible) a **Program-Lead-not-Council** account → can edit, approve blocked (403 surfaced gracefully); a **non-leader** → `/me` `signedIn:true` but `canWrite:false`, editor read-only.
- [ ] **Step 4: Update docs** — tick 2b-i in `docs/phase2-planning-table.md` + `CLAUDE.md`; note remaining 2b-ii.

---

## Self-review

**Spec coverage:** Google sign-in + JWT verify → Task 2/3; email→person via `All Emails` + role from `Leadership Status` → Task 2; UI gating (write/approve) → Task 3; write gating + attribution injection → Task 4; scalar persistence + approve → Task 5; enable writes (`ALLOW_WRITES` + read+write token) → Task 1/6. Deferred to **2b-ii** (correct): relation editing (program/leads/venue pickers), program-palette from `/ref/programs`, crossover color, full create-with-relations.

**Placeholders:** two items are intentionally settled empirically in Task 6 (Coda `query` on a formula list column; single-lookup write value shape) — each has a concrete fallback written inline, not a TODO.

**Type/consistency:** `authIdentity` is reused by `/me` and the write gate; attribution uses `personId` (row id) consistently; the app sends only columns that exist on the retyped table; `state.identity.canApprove` replaces `state.role==='vp'` everywhere.

**Security check:** identity + attribution derive only from the Worker-verified token; `aud`/`iss`/`exp`/`email_verified` all checked; approve double-gated (canApprove) on the server, not just hidden in the UI.
