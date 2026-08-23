# Event Workspace + Feedback Board — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development (or executing-plans). Steps use `- [ ]` checkboxes.

**Goal:** Restructure the event editor into a section-model workspace (rail + panel) with **Planning** and **Publish** sections, split internal vs public description, add URL deep-linking, show a **Coming soon** roadmap, and ship a votable **Feedback/Ideas board** — all on branch `feat/eventbrite-publish`.

**Design:** `docs/superpowers/specs/2026-08-22-event-workspace-section-model-design.md`. **Tech:** buildless vanilla JS app (`web/`), Cloudflare Worker (`proxy/src/worker.js`, ESM), `node --test`.

**Coda ids (Task 1 DONE):** planning table `grid--gYIvdD-cE`; new cols `Public summary`=`c-z_vizJhFiU`, `Public description`=`c-FPf9UlI_8n`. `Roadmap Feedback` table `grid-pP5rwauO2j`: Idea `c-3myItiMQmp`, Context `c-pq5mI4E1hZ`, Submitted by `c-BXara71hR6`, Submitted at `c-QsGthfW_sY`, Voters `c-7rXn06fcLK`, Status `c-jNK0aRavfk`. People table `grid-X316Eql8dE`.

**Editor shell (web/index.html):** `#scrim > #modal > .mhead(#mStripe,#mTitle,#mActions,#mClose) + #mBody(.mbody) + #mFoot`. Header bar `.bar .bar-inner.row2` holds `#addBtn`/`#refreshBtn`.

---

## Task 2: App model — new description fields

**Files:** `web/app.js` (`planningRowToEvent` ~272, `eventToCodaCells` ~222).

- [ ] **Step 1:** In `planningRowToEvent`, after the `description:` line add:
```js
    publicSummary: v['Public summary'] || '',
    publicDescription: v['Public description'] || '',
```
- [ ] **Step 2:** In `eventToCodaCells`, add two cells:
```js
    {column:'Public summary',     value:e.publicSummary||''},
    {column:'Public description', value:e.publicDescription||''},
```
- [ ] **Step 3:** `node --check web/app.js`. Commit: `feat(app): model public summary/description fields`.

---

## Task 3: Section-model framework + Planning/Publish sections

**Files:** `web/app.js` (`openEditor` ~779 planning branch + wiring; `readForm` ~849), `web/styles.css`.

This refactors the flat planning editor body into a **section rail + panel**. Read the current planning branch of `openEditor` (the non-`isRef` path, ~line 805 through the wiring that ends before `readForm`) and `readForm()` before starting — you are MOVING existing markup/handlers into per-section functions, not rewriting them.

- [ ] **Step 1: Add the section registry** (top-level, near other consts):
```js
const SECTIONS = [
  { id:'planning', label:'Planning',            icon:'ti-clipboard-list', live:true },
  { id:'publish',  label:'Publish',             icon:'ti-external-link',  live:true },
  { id:'budget',    label:'Budget & expenses',   icon:'ti-receipt',        live:false },
  { id:'comms',     label:'Comms',               icon:'ti-speakerphone',   live:false },
  { id:'volunteers',label:'Volunteers & potluck',icon:'ti-users-group',    live:false },
  { id:'attendance',label:'Attendance',          icon:'ti-checkbox',       live:false },
  { id:'feedback',  label:'Feedback',            icon:'ti-message-heart',  live:false },
];
let activeSection = 'planning';
```
(There is no icon webfont loaded in this app — use short text/emoji-free glyph labels instead of `ti-` classes, or add a tiny inline SVG set. Simplest: render the label text only in the rail; drop the icon, or use a leading unicode dot. Keep it dependency-free.)

