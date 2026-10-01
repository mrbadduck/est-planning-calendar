# UI Cleanup Batch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the eight UI fixes in `docs/superpowers/specs/2026-10-01-ui-cleanup-design.md` on branch `feat/ui-cleanup`, with help updated.

**Architecture:** Buildless vanilla app. Markup is in `web/index.html`; all logic is in `web/app.js` (classic script, shared globals); styles are in `web/styles.css`. No Worker change. There's no DOM test harness, so each task's "failing test" is a check run in the local preview (`http://localhost:8080`, live-server on `web/`). Run it before the change (it fails), then after (it passes).

**Tech Stack:** HTML/CSS/vanilla JS. Node 22 for `node --check` and `cd proxy && npm test`. `node scripts/check-help.mjs` for the help guard. The Claude browser preview for checks and screenshots.

**Conventions:**
- Comments match the file's existing density.
- Every task ends with `node --check web/app.js` and a commit.
- No commit needs `Help: none`: the branch updates help in Task 8, and the guard checks the branch as a whole.
- A simulated identity for preview checks (writes stay stubbed, nothing reaches Coda):
  `state.identity={signedIn:true,matched:true,name:'Check',canWrite:true,canApprove:true}; state.authResolved=true; updateGate(); DB.update=async()=>{}; DB.create=async()=>{throw new Error('stub')};`

---

### Task 1: Instant tooltips (spec §4)

**Files:**
- Modify: `web/app.js` — add the tooltip block right after `function toast(…){…}`; header icons in `openEditor` and `openNewEventForm`
- Modify: `web/styles.css` — add `.tip` rules before the `@media (prefers-color-scheme:dark)` block
- Modify: `web/index.html` — `#helpBtn`, `#mClose`, `#helpClose`

- [ ] **Step 1: Failing check.** In the preview (simulated identity), open any planning event and run:
```js
const b=document.querySelector('#mActions [data-act="copylink"]');
b.dispatchEvent(new PointerEvent('pointerover',{bubbles:true,pointerType:'mouse'}));
({ tip: (document.querySelector('.tip:not([hidden])')||{}).textContent || null })
```
Expected now: `{tip:null}`.

- [ ] **Step 2: Add the tooltip block to `web/app.js`** directly after the `toast` function:
```js
/* ---- tooltips: any element with data-tip gets one shared bubble, shown at once
   on hover or keyboard focus (title= is slow and never shows for keyboards).
   Fixed-position so a modal can't clip it; touch gets none (there's no hover). */
const _tip=document.createElement('div'); _tip.className='tip'; _tip.setAttribute('role','tooltip'); _tip.hidden=true;
document.body.appendChild(_tip);
let _tipFor=null;
function showTip(el){
  const text=el.dataset.tip; if(!text) return;
  _tipFor=el; _tip.textContent=text; _tip.hidden=false;
  const r=el.getBoundingClientRect(), w=_tip.offsetWidth, h=_tip.offsetHeight;
  const left=Math.max(6, Math.min(r.left + r.width/2 - w/2, innerWidth - w - 6));
  const top=(r.bottom + 6 + h > innerHeight - 6) ? r.top - h - 6 : r.bottom + 6;   // flip above near the bottom edge
  _tip.style.left=left+'px'; _tip.style.top=top+'px';
}
function hideTip(){ _tipFor=null; _tip.hidden=true; }
document.addEventListener('pointerover', e=>{
  if(e.pointerType==='touch') return;
  const el=e.target.closest('[data-tip]');
  if(el){ if(el!==_tipFor) showTip(el); } else if(_tipFor) hideTip();
});
document.addEventListener('pointerout', e=>{ if(!e.relatedTarget) hideTip(); });   // left the window
document.addEventListener('focusin', e=>{ const el=e.target.closest('[data-tip]'); if(el && el.matches(':focus-visible')) showTip(el); });
document.addEventListener('focusout', hideTip);
document.addEventListener('pointerdown', hideTip);
document.addEventListener('scroll', hideTip, true);
document.addEventListener('keydown', e=>{ if(e.key==='Escape') hideTip(); });
```

