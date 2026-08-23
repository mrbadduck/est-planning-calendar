# Workspace Save-Pattern Redesign — Implementation Plan

> **For agentic workers:** Steps use `- [ ]` checkboxes. Buildless app — run
> `node --check web/app.js` after every JS edit. Verify UI in the browser
> preview per `<verification_workflow>`.

**Goal:** Replace the workspace's global Save/Cancel footer with (1) a one-shot
**create** modal that transitions into the workspace, and (2) **on-blur
auto-save** for existing events with a save-status indicator. Public copy
auto-saves to Coda; Eventbrite push stays deliberate with an out-of-sync hint.
Branch `feat/eventbrite-publish`.

**Design:** `docs/superpowers/specs/2026-08-23-workspace-save-pattern-design.md`.

**Key existing code (web/app.js):** `openEditor` ~800, footer build ~839–846,
entry points `newEventOn`/`newIdeaInMonth` ~1242, day-picker ~1250, `readForm`
~1070, `saveEditor` ~1136, `applyLocal`/`markRecent`/`scheduleReconcile`
~380/1129, `wirePlanning` ~940, `wirePublishPanel` ~734, `renderPublish` ~1001,
`publishPanelHTML` ~708, footer handler ~1199, `close`/`show` ~1192.

---

## Task 1: Create-flow — one-shot Planning modal

**Files:** `web/app.js`.

- [ ] **Step 1:** Add `openNewEventForm(seed)`. It renders the compact (non-`ws`)
  modal with only the Planning form:
  - `editing = seed;` set `mTitle` = "New event", `mStripe` color from
    `progColor(seed.program)`.
  - `document.getElementById('modal').classList.remove('ws')`; same for `mBody`.
  - `mActions.innerHTML = ''` (no status/approve on a not-yet-created event).
  - `mBody.innerHTML = renderPlanning(seed, true, false, false)` then
    `wirePlanning(mBody, seed, true, false, false)`.
  - Footer: `<span class="push"></span><button class="btn" data-act="close">Cancel</button><button class="btn primary" data-act="create">Create</button>`.
  - `show()`; focus `#f_title`.
- [ ] **Step 2:** Add `createFromForm()` (mirror `saveEditor`'s new branch, but on
  success open the workspace instead of closing):
```js
async function createFromForm(){
  if(_saving) return;
  const exp=tokenExpMs(); if(exp && exp<=Date.now()){ sessionExpired(); return; }
  const f=readForm();
  const me=(state.identity && state.identity.name) || '';
  const e=Object.assign({}, {source:'planning', eventbriteUrl:'', gcalId:'', createdBy:me, editedBy:me}, f);
  e.id='tmp-'+Date.now();
  _saving=true; applyLocal(e); rerender(); toast('Creating…','busy');
  try{
    const saved=await DB.create(e);
    if(saved && saved.id && saved.id!==e.id){ applyLocal(e,true); e.id=saved.id; applyLocal(e); }
    markRecent(e.id,{e}); rerender(); toast('Created','ok'); scheduleReconcile();
    _saving=false;
    openEditor(e);                 // transition into the workspace for the new event
  }catch(err){
    applyLocal(e,true); rerender(); _saving=false;
    if(err && err.status===401) sessionExpired();
    else toast('Create failed — try again','err');   // create modal stays open
  }
}
```
- [ ] **Step 3:** Repoint entry points from `openEditor(newEventOn(...))` /
  `openEditor(newIdeaInMonth(...))` to `openNewEventForm(...)`:
  - `#months` handler: `[data-newidea]` → `openNewEventForm(newIdeaInMonth(...))`;
    cell click → `openNewEventForm(newEventOn(cell.dataset.date))`.
  - `#quarter` handler: `z.dataset.add` → `openNewEventForm(newEventOn(...))`.
  - day-picker "+ New on this day" → `openNewEventForm(newEventOn(ds))`.
- [ ] **Step 4:** Footer handler (`#mFoot` listener ~1199): add
  `else if(act==='create') createFromForm();`.