- [ ] **Step 2: Restructure the planning branch of `openEditor`.** Replace the single `body.innerHTML = <all fields>` with a **rail + panel** shell, then render the active section:
```js
  body.innerHTML = `
    <div class="wsplit">
      <nav class="wrail" id="wrail">${railHTML()}</nav>
      <div class="wpanel" id="wpanel"></div>
    </div>`;
  renderSection(activeSection, ev, canEdit, locked, canApprove);
  document.getElementById('wrail').addEventListener('click', e=>{
    const b=e.target.closest('[data-sect]'); if(!b) return;
    const id=b.dataset.sect; const sec=SECTIONS.find(s=>s.id===id);
    if(!sec || !sec.live){ renderSection(id, ev, canEdit, locked, canApprove); setActiveRail(id); return; } // coming-soon still renders its teaser
    activeSection=id; setActiveRail(id); renderSection(id, ev, canEdit, locked, canApprove); syncUrl(ev, id);
  });
```
- [ ] **Step 3: `railHTML()` + `setActiveRail()`:**
```js
function railHTML(){
  const live = SECTIONS.filter(s=>s.live), soon = SECTIONS.filter(s=>!s.live);
  const item = s=>`<button type="button" class="wrail-item${s.id===activeSection?' on':''}" data-sect="${s.id}">${esc(s.label)}</button>`;
  return live.map(item).join('') +
    `<div class="wrail-soon">Coming soon…</div>` +
    soon.map(s=>`<button type="button" class="wrail-item soon${s.id===activeSection?' on':''}" data-sect="${s.id}">${esc(s.label)}</button>`).join('');
}
function setActiveRail(id){ activeSection=id; document.querySelectorAll('#wrail .wrail-item').forEach(b=>b.classList.toggle('on', b.dataset.sect===id)); }
```
- [ ] **Step 4: `renderSection(id, ev, canEdit, locked, canApprove)`** dispatches into per-section render+wire, writing into `#wpanel`:
```js
function renderSection(id, ev, canEdit, locked, canApprove){
  const panel=document.getElementById('wpanel'); if(!panel) return;
  const sec=SECTIONS.find(s=>s.id===id);
  if(sec && !sec.live){ panel.innerHTML=comingSoonHTML(sec); wireFeedback(panel, id); return; }
  if(id==='publish'){ panel.innerHTML=renderPublish(ev, canEdit, locked); wirePublish(panel, ev, canEdit, locked); return; }
  panel.innerHTML=renderPlanning(ev, canEdit, locked, canApprove); wirePlanning(panel, ev, canEdit, locked, canApprove);
}
```
- [ ] **Step 5: `renderPlanning`/`wirePlanning`** — MOVE the existing planning fields here. `renderPlanning` returns the current planning-body markup **minus** Capacity, Address visibility, and the publish panel (those go to Publish), and with the **internal-description relabel**: change the description field's label from `Description <span class="hint">(public promo)</span>` to `Internal description <span class="hint">(planning copy — not shown publicly)</span>`. `wirePlanning` runs the existing post-render wiring (program chips, venue picker, leads/volunteers typeaheads, when-control, notes-doc handler, `f_addrvis` moves to publish). Keep `readForm()` working — it reads by element id, and those ids now live in whichever section is currently rendered; guard each `g('f_x')` for null (fields from a non-rendered section are absent). **Important:** `readForm` must not clobber fields whose inputs aren't currently in the DOM — for each field, fall back to `editing.<field>` when its input is absent (pattern already used for publish fields).
- [ ] **Step 6: `renderPublish`/`wirePublish`** — the Publish section. Gate: if `ev.status!=='approved'` show a notice ("Approve this event under Planning to publish"). Otherwise render: **Public summary** (`f_pubsummary`, maxlength 140), **Public description** (`f_pubdesc` textarea) with a **"Copy from internal"** button (`data-act="copy-internal"` → fills `f_pubdesc` from `editing.description`), **Capacity** (`f_capacity`), **Address on listing** (`f_addrvis`), and the existing **publish panel** (`publishPanelHTML(ev, canEdit)` + `wirePublishPanel`). `wirePublish` wires the copy-internal button, `f_addrvis` toggle, and the publish panel. Extend `readForm()` to read `publicSummary`/`publicDescription`/`capacity`/`addressVisibility` from these ids when present (else fall back to `editing.*`).
- [ ] **Step 7: `comingSoonHTML(sec)`** — teaser + feedback board placeholder:
```js
function comingSoonHTML(sec){
  return `<div class="soon-teaser"><div class="soon-h">${esc(sec.label)} — coming soon</div>
    <div class="hint">This is on our roadmap. Tell us what you'd want here, or +1 an idea below.</div>
    ${feedbackBoardHTML(sec.id)}</div>`;
}
```
(`feedbackBoardHTML`/`wireFeedback` come in Task 7; stub them to return '' / no-op until then so Task 3 checks pass.)
- [ ] **Step 8: Styles** (`web/styles.css`): `.wsplit{display:flex;gap:14px}` `.wrail{flex:0 0 168px;display:flex;flex-direction:column;gap:2px;border-right:.5px solid var(--hair);padding-right:10px}` `.wrail-item{text-align:left;background:none;border:0;padding:7px 9px;border-radius:7px;font:inherit;color:inherit;cursor:pointer}` `.wrail-item.on{background:var(--accent-tint,#eef);font-weight:500}` `.wrail-item.soon{color:var(--muted)}` `.wrail-soon{font-size:10px;color:var(--faint);padding:8px 9px 3px;letter-spacing:.04em}` `.wpanel{flex:1;min-width:0}`. Mobile (`@media(max-width:600px)`): `.wsplit{flex-direction:column}` `.wrail{flex-direction:row;overflow-x:auto;border-right:0;border-bottom:.5px solid var(--hair)}`.
- [ ] **Step 9:** `node --check web/app.js`. Manually confirm (browser, signed-out) the editor opens to Planning with the rail, coming-soon items are muted, and switching to a coming-soon item shows the teaser. Commit: `feat(app): section-model editor workspace (Planning/Publish + coming-soon rail)`.