- [ ] **Step 3: Add the CSS** (`web/styles.css`, before the dark-mode block):
```css
  /* ---- tooltips (data-tip — one shared bubble, see showTip in app.js) ---- */
  .tip{position:fixed;z-index:90;pointer-events:none;padding:4px 8px;border-radius:6px;background:var(--ink);color:var(--surface);font-size:11.5px;font-weight:500;line-height:1.35;white-space:nowrap;box-shadow:var(--shadow)}
  .tip[hidden]{display:none}
```

- [ ] **Step 4: Swap `title` for `data-tip` on the icon buttons** (keep every `aria-label`):
  - `openEditor` header (`web/app.js`):
    - `title="Help for this tab"` → `data-tip="Help for this tab"`
    - on the gather link, `title="View in gather"` → `data-tip="View in gather"`
    - on copylink, `title="Copy link"` → `data-tip="Copy link"`
  - `openNewEventForm`: `title="Help: adding an event"` → `data-tip="Help: adding an event"`.
  - `web/index.html`:
    - `#helpBtn`: `title="Help"` → `data-tip="Help"`
    - `#mClose`: `title="Close"` → `data-tip="Close"`
    - `#helpClose`: `title="Close"` → `data-tip="Close help"`

- [ ] **Step 5: Re-run the Step 1 check.** Expected: `{tip:"Copy link"}`. Take a screenshot hovering the event header's ✕ for the PR.

- [ ] **Step 6: Commit**
```bash
node --check web/app.js && git add web/app.js web/styles.css web/index.html && git commit -m "feat(web): instant tooltips for icon buttons (data-tip)"
```

### Task 2: Settings panel replaces the layers strip; header reorder (spec §6, §8)

**Files:**
- Modify: `web/index.html` — header `.row2`, `#ovfPanel`; remove the `#layers` strip after `.bar`
- Modify: `web/app.js`:
  - `renderLayers`
  - the layer-toggle click handler (`/* layer toggles */`)
  - remove `headerMQ` and `applyHeaderMode` and their calls in `init`
  - the reference-event lock note in `openEditor`
- Modify: `web/styles.css` — the `.ovf-panel*` rules and the `/* ---- layers strip ---- */` block; add the phone `+` rules

- [ ] **Step 1: Failing check** (preview, desktop width):
```js
({ strip: !!document.querySelector('.bar + .layers'), inPanel: !!document.querySelector('#ovfPanel #layers'),
   order: [...document.querySelectorAll('.row2 > button')].map(b=>b.id), gearShown: !document.getElementById('ovfBtn').hidden })
```
Expected now: `{strip:true, inPanel:false, order:['addBtn','refreshBtn','ovfBtn'], gearShown:false}`.

- [ ] **Step 2: Replace the row-2 buttons and the panel in `web/index.html`.** The three buttons after `<span class="grow-sp"></span>` in `.row2`, plus the empty `#ovfPanel`, become:
```html
    <button class="btn ghost icon" id="refreshBtn" type="button" aria-label="Refresh event data" data-tip="Refresh event data">↻</button>
    <button class="btn ghost icon" id="ovfBtn" type="button" aria-label="Calendar settings" data-tip="Calendar settings" aria-expanded="false" aria-controls="ovfPanel"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg></button>
    <button class="btn primary" id="addBtn" type="button" aria-label="New event"><span class="add-long">+ New event</span><span class="add-short" aria-hidden="true">+</span></button>
  </div>
  <div class="ovf-panel" id="ovfPanel" hidden>
    <div class="ovf-h">Show on calendar</div>
    <div class="layers" id="layers">
      <button type="button" class="lyr" data-on="true" aria-pressed="true" data-layer="planning">
        <span class="dot" style="background:linear-gradient(135deg,var(--p-kab),var(--p-tot))"></span>
        <span class="name">Planning events</span>
      </button>
      <!-- reference toggles injected by renderLayers -->
    </div>
  </div>
```
Delete the old `<div class="layers" id="layers">…</div>` strip that follows `.bar`. (The spec's "Show or hide your planning events" tooltip isn't needed: the toggle now sits under a "Show on calendar" heading, which says it.)

