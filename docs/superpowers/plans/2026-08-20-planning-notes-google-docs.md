# Planning Notes as per-row Google Docs — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Planning Notes a per-event Google Doc — created from the app via a Coda row button pushed through the proxy, embedded read-only in the editor, and edited in Google Docs.

**Architecture:** The app reads a normalized `notesDocUrl` and renders a `/preview` iframe + "Edit in Google Docs" link. Because the app's read layer keys Coda values by column **name** (`useColumnNames=true`) and the notes column gets renamed, the proxy anchors this one field to its **stable column id** (`c-gCr2zZXbdZ`) — resolving the current name server-side and exposing `notesDocUrl` on each row. To create a doc, the app calls a new role-gated proxy route `POST /notes-doc` that pushes the row's button by its **id** (`c-Xa89eEgVN5`) via the Coda API (the button runs the Google Drive pack's Copy file + writes the URL back). The app then fast-polls until the URL lands. Both Coda touchpoints are id-based, so column/button renames don't break anything.

**Tech Stack:** Buildless vanilla JS (`web/app.js` + `web/styles.css`), Cloudflare Worker proxy (`proxy/src/worker.js`), Coda API.

**Testing approach:** This repo has **no unit-test harness** and is deliberately buildless. Verification per task = `node --check` on edited JS (per CLAUDE.md), plus targeted browser checks via the preview tools and `curl` for the proxy route. Do **not** add a test framework.

**Coda side — already done by the user (2026-08-20):** on `EST Planning Events SRC` (`grid--gYIvdD-cE`, doc `DYAz_wCVfv`).
- **Notes Doc** column, id **`c-gCr2zZXbdZ`** (a `link` column).
- **Create Notes Doc** button column, id **`c-Xa89eEgVN5`** — runs the official Google Drive pack **Copy file** (template → shared folder `1fZXRHWwKMD0FJFLWLUrw7r7kIWG_5sds`) and writes the new URL into `Notes Doc`; disabled once `Notes Doc` is set (`_BUTTON_PROPERTIES(disabled: [Notes Doc].IsNotBlank())`).

> **Names churn, ids don't.** The column was renamed `Notes doc` → `Notes Doc` mid-design; the ids above stayed constant. That's why both the read (via `CODA_NOTES_COL_ID`) and the button push (via `CODA_NOTES_BUTTON_ID`) key on **ids**, never names.

**Runtime verification gate (Task 6):** confirm that pushing the button via the Coda API actually creates the doc **and writes the URL back** into `Notes Doc` (the write-back action isn't visible in the column schema, only the disabled-guard is).

---

## Task 1: Read the Notes-doc URL by stable column id (proxy) + consume it in the app

The spike reads `v['Notes Doc']` by name, which broke on rename. Anchor this field to its stable id `c-gCr2zZXbdZ` at the proxy seam: resolve the column's current name from its id (cached), then expose `notesDocUrl` on each `/rows` item. (Migrating the app's other ~20 name-keyed fields to ids is out of scope.)

**Files:**
- Modify: `proxy/wrangler.toml` (add `CODA_NOTES_COL_ID`)
- Modify: `proxy/src/worker.js` (cached column-name resolver + inject `notesDocUrl`)
- Modify: `web/app.js` (`planningRowToEvent` reads `r.notesDocUrl`)

- [ ] **Step 1: Add the notes-column id as a var**

In `proxy/wrangler.toml`, under `[vars]` (after `CODA_TABLE_ID`), add:

```toml
CODA_NOTES_COL_ID = "c-gCr2zZXbdZ"     # "Notes Doc" column — resolved by id so a rename can't break the read
```

- [ ] **Step 2: Add a cached column-name resolver**

In `proxy/src/worker.js`, near the other module-level helpers (e.g. just after the `REF_CACHE` declaration), add:

```js
// Resolve a column's CURRENT name from its stable id (cached per isolate) so the
// app can read a value by id even after the column is renamed in Coda.
const _colNameCache = new Map();   // colId -> { name, exp }
async function columnName(base, docId, tableId, colId, auth){
  const hit = _colNameCache.get(colId);
  if (hit && hit.exp > Date.now()) return hit.name;
  const r = await fetch(`${base}/docs/${docId}/tables/${tableId}/columns/${encodeURIComponent(colId)}`, { headers: auth });
  if (!r.ok) return null;
  const j = await r.json();
  const name = (j && j.name) || null;
  if (name) _colNameCache.set(colId, { name, exp: Date.now() + 5 * 60 * 1000 });
  return name;
}
```

- [ ] **Step 3: Inject `notesDocUrl` on each row in the `/rows` GET handler**

In `proxy/src/worker.js`, replace:

```js
        if (request.method === 'GET' && !rowId) {
          const out = await readAllRows(rowsUrl, auth);
          return out.ok ? json({ items: out.items }, 200, cors) : pass(out.resp, cors);
        }
```

with:

```js
        if (request.method === 'GET' && !rowId) {
          const out = await readAllRows(rowsUrl, auth);
          if (!out.ok) return pass(out.resp, cors);
          // Anchor the notes URL to its stable column id, not its (renameable) name.
          const nm = env.CODA_NOTES_COL_ID ? await columnName(base, docId, tableId, env.CODA_NOTES_COL_ID, auth) : null;
          if (nm) for (const it of out.items) { it.notesDocUrl = (it.values || {})[nm]; }
          return json({ items: out.items }, 200, cors);
        }
```

- [ ] **Step 4: Sanity-check the worker**

Run: `node --check proxy/src/worker.js`
Expected: no output (exit 0).

- [ ] **Step 5: Read `r.notesDocUrl` in the app (id-anchored, link-type safe)**

In `web/app.js`, in `planningRowToEvent`, replace the spike line:

```js
    notesDocUrl: v['Notes Doc'] || '',                   // Google Doc for internal notes (Coda-provisioned)
```

with:

```js
    // proxy injects notesDocUrl resolved by the stable column id (rename-proof);
    // Notes Doc is a Coda link column, so the value may be a string or {url,name}.
    notesDocUrl: (typeof r.notesDocUrl === 'string' ? r.notesDocUrl : (r.notesDocUrl && (r.notesDocUrl.url || r.notesDocUrl.name))) || '',
```

- [ ] **Step 6: Sanity-check the JS**

Run: `node --check web/app.js`
Expected: no output (exit 0).

- [ ] **Step 7: Commit**

```bash
git add proxy/src/worker.js proxy/wrangler.toml web/app.js
git commit -m "feat: expose Notes Doc URL by stable column id via the proxy"
```

> **Note:** functional verification needs the proxy deployed (the app hits the live Worker). After deploy (Task 6, Step 1), confirm every `/rows` item carries a `notesDocUrl` key:
> ```bash
> curl -s https://est-planning-proxy.eastsidetribe.workers.dev/rows | python3 -c "import sys,json; d=json.load(sys.stdin); print('present on all:', all('notesDocUrl' in it for it in d['items']))"
> ```
> Expected: `present on all: True`.

---

## Task 2: Proxy route — `POST /notes-doc` pushes the notes-doc button

**Files:**
- Modify: `proxy/wrangler.toml` (add `CODA_NOTES_BUTTON_ID` var)
- Modify: `proxy/src/worker.js` (add the route + doc comment)

- [ ] **Step 1: Add the button-column id as a var**

In `proxy/wrangler.toml`, under `[vars]` (after the `CODA_TABLE_ID` line), add:

```toml
CODA_NOTES_BUTTON_ID = "c-Xa89eEgVN5"   # notes-doc button ("Create Notes Doc") on EST Planning Events SRC — runs Copy file + writes the URL into the Notes Doc column
```

- [ ] **Step 2: Document the route in the header comment**

In `proxy/src/worker.js`, in the top route-list comment block, add after the `/me` line:

```js
 *   POST   /notes-doc   push the row's notes-doc button by id (body: { rowId }) — role-gated
```

- [ ] **Step 3: Add the route**

In `proxy/src/worker.js`, immediately **after** the `if (parts[0] === 'me' && request.method === 'GET') { ... }` block and **before** `return json({ error: 'not found' }, 404, cors);`, insert:

```js
      if (parts[0] === 'notes-doc' && request.method === 'POST') {
        // Provision a Planning-Notes Google Doc by pushing the row's notes-doc
        // button (by id) via the Coda API. Same write gate as row writes; reuses
        // the doc-scoped token (no new secret). The button itself runs the Google
        // Drive pack's Copy file and writes the URL back into the Notes Doc column.
        if (env.ALLOW_WRITES !== 'true') return json({ error: 'writes disabled' }, 403, cors);
        const buttonId = env.CODA_NOTES_BUTTON_ID;
        if (!buttonId) return json({ error: 'proxy not configured (CODA_NOTES_BUTTON_ID)' }, 500, cors);
        let id;
        try { id = await authIdentity(request, env, base, docId, auth); }
        catch (e) { return json({ error: 'invalid token' }, 401, cors); }
        if (!id || !id.canWrite) return json({ error: 'not authorized' }, 403, cors);
        let body;
        try { body = JSON.parse((await request.text()) || '{}'); }
        catch (e) { return json({ error: 'bad body' }, 400, cors); }
        const rowId = body.rowId;
        if (!rowId) return json({ error: 'rowId required' }, 400, cors);
        const btnUrl = `${base}/docs/${docId}/tables/${tableId}/rows/${encodeURIComponent(rowId)}/buttons/${encodeURIComponent(buttonId)}`;
        return pass(await fetch(btnUrl, { method: 'POST', headers: auth }), cors);
      }
```

- [ ] **Step 4: Sanity-check the worker**

Run: `node --check proxy/src/worker.js`
Expected: no output (exit 0).

- [ ] **Step 5: Verify the gate rejects an unauthenticated push**

Against the deployed Worker (or `npx wrangler dev` in `proxy/`), run:

```bash
curl -s -o /dev/null -w "%{http_code}\n" -X POST \
  -H "Origin: http://localhost:8080" -H "Content-Type: application/json" \
  --data '{"rowId":"i-fake"}' \
  https://est-planning-proxy.eastsidetribe.workers.dev/notes-doc
```

Expected: `401` (no Google token → `authIdentity` throws → invalid token). This proves the route exists and is gated. (A real authed push is exercised end-to-end in Task 6.)

- [ ] **Step 6: Commit**

```bash
git add proxy/src/worker.js proxy/wrangler.toml
git commit -m "feat(proxy): POST /notes-doc pushes the notes-doc button by id (role-gated)"
```

---

## Task 3: App data layer — `CodaSource.createNotesDoc(rowId)`

**Files:**
- Modify: `web/app.js` (the `CodaSource` object, near `create`/`update`/`remove`)

- [ ] **Step 1: Add the method**

In `web/app.js`, inside the `CodaSource` object, after the `remove(id)` method line, add:

```js
  async createNotesDoc(rowId){ const r=await fetch(`${this.base}/notes-doc`,{method:'POST',headers:this._wh(),body:JSON.stringify({rowId})}); if(!r.ok) await this._fail(r); return true; },
```

- [ ] **Step 2: Sanity-check the JS**

Run: `node --check web/app.js`
Expected: no output (exit 0).

- [ ] **Step 3: Commit**

```bash
git add web/app.js
git commit -m "feat(editor): CodaSource.createNotesDoc — call the proxy button-push route"
```

---

## Task 4: App UI — real "Create notes doc" button, loading, fast-poll → embed

Replaces the spike's paste-a-URL empty state with a real create flow.

**Files:**
- Modify: `web/app.js` (`notesDocPanelHTML`, its call site, the `#f_ndoc` click handler; add `pollForNotesDoc` + `NDOC_CREATE_HTML`)
- Modify: `web/styles.css` (loading spinner; drop the unused paste-input rule)

- [ ] **Step 1: Rewrite the panel renderer to take `canEdit` and offer a Create button**

In `web/app.js`, replace the whole `notesDocPanelHTML` function (the spike version) with:

```js
const NDOC_CREATE_HTML = `<div class="ndoc-empty">
  <button type="button" class="btn sm primary" data-act="ndoc-create">Create notes doc</button>
  <span class="hint">Generates a Google Doc from the planning template.</span>
</div>`;
function notesDocPanelHTML(ev, canEdit){
  let inner;
  if(ev.notesDocUrl)          inner = notesDocEmbedHTML(ev.notesDocUrl);
  else if(canEdit && ev.id)   inner = NDOC_CREATE_HTML;
  else if(canEdit && !ev.id)  inner = `<div class="ndoc-empty"><span class="hint">Save the event first, then add a notes doc.</span></div>`;
  else                        inner = `<div class="ndoc-empty"><span class="hint">No notes doc yet.</span></div>`;
  return `<div class="fld full"><label>Notes doc <span class="hint">(Google Docs)</span></label>
    <div class="ndoc" id="f_ndoc">${inner}</div></div>`;
}
```

- [ ] **Step 2: Pass `canEdit` at the call site**

In `web/app.js`, in the editor `body.innerHTML` template, change:

```js
    ${notesDocPanelHTML(ev)}
```

to:

```js
    ${notesDocPanelHTML(ev, canEdit && !locked)}
```

- [ ] **Step 3: Replace the `#f_ndoc` click handler (create instead of paste-preview)**

In `web/app.js`, replace the spike handler block:

```js
  // notes doc: spike "paste a URL to preview" (empty state) → swap in the embed
  const ndoc=document.getElementById('f_ndoc');
  if(ndoc) ndoc.addEventListener('click', e=>{
    const b=e.target.closest('[data-act="ndoc-preview"]'); if(!b) return;
    const url=(document.getElementById('f_ndoc_url')||{}).value||'';
    if(!gdocPreviewUrl(url)){ toast('Not a Google Doc link','err'); return; }
    ndoc.innerHTML=notesDocEmbedHTML(url);
  });
```

with:

```js
  // notes doc: "Create notes doc" → push the Coda button via the proxy, then poll
  const ndoc=document.getElementById('f_ndoc');
  if(ndoc) ndoc.addEventListener('click', async e=>{
    const b=e.target.closest('[data-act="ndoc-create"]'); if(!b) return;
    if(!editing || !editing.id){ toast('Save the event first','err'); return; }
    ndoc.innerHTML=`<div class="ndoc-loading"><span class="ndoc-spin"></span> Setting up your notes doc…</div>`;
    try{ await DB.createNotesDoc(editing.id); }
    catch(err){ toast(err.message||'Could not start','err'); ndoc.innerHTML=NDOC_CREATE_HTML; return; }
    pollForNotesDoc(editing.id, 0);
  });
```

- [ ] **Step 4: Add the fast-poll function**

In `web/app.js`, add near `notesDocPanelHTML` (top-level function):

```js
// Poll the server rows (bypassing the _recent optimistic overlay via listPlanning)
// until the notes-doc button has written the URL into Notes Doc, then swap the
// panel to the embed. ~3s cadence, ~90s ceiling.
async function pollForNotesDoc(rowId, tries){
  const el = () => document.getElementById('f_ndoc');
  if(tries >= 30){
    const e=el(); if(e && (!editing || editing.id===rowId))
      e.innerHTML=`<div class="ndoc-warn">Still setting up — this can take a minute. Reopen the event to check.</div>`;
    return;
  }
  await new Promise(r=>setTimeout(r, 3000));
  let ev=null;
  try{ const rows=await DB.listPlanning(); ev=rows.find(x=>x.id===rowId); }catch(_){}
  if(ev && ev.notesDocUrl){
    if(editing && editing.id===rowId) editing.notesDocUrl=ev.notesDocUrl;
    const item=state.events.find(x=>x.id===rowId); if(item) item.notesDocUrl=ev.notesDocUrl;
    const e=el(); if(e && (!editing || editing.id===rowId)) e.innerHTML=notesDocEmbedHTML(ev.notesDocUrl);
    toast('Notes doc ready','ok');
    return;
  }
  pollForNotesDoc(rowId, tries+1);
}
```

- [ ] **Step 5: Swap the CSS — loading spinner in, paste-input rule out**

In `web/styles.css`, replace the spike rule:

```css
  .ndoc-empty input{border:1px solid var(--hair-strong);border-radius:8px;padding:7px 9px;font:inherit}
```

with:

```css
  .ndoc-loading{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--muted);padding:14px;border:1px solid var(--hair-strong);border-radius:8px}
  .ndoc-spin{width:14px;height:14px;border:2px solid var(--hair-strong);border-top-color:var(--accent);border-radius:50%;display:inline-block;animation:ndoc-spin .8s linear infinite}
  @keyframes ndoc-spin{to{transform:rotate(360deg)}}
```

- [ ] **Step 6: Sanity-check the JS**

Run: `node --check web/app.js`
Expected: no output (exit 0).

- [ ] **Step 7: Browser check — panel states render**

Ensure the dev server is up (`preview_start` name `web`, or reuse the running one at `http://localhost:8080`). In the preview browser: open a planning event, scroll to **Notes doc**. Confirm via `javascript_tool`:

```js
(() => {
  const p = document.getElementById('f_ndoc');
  return { present: !!p, html: p ? p.innerHTML.replace(/\s+/g,' ').slice(0,140) : null };
})();
```

Expected (not signed in): the `No notes doc yet.` hint. (Signed-in write-authorized users see the Create button — exercised in Task 6.) Also run `read_console_messages` (onlyErrors) — only the expected Google Sign-In errors, no ReferenceErrors.

- [ ] **Step 8: Commit**

```bash
git add web/app.js web/styles.css
git commit -m "feat(editor): Create notes doc button + loading + fast-poll to embed"
```

---

## Task 5: Retire the legacy Planning Notes textarea

Notes now live in the Google Doc. Stop editing/writing the old `Planning Notes` canvas column; show any existing text read-only.

**Files:**
- Modify: `web/app.js` (`eventToCodaCells`, the notes field in the editor body, `readForm`, remove `NOTES_TEMPLATE` seeding)
- Modify: `web/styles.css` (add `.legacynotes`)

- [ ] **Step 1: Stop writing the `Planning Notes` cell**

In `web/app.js`, in `eventToCodaCells`, delete this line:

```js
    {column:'Planning Notes',  value:e.planningNotes||''},
```

(Omitting the cell leaves existing values untouched; the Google Doc is the notes home now.)

- [ ] **Step 2: Make the legacy notes display read-only (only if present)**

In `web/app.js`, replace the editor body line:

```js
    <div class="fld full"><label>Planning notes <span class="hint">(internal, legacy text)</span></label><textarea id="f_notes" ${dis} placeholder="Internal planning checklist">${esc(ev.planningNotes || (!ev.id ? NOTES_TEMPLATE : ''))}</textarea></div>
```

with:

```js
    ${ev.planningNotes ? `<div class="fld full"><label>Planning notes <span class="hint">(legacy)</span></label><div class="legacynotes">${esc(ev.planningNotes)}</div></div>` : ''}
```

- [ ] **Step 3: Drop the now-dead `f_notes` read in `readForm`**

In `web/app.js`, in `readForm`, change:

```js
    description:g('f_desc').value.trim(), planningNotes:g('f_notes')?g('f_notes').value.trim():'',
```

to (preserve any legacy value from the open event; it's no longer written):

```js
    description:g('f_desc').value.trim(), planningNotes:(editing && editing.planningNotes)||'',
```

- [ ] **Step 4: Remove the now-unused NOTES_TEMPLATE constant**

In `web/app.js`, delete the `const NOTES_TEMPLATE = [ ... ].join('\n');` block near the top (the checklist template now lives in the template Google Doc). Confirm it is referenced nowhere else:

Run: `grep -n "NOTES_TEMPLATE" web/app.js`
Expected: no matches after deletion.

- [ ] **Step 5: Add legacy-notes styling**

In `web/styles.css`, after the `.ndoc-warn` rule, add:

```css
  .legacynotes{white-space:pre-wrap;font-size:12px;color:var(--muted);background:#F7F6F3;border:1px solid var(--hair);border-radius:6px;padding:8px 10px}
```

- [ ] **Step 6: Sanity-check the JS**

Run: `node --check web/app.js`
Expected: no output (exit 0).

- [ ] **Step 7: Browser check — no legacy textarea, legacy text shows read-only when present**

Reload the preview. Open an event **with** existing planning notes and confirm via `javascript_tool` that there is no `#f_notes` textarea and a `.legacynotes` block is shown:

```js
(() => ({ hasTextarea: !!document.getElementById('f_notes'), hasLegacy: !!document.querySelector('.legacynotes') }))();
```

Expected: `{ hasTextarea: false, hasLegacy: true }` for a row that has legacy notes.

- [ ] **Step 8: Commit**

```bash
git add web/app.js web/styles.css
git commit -m "refactor(editor): retire legacy Planning Notes textarea (Google Doc is the home)"
```

---

## Task 6: Deploy, end-to-end verification, and docs

**Files:**
- Modify: `CLAUDE.md` (status), `docs/superpowers/specs/2026-08-20-planning-notes-google-docs-design.md` (spikes #3/#4 done)
- Memory: update the project memory pointer

- [ ] **Step 1: Deploy the proxy**

The proxy deploys via the `.github/workflows` on push to `main` (see `docs/deployment.md`). Since this work is on a branch, deploy the Worker so the new route + var are live for end-to-end testing. Either merge to `main` (CI deploys) or, from `proxy/`, run:

```bash
npx wrangler deploy
```

Expected: deploy succeeds; `CODA_NOTES_BUTTON_ID` is picked up from `wrangler.toml` `[vars]`.

- [ ] **Step 2: End-to-end — create a notes doc from the app (the runtime gate)**

In a browser signed in as a **write-authorized** leader (Program Lead / Tribal Council):
1. Open a saved planning event with **no** notes doc → the **Create notes doc** button shows.
2. Click it → loading spinner appears.
3. Within the poll window, the panel swaps to the embedded `/preview` of the newly created Google Doc.
4. Confirm the doc exists in the target Drive folder and that `Notes Doc` on the row is now populated.

This confirms spike #3 (button push via API **including write-back**) and spike #4 (proxy route) together. If the URL never lands: inspect the notes-doc button's action in Coda — it must both run Copy file **and** write the returned URL into `thisRow.[Notes Doc]`.

- [ ] **Step 3: End-to-end — edit + shared-viewer preview**

Click **Edit in Google Docs** → opens `/edit` in a new tab. As a non-owner shared viewer, confirm the inline `/preview` still renders (already verified in the spike; re-confirm with a real provisioned doc).

- [ ] **Step 4: Update the spec — mark spikes #3/#4 done**

In `docs/superpowers/specs/2026-08-20-planning-notes-google-docs-design.md`, mark spikes #3 and #4 done with the verification date and the ids (notes-doc button = `c-Xa89eEgVN5`, Notes Doc column = `c-gCr2zZXbdZ`).

- [ ] **Step 5: Update CLAUDE.md status**

Add a "Plan 2b-iii — Planning Notes as Google Docs" bullet under the Phase 2 status noting: per-row Google Doc via a Coda button (Copy file action) pushed by id through `POST /notes-doc`; the URL read is anchored to the column id; embedded read-only `/preview` + edit-in-Docs; legacy `Planning Notes` column retired in-app.

- [ ] **Step 6: Update project memory**

Update `phase2-inverted-planning.md` (and its MEMORY.md hook) to note the Notes-as-Google-Docs capability shipped.

- [ ] **Step 7: Commit + finish the branch**

```bash
git add CLAUDE.md docs/superpowers/specs/2026-08-20-planning-notes-google-docs-design.md
git commit -m "docs: Planning Notes as Google Docs — spikes verified, status updated"
```

Then use superpowers:finishing-a-development-branch to decide merge/PR for `feat/planning-notes-google-docs`.

---

## Self-review notes

- **Spec coverage:** responsibility model (Tasks 1,3,4), Coda button provisioning (user-done + Task 6 gate), proxy push route (Task 2), app create+poll+embed (Task 4), retire legacy notes (Task 5), verification spikes #2 (spike, done), #3/#4 (Task 6). Event Description untouched (non-goal) — respected. ✓
- **Id-anchored, rename-proof:** both Coda touchpoints key on stable ids — `CODA_NOTES_COL_ID = c-gCr2zZXbdZ` (read) and `CODA_NOTES_BUTTON_ID = c-Xa89eEgVN5` (button push) — never on the churny display names (`Notes Doc` / `Create Notes Doc`).
- **Name consistency:** `notesDocUrl` (normalized field, injected by the proxy), `columnName` (proxy resolver), `createNotesDoc` / `pollForNotesDoc` / `NDOC_CREATE_HTML` / `notesDocPanelHTML` / `notesDocEmbedHTML` (app functions) — used consistently across tasks. ✓
- **No placeholders:** every code step shows exact code and exact commands. ✓