- [ ] **Step 5:** `node --check web/app.js`. Commit:
  `feat(app): one-shot create modal → transitions into workspace`.

---

## Task 2: Auto-save engine (existing events)

**Files:** `web/app.js`.

- [ ] **Step 1:** Add module state near `_saving` (~1129):
```js
let _autosaveT=null, _lastSavedSnap=null;
const snap = f => JSON.stringify(f);
function setSaveStatus(s){                     // s: 'clean'|'dirty'|'saving'|'error'
  const el=document.getElementById('saveStatus'); if(!el) return;
  el.className='savestat '+s;
  el.textContent = s==='saving'?'Saving…' : s==='error'?'Save failed — retry' : s==='dirty'?'Unsaved changes' : 'Saved';
}
function scheduleAutosave(){
  if(!editing || !editing.id) return;          // create modal / read-only: no autosave
  setSaveStatus('dirty');
  clearTimeout(_autosaveT); _autosaveT=setTimeout(()=>autosaveEditor(), 800);
}
async function flushAutosave(){ clearTimeout(_autosaveT); if(editing && editing.id) await autosaveEditor(); }
```
- [ ] **Step 2:** Add `autosaveEditor()` — in-place save, never closes the modal:
```js
async function autosaveEditor(){
  if(!editing || !editing.id) return;
  if(_saving){ clearTimeout(_autosaveT); _autosaveT=setTimeout(()=>autosaveEditor(),300); return; } // coalesce
  const exp=tokenExpMs(); if(exp && exp<=Date.now()){ sessionExpired(); return; }
  const f=readForm();
  if(_lastSavedSnap && snap(f)===_lastSavedSnap){ setSaveStatus('clean'); return; }               // no-op
  markEbDirtyIfPublicChanged(f);                 // Task 4
  Object.assign(editing, f);
  editing.editedBy=(state.identity && state.identity.name) || editing.editedBy;
  _saving=true; setSaveStatus('saving');
  applyLocal(editing); markRecent(editing.id,{e:editing}); rerender();  // calendar behind modal
  try{ await DB.update(editing); _lastSavedSnap=snap(f); setSaveStatus('clean'); scheduleReconcile(); }
  catch(err){ if(err && err.status===401) sessionExpired(); else { setSaveStatus('error'); console.warn('autosave failed:',err);} }
  finally{ _saving=false; }
}
```
- [ ] **Step 3:** `node --check web/app.js`. Commit:
  `feat(app): in-place debounced autosave engine + save-status`.

---

## Task 3: Wire the workspace to autosave + new footer

**Files:** `web/app.js`, `web/styles.css`.

- [ ] **Step 1:** In `openEditor` footer build (~839–846), for an editable,
  non-locked **existing** event, replace the Save/Cancel with Delete + status:
```js
let acts='';
if(ev.id && canEdit && !locked) acts+=`<button class="btn danger" data-act="delete">Delete</button>`;
acts+=`<span class="push"></span>`;
if(ev.id && canEdit && !locked) acts+=`<span class="savestat clean" id="saveStatus">Saved</span>`;
acts+=`<button class="btn" data-act="close">${canEdit&&!locked?'Done':'Close'}</button>`;
foot.innerHTML=acts;
```
  (Keep the read-only/locked footer as-is: just a Close button. No `saveStatus`,
  no autosave when `!canEdit || locked`.) Initialize `_lastSavedSnap=null` at the
  top of `openEditor` so the first real edit always saves.
- [ ] **Step 2:** After `renderSection(...)` in `openEditor`, if `canEdit &&
  !locked`, attach the blur listener:
```js
document.getElementById('wpanel').addEventListener('focusout', ()=>scheduleAutosave());
```
  Also re-init `_lastSavedSnap=snap(readForm())` right after the first
  `renderSection` so a section-switch that fires focusout doesn't trigger a
  spurious first save.