- [ ] **Step 3: `web/app.js`: `renderLayers`.** Reference toggles become buttons, and the names and colors are escaped (they come from a Coda table):
```js
function renderLayers(){
  const box=document.getElementById('layers');
  // remove any previously injected ref toggles
  box.querySelectorAll('[data-ref-toggle]').forEach(n=>n.remove());
  for(const r of REF_LAYERS){
    const on=!!state.layers[r.id];
    const el=document.createElement('button');
    el.type='button'; el.className='lyr'; el.dataset.on=on; el.setAttribute('aria-pressed', String(on));
    el.dataset.refToggle='1'; el.dataset.layer=r.id;
    el.innerHTML=`<span class="swatch-ref" style="background:${cssColor(r.color,'var(--faint)')}"></span><span class="name">${esc(r.name)}</span>`;
    box.appendChild(el);
  }
}
```

- [ ] **Step 4: `web/app.js`: the layer-toggle handler** (replace the body of `document.getElementById('layers').addEventListener('click', …)`):
```js
document.getElementById('layers').addEventListener('click',e=>{
  const lab=e.target.closest('.lyr'); if(!lab) return;
  const id=lab.dataset.layer;                  // 'planning' or a reference layer id
  state.layers[id]=!state.layers[id];
  lab.dataset.on=state.layers[id]; lab.setAttribute('aria-pressed', String(state.layers[id]));
  rerender();
});
```

- [ ] **Step 5: `web/app.js`: remove the phone relocation.**
  - Delete `const headerMQ = …` and `function applyHeaderMode(){…}`.
  - Rename the section comment above `ovfMenu` to `/* ---- calendar settings (⚙): the layer toggles, in a pop-over at every width ---- */`.
  - In `init`, delete `headerMQ.addEventListener('change', applyHeaderMode);` and `applyHeaderMode();`. `layoutSticky` still runs on load and resize.
  - In `openEditor`'s reference branch, change the lock note to `Read-only reference calendar. To hide this layer, turn it off under ⚙ at the top.`

- [ ] **Step 6: `web/styles.css`.**
  - Remove from the `/* mobile overflow menu (⋯) */` block: `.ovf-panel .yearnav{…}`, `.ovf-panel .layers{…}` and `.ovf-panel .layers .spacer{…}`.
  - Replace the whole `/* ---- layers strip ---- */` block (from `.layers{` through `.spacer{flex:1 1 20px}`) with:
```css
  /* ---- calendar settings pop-over (⚙ #ovfBtn → #ovfPanel): the layer toggles ---- */
  .ovf-h{font-size:10.5px;font-weight:600;color:var(--faint);text-transform:uppercase;letter-spacing:.7px;padding:2px 6px}
  .layers{display:flex;flex-direction:column;gap:1px}
  .lyr{display:flex;align-items:center;gap:8px;width:100%;padding:6px;border:0;border-radius:6px;background:transparent;font:inherit;font-size:12.5px;color:var(--muted);text-align:left;cursor:pointer;user-select:none}
  .lyr:hover{background:var(--soft);color:var(--ink)}
  .lyr .dot{width:10px;height:10px;border-radius:3px;flex:0 0 auto;border:1px solid rgba(0,0,0,.08)}
  .lyr .swatch-ref{width:10px;height:10px;border-radius:50%;flex:0 0 auto}
  .lyr[data-on="false"]{opacity:.45}
  .lyr[data-on="false"] .name{text-decoration:line-through}
  .btn.icon svg{display:block}
  .add-short{display:none}
```
  - In `.ovf-panel{…}`, change `width:min(320px, calc(100vw - 28px))` to `width:min(280px, calc(100vw - 28px))` and `gap:12px` to `gap:6px`, and the comment to `/* calendar settings pop-over */`.
  - In the first `@media (max-width:600px){…}` header block, add:
```css
    #addBtn .add-long{display:none}
    #addBtn .add-short{display:inline}
    #addBtn{padding:5px 11px;font-size:16px;line-height:1}
```
  - Grep the dark-mode block for `.layers`, `.lyr` or `grp-label` overrides and drop any that are left.

- [ ] **Step 7: Re-run Step 1.** Expected: `{strip:false, inPanel:true, order:['refreshBtn','ovfBtn','addBtn'], gearShown:true}`. Then:
  - click ⚙ → the panel shows "Show on calendar" and the toggles;
  - click **Planning events** → planning chips disappear and the button reads `aria-pressed="false"`;
  - Escape closes the panel.