---

## Task 4: URL deep-linking

**Files:** `web/app.js` (`openEditor`, `close` ~1029, `init`/load, section switch).

- [ ] **Step 1: `syncUrl(ev, section)`** and `clearUrl()`:
```js
function syncUrl(ev, section){ if(!ev||!ev.id) return; const u=new URL(location.href); u.searchParams.set('event', ev.id); u.searchParams.set('section', section||activeSection); history.replaceState(null,'',u); }
function clearUrl(){ const u=new URL(location.href); u.searchParams.delete('event'); u.searchParams.delete('section'); history.replaceState(null,'',u); }
```
- [ ] **Step 2:** Call `syncUrl(ev, activeSection)` at the end of `openEditor` (for saved events, `ev.id` present) and on section switch (Task 3 step 2 already calls it). In `close()`, call `clearUrl()`.
- [ ] **Step 3: Deep-link on load.** After events first load (end of `init`/`refresh` first paint), add:
```js
function openFromUrl(){ const p=new URL(location.href).searchParams; const id=p.get('event'); if(!id) return; const ev=state.events.find(x=>x.id===id); if(!ev) return; const sec=p.get('section'); if(sec && SECTIONS.some(s=>s.id===sec)) activeSection=sec; openEditor(ev); }
```
Call `openFromUrl()` once after the first successful events render.
- [ ] **Step 4: Copy link.** Add a small button to `#mActions` (or near `#mClose`) in `openEditor` for saved events: `<button class="btn sm" data-act="copylink" title="Copy link to this event">Copy link</button>`; handler copies `location.href` via `navigator.clipboard.writeText` + `toast('Link copied','ok')`.
- [ ] **Step 5:** `node --check`. Browser-verify: opening an event sets `?event=&section=`; switching sections updates it; `Copy link` works; loading `?event=<id>&section=publish` opens that event to Publish. Commit: `feat(app): URL deep-linking for events + sections`.