- [ ] **Step 3:** In `wirePlanning`, call `scheduleAutosave()` from each mutation
  handler that changes state without a text blur: program-chip click, when-seg
  click, all-day change, venue-type click. In `initTypeahead` /
  `initVenuePicker` add/remove callbacks (leads, volunteers, venue) call
  `scheduleAutosave()` too — pass an `onChange` option or call it from the chip
  add/remove + pick handlers. In `wirePublish`, address-visibility click and the
  copy-from-internal button call `scheduleAutosave()`.
  - Guard each call with `if(editing && editing.id)` (the create modal reuses
    `wirePlanning` but must not autosave).
- [ ] **Step 4:** The rail section-switch handler already does
  `Object.assign(ev, readForm())`. Leave it (harmless with autosave; keeps
  in-memory `ev` fresh for the next section's render). Remove nothing.
- [ ] **Step 5:** `web/styles.css`: add `.savestat` (muted, small) with modifier
  colors — `.clean`(muted), `.dirty`(amber), `.saving`(muted italic),
  `.error`(danger, `cursor:pointer`). Add `.btn.xs` if not present (used by
  copy-from-internal). Verify the create modal's compact `.modal` (non-ws) still
  looks right with just the Planning form.
- [ ] **Step 6:** Footer handler: make the status element retry on click —
  in the `#mFoot` listener, `if(e.target.id==='saveStatus' && e.target.classList.contains('error')) flushAutosave();`.
- [ ] **Step 7:** `node --check`. Commit:
  `feat(app): workspace autosaves on blur; footer = delete + status (no global Save)`.

---

## Task 4: Eventbrite flush-before-push + out-of-sync hint

**Files:** `web/app.js`.

- [ ] **Step 1:** Add the public-field dirty tracker:
```js
const EB_PUBLIC_KEYS=['publicSummary','publicDescription','capacity','addressVisibility','title','date','start','end','venue'];
function markEbDirtyIfPublicChanged(f){
  if(!editing || !editing.eventbriteId) return;
  if(EB_PUBLIC_KEYS.some(k=>String(editing[k]??'')!==String(f[k]??''))) editing._ebDirty=true;
}
```
- [ ] **Step 2:** In `wirePublishPanel`, before the push call
  (`DB.publishEventbrite`), `await flushAutosave();` so the Worker reads the
  freshest Coda copy. On success, clear `editing._ebDirty=false` (already repaints
  the panel via `publishPanelHTML`).
- [ ] **Step 3:** In `publishPanelHTML`, when `linked && ev._ebDirty`, prepend a
  hint (`<div class="ndoc-warn">Draft is behind your latest edits — Update draft to sync.</div>`)
  and give the Update-draft button `.primary` emphasis. When not dirty, current
  behavior.
- [ ] **Step 4:** `node --check`. Commit:
  `feat(app): flush autosave before EB push; out-of-sync draft hint`.

---

## Task 5: Verify + finish

- [ ] **Step 1:** `node --test` in `proxy/` (should stay green — no proxy change
  here) and `node --check web/app.js`.
- [ ] **Step 2:** Browser preview (`npx -y live-server web --port=8080
  --no-browser`): with a signed-in lead —
  - Create: entry point → compact create modal → Create → lands in workspace for
    the new event; Cancel → nothing persisted.
  - Edit: change a Planning field, blur → status `Saving…` → `Saved`; reload →
    persisted. Toggle a program chip / venue / when → autosaves.
  - Publish: edit public copy (auto-saves), Create draft flushes first; after a
    push, edit public copy → out-of-sync hint appears; re-push clears it.
  - Approve (header) and Delete (footer) still work.
- [ ] **Step 3:** Update `CLAUDE.md` (editor section) + memory
  (`frontend-architecture.md`) to describe the create-then-workspace + autosave
  model. Commit.
- [ ] **Step 4:** Follow `superpowers:finishing-a-development-branch` for the
  §A+§B branch: PR `feat/eventbrite-publish` → `main` (merge deploys the app).