- [ ] **Step 8: Phone fit.** `resize_window` to 375×812 and reload, then run:
  ```js
  ({ row2: document.querySelector('.row2').offsetHeight, year: !!document.querySelector('.row2 .yearnav'), add: getComputedStyle(document.querySelector('#addBtn .add-short')).display })
  ```
  The year picker should be present and `add` should be `inline`. If `row2` is taller than one line (> ~36px), tighten at ≤600px with `.seg button{padding:6px 8px}` and `.yearnav .btn.icon{padding:6px 7px}`. Re-check until it's one line, take a screenshot, then reset with `resize_window` `desktop`.

- [ ] **Step 9: Commit**
```bash
node --check web/app.js && git add web/index.html web/app.js web/styles.css && git commit -m "feat(web): calendar settings (⚙) replaces the layers strip; header is ↻ ⚙ + New event"
```

### Task 3: Only a "+" button adds from the calendar (spec §7)

**Files:**
- Modify: `web/app.js`:
  - `renderMonths`: day cells and the Ideas `gcell`
  - `renderOverview`: the week zones
  - the `#months` and `#quarter` click handlers
- Modify: `web/styles.css` — the `.cell`, `.cell .add-hint`, `.gcell`/`.gadd` and `.qzone` rules

- [ ] **Step 1: Failing check** (simulated identity; Calendar view, then Overview):
```js
state.view='year'; applyView();
const cell=document.querySelector('#months .cell:not([data-other])');
cell.dispatchEvent(new MouseEvent('click',{bubbles:true}));
const opened=document.getElementById('scrim').classList.contains('open'); close();
({ cellClickOpensForm: opened, plusButtons: document.querySelectorAll('#months .cell-add').length })
```
Expected now: `{cellClickOpensForm:true, plusButtons:0}`.

- [ ] **Step 2: Day cells** (`renderMonths`). Replace `<span class="add-hint">+</span>` with:
```js
          <button type="button" class="cell-add" data-add-date="${ds}" aria-label="Add an event on ${fmtDate(ds)}" data-tip="Add an event">+</button>
```

- [ ] **Step 3: The Ideas cell** (`renderMonths`). Replace the `gcell` line with:
```js
      body += `<div class="gcell">${ghint}<button type="button" class="gadd" data-newidea="${mk}" aria-label="Add an idea for ${MONTHS[Number(mk.slice(5,7))-1]}" data-tip="Add an idea for this month">+</button>${ideas.map(e=>gchipHTML(e,mk)).join('')}</div>`;
```

- [ ] **Step 4: Overview zones** (`renderOverview`). Replace the two `qzone` lines inside `weeks += …` with a helper defined just before it in the same loop:
```js
      const zone = (kind, list) => `<div class="qzone ${kind}">${list.map(qchipHTML).join('')||'<span class="zlbl">·</span>'}<button type="button" class="zone-add" data-add="${weekAddDate(y,m,dayNums,kind)}" aria-label="Add a ${kind==='wkn'?'weeknight':'weekend'} event, ${MONTHS[m]} ${lbl}" data-tip="Add an event">+</button></div>`;
      weeks += `<div class="qweek">
        <div class="qwk">${lbl}</div>
        ${zone('wkn', wkn)}
        ${zone('wknd', wknd)}
      </div>`;
```

- [ ] **Step 5: Click handlers.**
  - In the `#months` handler, replace `const cell=e.target.closest('.cell'); if(!cell) return; openNewEventForm(newEventOn(cell.dataset.date));` with:
```js
  const add=e.target.closest('[data-add-date]'); if(add) openNewEventForm(newEventOn(add.dataset.addDate));   // only the + adds — the rest of the day does nothing
```
  - In the `#quarter` handler, replace `const z=e.target.closest('.qzone'); if(z && z.dataset.add) openNewEventForm(newEventOn(z.dataset.add));` with:
```js
  const z=e.target.closest('.zone-add'); if(z) openNewEventForm(newEventOn(z.dataset.add));
```
  - `[data-newidea]` now matches only the Ideas `+` button, so that branch stays as is.

- [ ] **Step 6: CSS.**
  - In `.cell{…}`, change `cursor:pointer` to `cursor:default`.
  - Delete `.cell .add-hint{…}` and `.cell:hover .add-hint{…}`.
  - In `.gcell{…}`, change `cursor:pointer` to `cursor:default`, and delete `.gcell .gadd{…}` and `.gcell:hover .gadd{…}`.
  - In `.qzone{…}`, change `cursor:pointer` to `cursor:default;position:relative`.
  - Then add:
