/* editor.js — the editor shell: stage badge, editorCtx, header meta, openEditor, the create flow and URL sync.
   Paints modal containers (ids in index.html): mStripe, mTitle, mTag, mSub, mBadges, mActions, mBody, mFoot.
   Owns: statusInfo, badgesHTML, isPastEvent, isHistory, venueRecord, editorCtx, _ctx, paintHeadMeta, clearHeadMeta, openEditor, openNewEventForm, createFromForm, clearUrl, openFromUrl
   Reads: state, _refsSettled (state.js); reference lists (data.js); _form (save.js)
   Writes: editing, activeSection (editor-tabs.js); _form (save.js); _menuOpen (footer.js); _ebBlock (transitions.js; reassigned); _pushChecks (eventbrite.js; Map .delete); owns _ctx, _creating
   Loaded after: preview.js (file-map order; calls renderSection, readForm at call time) */

/* ---- status state machine (draft → proposed → approved; bail → cancelled) ----
   Status stores 4 states; "Live" (approved + EB published) and "Past" (date has
   passed) are DERIVED for display, not stored. */
// The status label, from the same stage the footer's steps read (ListingRules.stageOf),
// so the header badge and the footer never disagree (R21).
const STAGE_BADGE = {
  cancelled:{label:'Cancelled', cls:'cancelled'}, published:{label:'Live', cls:'live'},
  onEventbrite:{label:'On Eventbrite', cls:'approved'}, approved:{label:'Approved', cls:'approved'},
  proposed:{label:'Proposed', cls:'proposed'}, draft:{label:'Draft', cls:'draft'},
};
function statusInfo(ev){ return STAGE_BADGE[ListingRules.stageOf(ev)] || STAGE_BADGE.draft; }
function badgesHTML(ev){
  const si=statusInfo(ev);
  let badges = `<button type="button" class="badge b-${si.cls} badge-btn" data-help="lifecycle" title="What does this mean?">${si.label}</button>`;
  if(isPastEvent(ev)) badges += `<span class="badge b-past">Past</span>`;
  return badges;
}
function isPastEvent(ev){ return ev.scheduling==='exact' && ev.date && ev.date < todayStr && ev.status!=='cancelled'; }
// An approved (or live) event whose date has passed: it happened, so its Details lock
// and it can't be cancelled or deleted (Notes, sign-ups and Attendees keep working).
function isHistory(ev){ return isPastEvent(ev) && ev.status==='approved'; }
const LINK_ICON = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>`;
const EXT_ICON = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>`;
const GATHER_BASE = 'https://gather.eastsidetribe.org/';   // member app; #/event/<rowId> deep-links (auth is per-origin, so no session hand-off)
// The venue record readiness checks against. null when the event has no listed venue.
function venueRecord(ev){
  const v = ev && ev.venueName ? VENUES.find(x=>x.name===ev.venueName) : null;
  return v ? { name:v.name, type:v.type||'', hasAddress:!!v.hasAddress } : null;
}
// One context object per open editor (D2): who may do what, and where the event is.
// (No `stage`: the footer reads stageOf live, since publish status can change while open.)
// `locked` = Cancelled only — leads keep editing after approval (decision 5); a past
// approved event's Details lock separately through `past`.
function editorCtx(ev){
  const isRef = ev.source==='ref';
  return {
    ev,
    role:{ canEdit: !isRef && !!(state.identity && state.identity.canWrite),
           canApprove: !isRef && !!(state.identity && state.identity.canApprove) },
    past: !isRef && isHistory(ev),
    locked: !isRef && ev.status==='cancelled',
  };
}
let _ctx=null;   // the open workspace editor's ctx (renderEditorFooter reads it)
// Header (R23): the title, a tag for the first program in its own color (+N for
// more) and, under it, the first line of the internal description. Reads the form, so it
// follows edits as they're typed; fields on other tabs fall back to the event.
function paintHeadMeta(){
  const tagEl=document.getElementById('mTag'), subEl=document.getElementById('mSub');
  if(!tagEl || !subEl || !editing || !_ctx || _ctx.ev!==editing) return;
  const f=readForm();
  document.getElementById('mTitle').textContent = f.title || 'Untitled';
  document.getElementById('mStripe').style.setProperty('--c', progColor(f.program));
  const t=EditorHead.programTag(f.programs, PROG);
  const more = t && t.more>0 ? `<span class="ptag-more" data-tip="${esc(f.programs.map(id=>(PROG[id]||{}).name).filter(Boolean).join(', '))}">+${t.more}</span>` : '';
  paintInner(tagEl, t ? `<span class="ptag" style="--c:${esc(t.color)}">${esc(t.name)}</span>${more}` : '');
  const sub=EditorHead.subtitle(f.description);
  subEl.textContent=sub; subEl.hidden=!sub;
}
function clearHeadMeta(){
  const tagEl=document.getElementById('mTag'), subEl=document.getElementById('mSub');
  if(tagEl) paintInner(tagEl, '');
  if(subEl){ subEl.textContent=''; subEl.hidden=true; }
}
function openEditor(ev, section){
  if(String(ev.id||'').startsWith('tmp-')){ toast('Still creating this event — try again in a moment'); return; }   // no row to save into yet
  if(editing && editing!==ev && leaveGuard(()=>openEditor(ev, section))) return;   // switching away from a linked event with unpushed edits
  hideLeaveGuard(); closePreview();
  _pushChecks.delete(ev.id);   // the Worker's last "needs X" answer doesn't outlive the editor
  leaveForm();   // leaving an open editor (or rebuilding this one): queue its unsaved edits first
  if(_ebBlock && _ebBlock.id!==ev.id) _ebBlock=null;   // the Eventbrite-cancel bar belongs to the event it was shown for
  editing = ev;
  paintEbBlock();
  _menuOpen = false;
  section = sectionId(section);
  activeSection = (section && SECTIONS.some(s=>s.id===section)) ? section : 'details';   // reset per open; honor a deep-linked section
  const isRef = ev.source==='ref';
  const ctx = editorCtx(ev);
  const { canEdit } = ctx.role;
  const locked = ctx.locked;        // Cancelled: read-only until Council reopens it
  const pastLocked = ctx.past;      // Details only — see renderSection
  _ctx = isRef ? null : ctx;
  // First visit: the reference lists may still be loading. Wait for them rather than
  // offer relation pickers that could save a partial Program(s)/Leads/Venue.
  if(!isRef && ev._lossy) mapRelations(ev);
  if(!isRef && canEdit && !locked && !pastLocked && !relationsReady(ev) && !_refsSettled){
    showModalLoading(ev.title||'Untitled', progColor(ev.program));
    afterRefs(()=>{ if(editing===ev) openEditor(ev, section); });   // try again as each list lands
    return;
  }
  const c = isRef ? cssColor(REF[ev.refLayer].color, 'var(--faint)') : progColor(ev.program);
  document.getElementById('mStripe').style.setProperty('--c',c);
  document.getElementById('mTitle').textContent = isRef ? 'Reference event' : (ev.id ? (ev.title||'Untitled') : 'New event');
  const actions=document.getElementById('mActions');
  const body=document.getElementById('mBody');
  document.getElementById('modal').classList.remove('ws','create'); body.classList.remove('ws');   // workspace mode only for the planning editor
  clearHeadMeta();
  if(isRef){
    const R = REF[ev.refLayer] || {name:'Reference', color:'#888'};
    document.getElementById('mBadges').innerHTML = `<span class="badge b-ref">${esc(R.name)}</span>`;
    actions.innerHTML = '';
    const when = ev.allDay ? `All day · ${fmtDate(ev.date)}` : fmtDateTimeRange(ev.start, ev.end);
    body.innerHTML = `
      <div class="fld full"><label>Title</label><input value="${esc(ev.title)}" disabled></div>
      <div class="fld full"><label>When</label><input value="${esc(when)}" disabled></div>
      ${ev.location ? `<div class="fld full"><label>Location</label><input value="${esc(ev.location)}" disabled></div>` : ''}
      ${ev.description ? `<div class="fld full"><label>Description</label><div class="refdesc">${linkify(ev.description)}</div></div>` : ''}
      ${ev.url ? `<div class="fld full"><a class="reflink" href="${esc(ev.url)}" target="_blank" rel="noopener">Open event ↗</a></div>` : ''}
      <div class="fld full"><label>Calendar</label><input value="${esc(R.name)}" disabled></div>
      <div class="locknote">Read-only reference calendar. To hide this layer, turn it off under ${PHONE_MQ.matches?'☰ (the menu)':'⚙'} at the top.</div>`;
    document.getElementById('mFoot').innerHTML=`<span class="push"></span><button class="btn" data-act="close">Close</button>`;
    show(); return;
  }

  // header: title + program tag, the notes subtitle under them (paintHeadMeta), then
  // on the right the derived status badge (a button that opens the lifecycle guide;
  // transitions live in the footer) and the icons — ? (help for the active tab),
  // view-in-gather, copy-link.
  paintInner(document.getElementById('mBadges'), badgesHTML(ev));
  let head = `<button type="button" class="mhead-ico q" data-act="help" data-tip="Help for this tab" aria-label="Help for this tab">?</button>`;
  if(ev.id) head += `<a class="mhead-ico" href="${esc(GATHER_BASE)}#/event/${encodeURIComponent(ev.id)}" target="_blank" rel="noopener" data-tip="View in gather" aria-label="View in gather">${EXT_ICON}</a>`;
  if(ev.id) head += `<button class="mhead-ico" data-act="copylink" data-tip="Copy link" aria-label="Copy link">${LINK_ICON}</button>`;
  actions.innerHTML = head;

  // footer wizard (spec 5.5, R21): stable containers filled by renderEditorFooter (D1) —
  // row 1 #edSteps = the five steps, full width; row 2 #edFoot = what's next, the
  // save pill (only for a failed save), #edActs = the one primary action, #edMenu = ⋮.
  // Dismissal is the header ✕/Esc/scrim.
  const pill = (ev.id && canEdit && !locked && !pastLocked) ? `<span class="savestat clean" id="saveStatus" role="status"></span>` : '';
  document.getElementById('mFoot').innerHTML = `<div class="edsteps" id="edSteps"></div><div class="edmsg" id="edFoot"></div>${pill}<div class="edacts" id="edActs"></div><div class="kbwrap" id="edMenu"></div>`;

  // workspace: left rail + active-section panel (fixed-height modal; only the panel scrolls)
  document.getElementById('modal').classList.add('ws'); body.classList.add('ws');
  body.innerHTML = `<div class="wsplit"><nav class="wrail" id="wrail">${railHTML()}</nav><div class="wpanel" id="wpanel"></div></div>`;
  wireScrollFade(document.getElementById('wrail'));   // edge-fade hint when tabs overflow (mobile horizontal rail)
  renderSection(activeSection, ctx);
  document.getElementById('wrail').addEventListener('click', e=>{
    const b=e.target.closest('[data-sect]'); if(!b) return;
    const id=b.dataset.sect; if(id===activeSection) return;
    if(_form) autosaveEditor();   // save the outgoing section's edits before its fields leave the DOM
    setActiveRail(id); renderSection(id, ctx);
    renderEditorFooter();         // the wizard shows on Details only; other tabs get their one line + ⋮
    // The new section can render stored values in a normalized form (e.g. program
    // order) — that isn't an edit, so it becomes the baseline.
    if(_form && _form.ev===ev){ _form.base = formCells(readForm()); applyListingAddressDefault(); }
    const sec=SECTIONS.find(s=>s.id===id); if(sec && sec.live && typeof syncUrl==='function') syncUrl(ev, id);
  });

  show();
  if(ev.id) syncUrl(ev, activeSection);
  if(canEdit && !locked && !pastLocked && ev.id){
    _form = { ev, base: formCells(readForm()) };   // what's saved or already queued — autosave sends only what differs from it
    guardUnload();
    paintSaveStatus();                   // reopened mid-save: Saving… / Save failed — retry
    document.getElementById('wpanel').addEventListener('focusout', ()=>scheduleAutosave());
    applyListingAddressDefault();
  }
  renderEditorFooter();
  paintHeadMeta();
  if(canEdit && ev.eventbriteId) refreshEbStatus(ev);   // registrants + edited-on-Eventbrite, for the footer and card
}
// Placeholder while the reference lists load (a first visit only — see relationsReady).
function showModalLoading(title, color){
  document.getElementById('mStripe').style.setProperty('--c', color);
  document.getElementById('mTitle').textContent = title;
  document.getElementById('mBadges').innerHTML=''; document.getElementById('mActions').innerHTML=''; clearHeadMeta();
  document.getElementById('modal').classList.remove('ws','create');
  const body=document.getElementById('mBody'); body.classList.remove('ws');
  body.innerHTML=`<div class="ndoc-loading"><span class="ndoc-spin"></span> Loading…</div>`;
  document.getElementById('mFoot').innerHTML='';
  show();
}