---

## Task 5: Publish route uses public copy + SC fixes

**Files:** `proxy/src/worker.js` (publish route ~step-4 SC block, and the `ev` builder), `proxy/src/eventbrite.js` (structuredContentBody), `proxy/test/eventbrite.test.js`.

- [ ] **Step 1 (TDD): update `structuredContentBody` for the required `alignment`.** Change the test to expect `alignment:'left'`, watch fail, then implement:
```js
export function structuredContentBody(html, versionToWrite) {
  return { publish: true, modules: [{ type: 'text', data: { body: { text: String(html || ''), alignment: 'left' } } }], _version: versionToWrite };
}
```
Update the existing SC test to assert `b.modules[0].data.body.alignment === 'left'`. Run `node --test` (green).
- [ ] **Step 2: Route reads public copy.** In the route's `ev` builder, add `publicSummary: V['Public summary'] || ''`, `publicDescription: V['Public description'] || ''`. Change:
  - the create/update payload summary source: `eventToEventbritePayload` currently derives summary from `ev.description`. Pass the public summary: set `ev.description` used for summary to `ev.publicSummary || ev.publicDescription || V['Event Description']`. Simplest: build `ev.summarySource = ev.publicSummary || ev.publicDescription || (V['Event Description']||'')` and have `eventToEventbritePayload` use `ev.publicSummary` if present else the stripped description. (Update `eventToEventbritePayload` to prefer `ev.publicSummary` for `summary` when non-empty; keep the ≤140 strip.)
  - the SC body source: `structuredContentBody(ev.publicDescription || V['Event Description'] || '', ver)` (public description, fallback to internal).
- [ ] **Step 3: SC version 0 for a brand-new description.** Replace `const ver = ((sc.body && sc.body.page_version_number) || 0) + 1;` with:
```js
const pv = sc.body && sc.body.page_version_number;
const ver = (typeof pv === 'number') ? pv + 1 : 0;   // brand-new description → version 0
```
- [ ] **Step 4:** Update `eventToEventbritePayload` (+ its test) to prefer `ev.publicSummary`:
```js
const summary = (ev.publicSummary && String(ev.publicSummary).slice(0,140)) || stripHtml(ev.description).slice(0,140);
```
Add a test: with `publicSummary` set, payload summary equals it (≤140).
- [ ] **Step 5:** `node --test` (green) + `node --check proxy/src/worker.js`. Commit: `feat(proxy): publish uses public summary/description; SC alignment + version-0 fixes`. Deploy is deferred to Task 8 verify.

---

## Task 6: Feedback Worker routes

**Files:** `proxy/src/worker.js` (new routes near `/me`; a `FEEDBACK_TABLE` const + config).