```css
  .qzone:hover{background:rgba(69,69,158,.06)}
  .qzone.wknd:hover{background:rgba(69,69,158,.09)}
  /* add buttons — the only way to add from the calendar; revealed on hover/focus (spec 2026-10-01 §7) */
  .cell-add,.gadd,.zone-add{
    position:absolute;top:3px;right:3px;width:20px;height:20px;padding:0;border:0;border-radius:5px;
    background:var(--surface);color:var(--accent);font:inherit;font-size:15px;font-weight:500;line-height:1;
    display:flex;align-items:center;justify-content:center;cursor:pointer;opacity:0;transition:opacity .1s,background .1s;
  }
  .cell:hover .cell-add,.gcell:hover .gadd,.qzone:hover .zone-add,
  .cell-add:focus-visible,.gadd:focus-visible,.zone-add:focus-visible{opacity:.8}
  .cell-add:hover,.gadd:hover,.zone-add:hover{opacity:1;background:var(--accent-tint)}
  @media (hover:none){ .cell-add,.gadd,.zone-add{opacity:.45} }
```

- [ ] **Step 7: Re-run the Step 1 check** and extend it:
  - Expected: `{cellClickOpensForm:false, plusButtons:>0}`.
  - Clicking `.cell-add` opens the form dated that day.
  - In Overview, clicking a `.qzone` doesn't open the form, while clicking `.zone-add` does.
  - Take screenshots: a hovered day in Calendar view, a hovered lane in Overview, and a lane with chips, to check the `+` doesn't make a chip unreadable.

- [ ] **Step 8: Commit**
```bash
node --check web/app.js && git add web/app.js web/styles.css && git commit -m "feat(web): only a + button adds from the calendar (days, Ideas, Overview lanes)"
```

### Task 4: Venue type dropdown (spec §1)

**Files:**
- Modify: `web/app.js`:
  - `renderPlanning`: the Where block
  - `initVenuePicker`: `selTypeId` and the sync in `selectVenue`
  - `wirePlanning`: the `vtSeg` block
  - `readForm`: `venueType`

- [ ] **Step 1: Failing check.** Open the new-event form (simulated identity, `openNewEventForm(newEventOn(todayStr))`):
```js
({ select: !!document.getElementById('f_vtype'), seg: !!document.getElementById('f_vtype_seg') })
```
Expected now: `{select:false, seg:true}`.

- [ ] **Step 2: `renderPlanning`.** In the `relOK` branch of **Where**, replace the `<div class="whenseg vtype-seg" id="f_vtype_seg">…</div>` block with:
```js
      ${relOK ? `<div class="fld full"><label for="f_vtype">Venue type</label><select id="f_vtype" ${dis}>
        <option value="" ${!ev.venueType?'selected':''}>Any</option>
        ${VENUE_TYPES.map(t=>`<option value="${esc(t.id)}" ${t.id===ev.venueType?'selected':''}>${esc(t.name)}</option>`).join('')}
      </select></div>
```
(Keep the venue box `<div class="fld full"><div class="typeahead venuepick…" id="f_venue_box">…` that follows, and the read-only `: …` branch, unchanged.)

- [ ] **Step 3: `initVenuePicker`.**
  - Replace `const selTypeId = () => { const b=document.querySelector('#f_vtype_seg button[aria-pressed="true"]'); return b?b.dataset.vtype:''; };` with:
```js
  const selTypeId = () => { const s=document.getElementById('f_vtype'); return s ? s.value : ''; };
```
  - In `selectVenue`, replace the two seg-sync lines (`const tid=venueTypeIdByName[v.type], seg=…` and `if(seg && tid) […]`) with:
```js
    const tid=venueTypeIdByName[v.type], sel=document.getElementById('f_vtype');   // sync the type picker to the venue
    if(sel && tid) sel.value=tid;
```

- [ ] **Step 4: `wirePlanning`.** Replace the `const vtSeg=…; if(vtSeg && canEdit && !locked){ …click handler… }` block with:
```js
  const vtSel=document.getElementById('f_vtype');   // absent while the relations show read-only (relationsReady)
  if(vtSel && canEdit && !locked) vtSel.addEventListener('change', scheduleAutosave);   // filters the venue search; saves like any field