/* ---- create flow: a one-shot Planning form in its OWN compact modal ---------
   A brand-new event is NOT the workspace — just the Planning fields with a clear
   Cancel / Create. On Create it persists once (no premature empty rows) and
   transitions into the full workspace via openEditor(savedEvent). */
function openNewEventForm(seed){
  if(!(state.identity && state.identity.canWrite)){ toast('Sign in as a program lead to add events','err'); return; }
  if(leaveGuard(()=>openNewEventForm(seed))) return;
  leaveForm();
  editing = seed;
  if(!relationsReady(seed) && !_refsSettled){   // first visit: the pickers need the reference lists
    showModalLoading('New event', progColor(seed.program));
    afterRefs(()=>{ if(editing===seed) openNewEventForm(seed); });
    return;
  }
  document.getElementById('mStripe').style.setProperty('--c', progColor(seed.program));
  document.getElementById('mTitle').textContent = 'New event';
  document.getElementById('mBadges').innerHTML=''; clearHeadMeta();   // no status/approve until the row exists
  document.getElementById('mActions').innerHTML = `<button type="button" class="mhead-ico q" data-help="add-event" data-tip="Help: adding an event" aria-label="Help: adding an event">?</button>`;
  document.getElementById('modal').classList.remove('ws'); document.getElementById('modal').classList.add('create');   // fixed shell = same height as the workspace
  const body=document.getElementById('mBody'); body.classList.remove('ws');
  body.innerHTML = renderPlanning(seed, true, false, false);
  wirePlanning(body, seed, true, false, false);
  document.getElementById('mFoot').innerHTML =
    `<span class="push"></span><button class="btn" data-act="close">Cancel</button><button class="btn primary" data-act="create">Create</button>`;
  show();
  const t=document.getElementById('f_title'); if(t) t.focus();
}
let _creating=false;
async function createFromForm(){
  if(_creating) return;
  const seed=editing;   // the create form — land in the new event only if that's still what's open
  const f=readForm();
  const me=(state.identity && state.identity.name) || '';
  const e=Object.assign({}, {source:'planning', eventbriteUrl:'', gcalId:'', createdBy:me, editedBy:me}, f);
  e.id='tmp-'+Date.now();
  _creating=true; applyLocal(e); rerender(); toast('Creating…','busy');
  try{
    const saved=await DB.create(e);
    if(saved && saved.id && saved.id!==e.id){ applyLocal(e, true); e.id=saved.id; applyLocal(e); }  // swap temp → real id
    // Not awaited: the workspace opens now, and its pill/footer read pendingFor(e.id)
    // until Coda has applied the insert.
    if(!String(e.id).startsWith('tmp-')) trackCreate(e.id, e._requestId);
    markRecent(e.id, {e}); rerender(); toast('Created','ok'); scheduleReconcile();
    _creating=false;
    if(editing===seed){   // land in the workspace for the just-created event
      if(String(e.id).startsWith('tmp-')) close();   // no row id came back — it appears on the next refresh; don't invite a second Create
      else openEditor(e);
    }
  }catch(err){
    applyLocal(e, true); rerender(); _creating=false;
    if(err && err.status===401) sessionExpired();
    else toast('Create failed — try again','err');   // leave the create modal open; input is preserved
  }
}

/* ---- URL deep-linking: ?event=<rowId>&section=<id>, two-way synced ---------- */
function syncUrl(ev, section){
  if(!ev || !ev.id) return;
  const u=new URL(location.href);
  u.searchParams.set('event', ev.id); u.searchParams.set('section', section||activeSection);
  history.replaceState(null,'',u);
}
function clearUrl(){
  const u=new URL(location.href);
  if(!u.searchParams.has('event') && !u.searchParams.has('section')) return;
  u.searchParams.delete('event'); u.searchParams.delete('section');
  history.replaceState(null,'',u);
}
// Open the event named in the URL (once events are loaded). Silent if absent.
function openFromUrl(){
  const p=new URL(location.href).searchParams;
  const id=p.get('event'); if(!id) return;
  if(editing && editing.id===id) return;   // already open (e.g. from the cached calendar) — don't rebuild it under the user
  const ev=state.events.find(x=>x.id===id); if(!ev) return;
  openEditor(ev, sectionId(p.get('section')||'details'));
}