- [ ] **Step 1: Config.** `proxy/wrangler.toml` `[vars]`: `CODA_FEEDBACK_TABLE = "grid-pP5rwauO2j"`. In `worker.js` add `const PEOPLE_TABLE_ID='grid-X316Eql8dE';` if not already present (People table id is used by resolvePerson; reuse `PEOPLE_TABLE`).
- [ ] **Step 2: `GET /feedback[?context=]`** — list, auth-aware `votedByMe`:
```js
if (parts[0] === 'feedback' && parts.length===1 && request.method === 'GET') {
  const ft = env.CODA_FEEDBACK_TABLE; if (!ft) return json({ items: [] }, 200, cors);
  let me = null; try { me = await authIdentity(request, env, base, docId, auth); } catch(_){}
  const out = await readAllRows(`${base}/docs/${docId}/tables/${ft}/rows`, auth);
  if (!out.ok) return pass(out.resp, cors);
  const ctx = url.searchParams.get('context');
  const items = out.items.map(r => {
    const v = r.values || {};
    const voters = (v['Voters']==null||v['Voters']==='') ? [] : (Array.isArray(v['Voters'])?v['Voters']:[v['Voters']]);
    return { id: r.id, idea: v['Idea']||'', context: v['Context']||'General', submittedByName: (Array.isArray(v['Submitted by'])?v['Submitted by'][0]:v['Submitted by'])||'', votes: voters.length, votedByMe: !!(me && me.name && voters.map(String).includes(me.name)), status: v['Status']||'New' };
  }).filter(it => !ctx || it.context===ctx).sort((a,b)=> b.votes-a.votes);
  return json({ items }, 200, cors);
}
```
(Note: relation cells return **display names** with simpleWithArrays; `votedByMe` compares the caller's `name`. If name collisions are a concern, later switch to person-id matching — acceptable for v1.)
- [ ] **Step 3: `POST /feedback`** — submit (requires matched identity):
```js
if (parts[0] === 'feedback' && parts.length===1 && request.method === 'POST') {
  if (env.ALLOW_WRITES !== 'true') return json({ error: 'writes disabled' }, 403, cors);
  let id; try { id = await authIdentity(request, env, base, docId, auth); } catch(e){ return json({ error:'invalid token' },401,cors); }
  if (!id || !id.matched) return json({ error: 'sign in to submit' }, 403, cors);
  let b; try { b = JSON.parse((await request.text())||'{}'); } catch(e){ return json({ error:'bad body' },400,cors); }
  const idea = String(b.idea||'').trim(); if (!idea) return json({ error:'empty' },400,cors);
  const context = String(b.context||'General');
  const cells = [ {column:'Idea',value:idea},{column:'Context',value:context},{column:'Submitted by',value:[id.personId]},{column:'Submitted at',value:new Date().toISOString()},{column:'Status',value:'New'} ];
  const r = await fetch(`${base}/docs/${docId}/tables/${env.CODA_FEEDBACK_TABLE}/rows`, { method:'POST', headers:auth, body:JSON.stringify({rows:[{cells}]}) });
  return pass(r, cors);
}
```
- [ ] **Step 4: `POST /feedback/:id/vote`** — toggle the caller in Voters:
```js
if (parts[0] === 'feedback' && parts[2] === 'vote' && request.method === 'POST') {
  if (env.ALLOW_WRITES !== 'true') return json({ error:'writes disabled' },403,cors);
  let id; try { id = await authIdentity(request, env, base, docId, auth); } catch(e){ return json({ error:'invalid token' },401,cors); }
  if (!id || !id.matched) return json({ error:'sign in to vote' },403,cors);
  const fid = decodeURIComponent(parts[1]);
  const ft = env.CODA_FEEDBACK_TABLE;
  const one = await fetch(`${base}/docs/${docId}/tables/${ft}/rows/${encodeURIComponent(fid)}?useColumnNames=true&valueFormat=simpleWithArrays`, { headers: auth });
  if (!one.ok) return json({ error:'not found' },404,cors);
  const v = (await one.json()).values || {};
  // Voters come back as display names; to WRITE the relation we need row ids. Re-resolve
  // by reading current voter names and mapping our own person in/out. Simplest correct
  // approach: keep a parallel read of ids — but simpleWithArrays gives names only. So
  // toggle by NAME set on the client isn't id-safe. Instead: read voter names, compute
  // whether caller (id.name) is present, and write the Voters relation as the set of
  // person IDS. Since we only have names here, resolve names->ids via peopleRows.
  const names = (v['Voters']==null||v['Voters']==='')?[]:(Array.isArray(v['Voters'])?v['Voters']:[v['Voters']]).map(String);
  const rows = await peopleRows(base, docId, auth);
  const idByName = {}; for (const p of rows) { const nm=p.values['Full Name']; if(nm) idByName[nm]=p.id; }
  let ids = names.map(n=>idByName[n]).filter(Boolean);
  const mine = id.personId; const has = ids.includes(mine);
  ids = has ? ids.filter(x=>x!==mine) : ids.concat([mine]);
  const w = await fetch(`${base}/docs/${docId}/tables/${ft}/rows/${encodeURIComponent(fid)}`, { method:'PUT', headers:auth, body:JSON.stringify({row:{cells:[{column:'Voters',value:ids}]}}) });
  if (!w.ok) return pass(w, cors);
  return json({ votes: ids.length, votedByMe: !has }, 200, cors);
}
```
- [ ] **Step 5:** `node --check proxy/src/worker.js`. Commit: `feat(proxy): feedback board routes (GET/POST /feedback, vote toggle)`.

---

## Task 7: App feedback board component

**Files:** `web/app.js` (component + header CTA), `web/index.html` (header button), `web/styles.css`.

- [ ] **Step 1: DB methods:**
```js
  async listFeedback(context){ const q=context?`?context=${encodeURIComponent(context)}`:''; const r=await fetch(`${this.base}/feedback${q}`,{headers:{Authorization:`Bearer ${state.idToken||''}`}}); if(!r.ok) return []; return (await r.json()).items||[]; },
  async submitFeedback(idea, context){ const r=await fetch(`${this.base}/feedback`,{method:'POST',headers:this._wh(),body:JSON.stringify({idea,context})}); if(!r.ok) await this._fail(r); return true; },
  async voteFeedback(id){ const r=await fetch(`${this.base}/feedback/${encodeURIComponent(id)}/vote`,{method:'POST',headers:this._wh()}); const j=await r.json().catch(()=>({})); if(!r.ok){ const e=new Error(j.error||'vote failed'); e.status=r.status; throw e; } return j; },
```
- [ ] **Step 2: `feedbackBoardHTML(context)`** returns a container with a submit box + a list mount:
```js
function feedbackBoardHTML(context){
  const signedIn = !!(state.identity && state.identity.matched);
  return `<div class="fbboard" data-ctx="${context}">
    ${signedIn ? `<div class="fbform"><textarea class="fbtext" rows="2" placeholder="Suggest an idea…"></textarea><button type="button" class="btn sm primary" data-act="fb-submit">Submit</button></div>` : `<div class="hint">Sign in to add or +1 ideas.</div>`}
    <div class="fblist" aria-live="polite"><div class="hint">Loading ideas…</div></div>
  </div>`;
}
```
- [ ] **Step 3: `wireFeedback(root, context)`** — load list, submit, vote (delegated):
```js
async function wireFeedback(root, context){
  const board=root.querySelector('.fbboard'); if(!board) return;
  const list=board.querySelector('.fblist');
  const paint=(items)=>{ list.innerHTML = items.length ? items.map(it=>`<div class="fbitem"><button type="button" class="fbvote${it.votedByMe?' on':''}" data-vote="${it.id}" ${state.identity&&state.identity.matched?'':'disabled'}>▲ ${it.votes}</button><span class="fbidea">${esc(it.idea)}</span></div>`).join('') : `<div class="hint">No ideas yet — be the first.</div>`; };
  paint(await DB.listFeedback(context));
  board.addEventListener('click', async e=>{
    const sb=e.target.closest('[data-act="fb-submit"]');
    if(sb){ const ta=board.querySelector('.fbtext'); const val=ta.value.trim(); if(!val){ toast('Write an idea first','err'); return; } try{ await DB.submitFeedback(val, context); ta.value=''; paint(await DB.listFeedback(context)); toast('Idea submitted','ok'); }catch(err){ toast(err.message||'Submit failed','err'); } return; }
    const vb=e.target.closest('[data-vote]');
    if(vb){ try{ await DB.voteFeedback(vb.dataset.vote); paint(await DB.listFeedback(context)); }catch(err){ if(err.status===401&&typeof sessionExpired==='function') sessionExpired(); else toast(err.message||'Vote failed','err'); } }
  });
}
```
Call `wireFeedback(panel, id)` from `renderSection` for coming-soon sections (already in Task 3 step 4).
- [ ] **Step 4: Header "Feedback / Ideas" CTA.** In `web/index.html` `.bar-inner.row2`, before `#refreshBtn`, add `<button class="btn ghost" id="feedbackBtn">Feedback / Ideas</button>`. In `app.js`, wire it to open the existing modal shell with a general board:
```js
document.getElementById('feedbackBtn').addEventListener('click', ()=>{
  editing={id:'__feedback__'};
  document.getElementById('mStripe').style.setProperty('--c','var(--accent)');
  document.getElementById('mTitle').textContent='Feedback & ideas';
  document.getElementById('mActions').innerHTML=''; document.getElementById('mFoot').innerHTML=`<span class="push"></span><button class="btn" data-act="close">Close</button>`;
  const body=document.getElementById('mBody'); body.innerHTML=`<div class="fld full"><div class="hint">Suggest anything, or +1 an idea. For section-specific ideas, open an event and visit that section.</div>${feedbackBoardHTML('General')}</div>`;
  wireFeedback(body,'General'); show();
});
```
- [ ] **Step 5: Styles** (`web/styles.css`): `.fbboard{margin-top:10px}` `.fbform{display:flex;gap:8px;align-items:flex-start;margin-bottom:10px}` `.fbtext{flex:1}` `.fblist{display:flex;flex-direction:column;gap:6px}` `.fbitem{display:flex;gap:9px;align-items:center;font-size:13px}` `.fbvote{border:.5px solid var(--hair);border-radius:14px;padding:2px 9px;font:inherit;cursor:pointer;background:none;color:var(--muted);white-space:nowrap}` `.fbvote.on{background:var(--accent-tint,#eef);color:var(--accent);border-color:var(--accent)}` `.fbidea{flex:1}`.
- [ ] **Step 6:** `node --check web/app.js`. Commit: `feat(app): feedback/ideas board (header CTA + per-section, votable)`.

---

## Task 8: Deploy, verify end-to-end, docs

**Files:** none (verify) + `CLAUDE.md`.

- [ ] **Step 1:** Deploy proxy: `cd proxy && npx wrangler deploy`. (App is local for verification.)
- [ ] **Step 2:** Serve `web/` locally; signed-in (Eric) verify: editor opens with rail; Planning shows internal description (relabeled); Publish shows public summary/description + copy-from-internal + capacity/address + publish; a **draft publish** still works and now sends the public summary/description (check via the draft on Eventbrite + Publish Log).
- [ ] **Step 3:** URL: open an event → `?event&section` set; deep-link `?event=<id>&section=publish` opens to Publish; Copy link round-trips.
- [ ] **Step 4:** Feedback: submit a general idea via header CTA; open a coming-soon section, submit a section-tagged idea, +1 it (count changes, toggles), verify rows land in the `Roadmap Feedback` Coda table with the right Context + Submitted by.
- [ ] **Step 5:** Screenshot proof to the user.
- [ ] **Step 6:** `CLAUDE.md`: note the workspace/section model + feedback board + the new secrets/vars (`CODA_FEEDBACK_TABLE`). Commit. Then finishing-a-development-branch (PR).

---

## Self-Review
- **Spec coverage:** section model (T3), Planning/Publish split + internal/public description (T3,T5), URL deep-links (T4), coming-soon rail (T3), feedback board global+per-section+vote (T6,T7), SC fixes (T5). ✓
- **Placeholders:** icon webfont caveat flagged in T3 step 1 (use text labels — no icon lib in this app). Feedback `votedByMe`/vote uses display-name matching (v1 acceptable; id-matching is a noted later hardening).
- **Consistency:** new Coda cols/ids match T1; route reads `Public summary`/`Public description`; feedback routes use `grid-pP5rwauO2j` + `Voters` relation written as person ids (resolved via `peopleRows`). `readForm` null-guards fields from non-rendered sections.