```

- [ ] **Step 5: `readForm`.** Replace the two `vtBtn`/`venueType` lines with:
```js
  const vtSel=g('f_vtype');
  const venueType=vtSel ? (vtSel.value||'') : ((editing&&editing.venueType)||'');
```

- [ ] **Step 6: Re-run Step 1.** Expected: `{select:true, seg:false}`. Then check:
  - Choosing a type narrows the venue search. Type a letter in **Search venues…** and check that every option has that type.
  - Picking a venue sets the select to its type.
  - In an existing event's workspace, changing the type schedules a save that sends only `Venue Type`. Use the stubbed `DB.update` that records cells.
  - `grep -n "f_vtype_seg" web/app.js` returns nothing.
  - Take a screenshot of the Where card.

- [ ] **Step 7: Commit**
```bash
node --check web/app.js && git add web/app.js && git commit -m "feat(web): venue type is a dropdown, not a wrapping segmented control"
```

### Task 5: The new-event form sizes to its content (spec §2)

**Files:** Modify `web/styles.css` (the `.modal.create` rule)

- [ ] **Step 1: Failing check.** Open the new-event form at desktop width:
```js
const m=document.getElementById('modal'), b=document.getElementById('mBody');
({ modal: m.offsetHeight, content: b.scrollHeight + document.querySelector('.mhead').offsetHeight + document.getElementById('mFoot').offsetHeight })
```
Expected now: `modal` is well above `content` (empty band).

- [ ] **Step 2: Replace** `/* create modal: same fixed shell as the workspace so Create→workspace doesn't jump */` and its rule with:
```css
  /* create modal: sizes to its form (the body scrolls past the cap); phones stay full-screen below */
  .modal.create{height:auto;max-height:min(760px, calc(100dvh - 96px));max-width:740px}
```
(The phone rule `@media (max-width:600px){ .modal.ws,.modal.create{height:100dvh;…} }` stays.)

- [ ] **Step 3: Re-run Step 1.** Expected: `modal` ≈ `content`, within the borders. Then:
  - with the window 600px tall, the body scrolls and the footer stays visible;
  - at 375px the form is still full-screen;
  - take a desktop screenshot.

- [ ] **Step 4: Commit**
```bash
git add web/styles.css && git commit -m "fix(web): the new-event form sizes to its content"
```

### Task 6: Past approved or live events lock Details (spec §3)

**Files:**
- Modify: `web/app.js`:
  - add `isHistory` after `isPastEvent`
  - `openEditor`: the `pastLocked` flag, footer, save label, `_form` binding, loading gate
  - `renderSection`: the Details lock
  - `renderPlanning`: the lock note

- [ ] **Step 1: Failing check.** Use the simulated identity with `canApprove:true`. Make a past approved event in memory:
```js
const src=state.events.find(e=>e.source==='planning');
const ev=Object.assign({}, src, { id:'i-past-check', status:'approved', scheduling:'exact', date:'2026-01-15' });
state.events.push(ev); openEditor(ev);
({ footer:[...document.querySelectorAll('#mFoot [data-act]')].map(b=>b.dataset.act), titleDisabled: document.getElementById('f_title').disabled, pill: !!document.getElementById('saveStatus') })
```
Expected now: `footer` includes `cancel` and `delete`, `titleDisabled:false`, `pill:true`.

- [ ] **Step 2: `isHistory`** (directly after `function isPastEvent…`):
```js
// An approved (or live) event whose date has passed: it happened, so its Details lock
// and it can't be cancelled or deleted (Notes, sign-ups and Attendees keep working).
function isHistory(ev){ return isPastEvent(ev) && ev.status==='approved'; }
```

- [ ] **Step 3: `openEditor`.**
  - After `const locked = …;`, add:
```js
  const pastLocked = !isRef && isHistory(ev);   // Details only — see renderSection (not `history`: that would shadow window.history)
```
  - Change the loading-gate condition to `if(!isRef && canEdit && !locked && !pastLocked && !relationsReady(ev) && !_refsSettled){`.
  - Change `let acts = footerActionsHTML(ev, canEdit, canApprove);` to `let acts = pastLocked ? '' : footerActionsHTML(ev, canEdit, canApprove);`.
  - Change the save-label condition to `if(ev.id && canEdit && !locked && !pastLocked)`.
  - Change the `_form` binding condition to `if(canEdit && !locked && !pastLocked && ev.id){`.

- [ ] **Step 4: `renderSection`.** Replace the last line (the Details render) with:
```js
  const detailsLocked = locked || isHistory(ev);   // a past approved event's Details are history; other tabs don't take this lock
  panel.innerHTML=renderDetails(ev, canEdit, detailsLocked, canApprove); wireDetails(panel, ev, canEdit, detailsLocked, canApprove);
```

- [ ] **Step 5: `renderPlanning`.** Replace the `${locked?`<div class="locknote">🔒 Approved &amp; locked. …`:''}` line with:
```js
    ${locked ? (isHistory(ev) ? `<div class="locknote">🔒 This event has happened, so its details are locked.</div>`
      : `<div class="locknote">🔒 Approved &amp; locked. Detailed edits (ticketing, banner, promotion) happen in Coda. <a href="#" data-act="coda">Open in Mission Control ↗</a></div>`) : ''}
```

- [ ] **Step 6: Re-run Step 1.** Expected: `{footer:[], titleDisabled:true, pill:false}`, with the history lock note showing. Then:
  - switch to **Planning Notes**, **Potluck & Volunteers** and **Attendees**: they behave as before (Notes stays editable for Council);
  - a past **draft** (same check with `status:'draft'`) still shows Propose/Cancel and editable fields.
  - Close, then remove the test event: `state.events=state.events.filter(e=>e.id!=='i-past-check'); rerender();`.

- [ ] **Step 7: Commit**
```bash
node --check web/app.js && git add web/app.js && git commit -m "feat(web): a past approved event's Details lock; no Cancel/Delete"
```

### Task 7: Help pushes the page aside on wide screens (spec §5)

**Files:**
- Modify: `web/styles.css` (help rules)
- Modify: `web/app.js` (`openHelp`, `closeHelp`)

- [ ] **Step 1: Failing check** (window ≥1000px wide):
```js
openHelp(''); const wrapR=document.querySelector('.wrap').getBoundingClientRect().right, drawerL=document.getElementById('helpDrawer').getBoundingClientRect().left;
({ coveredPx: Math.max(0, Math.round(wrapR - drawerL)) })
```
Expected now: `coveredPx > 0`. (Skip the check if `.wrap` is narrower than the window minus the drawer; widen the window first.)

- [ ] **Step 2: CSS.** Next to the existing `@media (min-width:1000px){ body.help-open .scrim{…} }` rule, add:
```css
  @media (min-width:1000px){ body.help-open{padding-right:var(--help-w)} }   /* wide: Help sits beside the page — header and calendar narrow instead of hiding under it */
```

- [ ] **Step 3: `openHelp` / `closeHelp`.**
  - Append `layoutSticky();` after `d.hidden=false; document.body.classList.add('help-open'); setHelpExpanded(true);`.
  - Append it after `d.hidden=true; document.body.classList.remove('help-open'); setHelpExpanded(false); setHelpUrl('');`.
  - Comment: `// the header narrows (or widens), so its height can change`.

- [ ] **Step 4: Re-run Step 1.** Expected: `coveredPx: 0`. With Help open:
  - the calendar scrolls, and clicking a chip opens its event beside the drawer;
  - at 800px the drawer still overlays (no push);
  - at 375px it's full-screen;
  - take screenshots at 1280px (open) and 800px.

- [ ] **Step 5: Commit**
```bash
node --check web/app.js && git add web/app.js web/styles.css && git commit -m "feat(web): Help pushes the page aside on wide screens"
```

### Task 8: Help text and What's new (Help ships with the change)

**Files:**
- Modify: `web/help/guide.md`, `web/help/whats-new.md`
- Modify: `CLAUDE.md` — the app section notes

- [ ] **Step 1: `guide.md`, Getting around.** Replace the **Layers** paragraph and the "On a phone, the year arrows and the layers are in the **⋯** menu." line with:
```markdown
**Layers.** Click **⚙** at the top to choose what the calendar shows: [[Planning events]] (your plans), plus reference calendars such as Jewish holidays and partner organizations. A hidden layer looks faded and crossed out. Reference events are read-only.
```

- [ ] **Step 2: `guide.md`, Read the calendar.** Change the last bullet to:
```markdown
- In an open event, a **Live** badge means it's published on Eventbrite, and **Past** means its date has gone by. Once an approved event is past, its details lock.
```

- [ ] **Step 3: `guide.md`, Add an event.** Step 1 becomes:
```markdown
1. Click [[+ New event]] (just **+** on a phone), or point at a day in Calendar view, or a weeknight or weekend lane in Overview, and click the **+** that appears. In Calendar view, the **+** in a month's [[Ideas]] column adds a whole-month idea.
```
In step 4, `pick [[Any]] to search every venue` becomes `set **Venue type** to [[Any]] to search every venue`.

- [ ] **Step 4: `guide.md`, lifecycle.**
  - In the cancel paragraph, `at any stage, even after it's live.` becomes `at any stage, even after it's live, until its date has passed.`
  - After the Delete paragraph, add:
```markdown
**After the date,** an approved event is history: its **Details** lock and it can't be cancelled or deleted. Its [[Planning Notes]], sign-ups and [[Attendees]] still work.
```

- [ ] **Step 5: `guide.md`, Common problems.**
  - `make sure [[Planning events]] isn't crossed out` becomes `make sure [[Planning events]] isn't crossed out under **⚙**`.
  - In **Everything is grayed out**, after `The event is approved (only Tribal Council can change it),` insert ` it's an approved event whose date has passed,`.
  - Keep each guide within the writing guide's word limits at the top of `guide.md`.

- [ ] **Step 6: `whats-new.md`.** Add above `## 2026-09-30`:
```markdown
## 2026-10-01
- **Calendar settings.** Showing or hiding planning events and reference calendars moved into **⚙** at the top, next to **↻**. **+ New event** is now at the far right.
- **Adding from the calendar.** Point at a day or lane and click its **+**. Clicking elsewhere no longer starts a new event.
- **Past events lock.** Once an approved event's date has passed, its details can't be changed and it can't be cancelled or deleted. Notes, sign-ups and Attendees still work.
- **Smaller fixes.** Venue type is a dropdown, the new-event form fits its content, icons name themselves when you point at them, and on wide screens Help sits beside the calendar instead of covering it.
```

- [ ] **Step 7: `CLAUDE.md`.**
  - In "How the app is built", after the Help drawer bullet, add:
```markdown
- **Tooltips**: any element with `data-tip` gets the shared bubble (`showTip`/`hideTip`) on hover and keyboard focus — use it, not `title=`, for icon buttons.
- **Calendar settings (⚙)**: `#ovfBtn` opens `#ovfPanel`, which holds the layer toggles (`#layers`, `renderLayers`) at every width; the year picker always stays in the header.
```
  - In the Status state machine bullet, add: `A past approved event (`isHistory`) locks Details and drops Cancel/Delete; other tabs are unaffected.`

- [ ] **Step 8: Check and commit**
```bash
node scripts/check-help.mjs && git add web/help/guide.md web/help/whats-new.md CLAUDE.md && git commit -m "docs(help): settings ⚙, + buttons, past-event lock, venue type dropdown"
```
Expected: `check-help: OK`. If a `[[…]]` label isn't found, the guard names it. Fix the wording to match the on-screen text.

### Task 9: Final verification and PR

- [ ] **Step 1:** `node --check web/app.js && (cd proxy && npm test) && node scripts/check-help.mjs && bash scripts/sync-shared.sh --check`. All pass.
- [ ] **Step 2:** Reload the preview with no identity. There should be no console errors after "Live reload enabled."
- [ ] **Step 3:** Re-run every task's final check at 1280px, 768px and 375px. Collect screenshots: Where card; create form; past-event Details; header tooltip; Help pushed; Calendar `+`; Overview `+`; ⚙ panel; phone header.
- [ ] **Step 4:** Ask for an independent review of `git diff main..HEAD` (`superpowers:code-reviewer`). Fix the findings, re-check.
- [ ] **Step 5:** Push and open the PR. The body lists the 8 items, the screenshots, and "Ticks the tooltip item in #26". `gh pr create` runs the help hook; it must pass.
