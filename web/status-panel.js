/* status-panel.js — the event page's Status & next step panel: ListingRules.footerModel painted into stable containers, the ⋮ menu, field focus.
   Owns: _menuOpen, editorFooterModel, paintInner, statusPanelHTML, renderStatusPanel, kebabMenu, toggleSteps, epLayout, placePhoneBar, layoutEventPage, focusField
   Reads: editing, activeSection (editor-tabs.js); _ctx, pageOpen (editor.js); PageRules (page-rules.js); layoutSticky (shell.js; at call time);
          _busy, _busyLabel, _slow (save.js); _ebStatus, _pushChecks, _pushing, _sending, _justChanged, _conflictShown, ebConflict, EB_CONFLICT_NOTICE (eventbrite.js);
          paintFieldMarks (field-markers.js; call time); headMenu (editor-close.js; call time); badgesHTML (editor.js; call time)
   Writes: _conflictShown (eventbrite.js; add/delete)
   Loaded after: save.js (file-map order; no load-time dependency) */

/* ---- Status & next step (spec 5.3; D1 stable containers, D6 pure model) -----
   ListingRules.footerModel decides everything; this only paints it. The panel shows
   on every tab. Called on open, on a tab switch and whenever the save state
   repaints, so the primary slot follows pendingFor: "Saving…" (disabled) until
   every queued edit is applied. */
const KEBAB_ICON = `<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="12" cy="5" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="12" cy="19" r="1.8"/></svg>`;
const SPIN_ICON = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-6.2-8.6"/></svg>`;
let _menuOpen=false;
function editorFooterModel(ev, ctx){
  const R=ListingRules, st=_ebStatus.get(ev.id), wc=_pushChecks.get(ev.id);
  const local=R.readiness(ev, { venue: venueRecord(ev), todayISO: todayStr });
  const input={
    stage: R.stageOf(ev),          // live: publish status can change while the editor is open
    past: ctx.past,
    role: ctx.role,
    checks: mergePushChecks(local, wc),
    pending: pendingFor(ev.id) || _pushing.has(ev.id),   // a push under way holds the primary at Saving…
    sending: _sending.has(ev.id),                        // …then Sending to Eventbrite… during the Worker call
    busy: _busy.has(ev.id) ? (_busyLabel.get(ev.id) || true) : null,   // a transition/cancel/delete in flight
    slow: _slow.has(ev.id),                              // past CodaApplied's slow mark: "Still saving…"
    unpushed: R.unpushedFields(ev, ev.pushed || null),
    pushed: ev.pushed || null,     // null: pushed before the snapshot existed — offer the update (not compared)
    ebEditedElsewhere: ebConflict(ev.id),
    registrants: st && st.sold!=null ? Number(st.sold) : null,   // null until the live status loads
    capacity: ebCapacity(ev),
    proposedBy: null,              // the row doesn't record who proposed it (Edited by changes on every edit)
    justChanged: _justChanged.get(ev.id) || null,
  };
  const m=R.footerModel(input);
  // The Worker's "needs X" (a 409) shows as links and field tags until the next
  // edit, but doesn't lock the button: after a stale read the same click can
  // succeed, and there may be nothing left to edit.
  if(wc && m.primary && m.primary.act){
    const ml=R.footerModel(Object.assign({}, input, { checks: local }));
    if(ml.primary && ml.primary.act===m.primary.act) m.primary.enabled=ml.primary.enabled;
  }
  // Who/when under each lifecycle step (spec 5.5): only what the row records.
  const cap=Number(input.capacity);
  m.stepNotes=PageRules.stepNotes(ev, { fmtDate, registrants: input.registrants, capacity: cap>0 ? cap : null });
  return m;
}
// The five lifecycle steps, top to bottom: done ✓, current, to do. Done and current
// steps carry their who/when note. Nothing when the stage has no step (Cancelled:
// the title says so).
const STEP_STATE_TEXT = { done:'Done', current:'Current step', todo:'To do' };
function checklistStepsHTML(m, notes){
  const cur=m.steps.findIndex(s=>s.state==='current');
  if(cur<0) return '';
  const last=m.steps.length-1;
  return m.steps.map((s,i)=>{
    const note = s.state!=='todo' && notes && notes[i] ? `<span class="sp-note">${esc(notes[i])}</span>` : '';
    const tone = s.state==='current' && i===last ? ' g' : '';
    return `<li class="sp-step ${s.state}${tone}"${s.state==='current'?' aria-current="step"':''}><span class="sp-dot" aria-hidden="true">${s.state==='done'?'✓':''}</span>`
      + `<span class="sp-lbl"><span class="sr">${STEP_STATE_TEXT[s.state]}: </span>${esc(s.label)}</span>${note}</li>`;
  }).join('');
}
// The next step: the model's title, then the readiness rows for the next push. A
// failing row is a link to its field (focusField switches tabs first); a passing
// row shows its label. (Phones, collapsed: CSS shows only the first failing row.)
function nextStepHTML(m){
  const rows = (m.checklist||[]).map(r=> r.ok
    ? `<li class="ok"><span class="sp-ic" aria-hidden="true">✓</span><span>${esc(r.label)}</span></li>`
    : `<li class="bad"><span class="sp-ic" aria-hidden="true">✗</span><a href="#" data-focus-field="${esc(r.field)}">${esc(r.message)}</a></li>`).join('');
  return `${m.title?`<b class="sp-title">${esc(m.title)}</b>`:''}${rows?`<ul class="sp-rows" aria-label="Ready for the next step">${rows}</ul>`:''}`;
}
function footerActsHTML(m){
  let h='';
  if(m.secondary) h += `<button type="button" class="btn fbtn sec" data-act="${esc(m.secondary.act)}"${m.busy?' disabled':''}>${esc(m.secondary.label)}</button>`;
  const p=m.primary;
  // The model's quiet "✓ Saved" isn't shown (R21): when nothing is saving, it's saved.
  if(p && p.tone!=='quiet'){
    // In flight ("Saving…", "Sending to Eventbrite…"): aria-disabled, not disabled, so
    // its tip still shows on hover; it has no data-act, so a click does nothing.
    const wait = !p.act && !p.enabled;
    const off = wait ? ' aria-disabled="true"' : p.enabled ? '' : ' disabled';
    const tip = p.tip ? ` data-tip="${esc(p.tip)}"` : '';
    h += `<button type="button" class="btn fbtn ${p.tone==='go'?'go':'primary'}${wait?' wait':''}"${p.act?` data-act="${esc(p.act)}"`:''}${off}${tip}>${wait?SPIN_ICON:''}${esc(p.label)}</button>`;
  }
  return h;
}
// The ⋮ menu has its own container (#edMenu): primary repaints never touch it, and it
// is rebuilt (closed) only when its items change. Open/close just flips attributes.
function footerMenuHTML(menu, busy){
  if(!menu.length) return '';
  // While a step is under way (busy), ⋮ is disabled: nothing else may start meanwhile.
  return `<button type="button" class="kb" data-act="menu" aria-label="More actions" data-tip="More actions" aria-haspopup="menu" aria-expanded="false"${busy?' disabled':''}>${KEBAB_ICON}</button>`
    + `<div class="kmenu" role="menu" aria-label="More actions" hidden>${menu.map(it=>
      `<button type="button" class="mi${it.tone==='danger'?' danger':''}" role="menuitem" tabindex="-1" data-act="${esc(it.act)}"><b>${esc(it.label)}</b>${it.sub?`<span>${esc(it.sub)}</span>`:''}</button>`).join('')}</div>`;
}
// Write a container's inner HTML only when it changed (the last write is cached on the
// element): the pill repaints often, and a rewrite would drop focus.
function paintInner(el, html){ if(el._html!==html){ el.innerHTML=html; el._html=html; return true; } return false; }
// The panel's stable containers (D1), built once per open (spec 5.3, top to bottom):
// the Status & next step card — #edStatus steps, #edChecks title + readiness rows,
// #edActs primary + #edMenu ⋮, #edSub one sentence, #edBars the registrant/
// Eventbrite-cancel bar, #listingCard the listing row (badge, Preview listing, View on
// Eventbrite, tickets; listingCardHTML) — then the save pill (a failed save only).
// The phone layout (spec 5.6; epLayout()==='phone') restyles the same card, one model →
// one paint: CSS puts it above the tab strip and orders it title + first failing row
// (#edChecks), the "Step N of 5 · see all steps" toggle (#edMore, toggleSteps), then the
// step list (#edStatus, collapsed until toggled), #edSub, #edBars and the listing row;
// placePhoneBar moves #edActs and #edMenu into the sticky bottom bar (#epPhoneBar).
function statusPanelHTML(withPill){
  return `<section class="sp-card" aria-labelledby="spHead"><h2 class="sp-h" id="spHead">Status & next step</h2>`
    + `<ol class="sp-steps" id="edStatus"></ol><div class="sp-checks" id="edChecks"></div>`
    + `<button type="button" class="sp-more" id="edMore" aria-expanded="false" aria-controls="edStatus"></button>`
    + `<div class="sp-acts"><div class="edacts" id="edActs"></div><div class="kbwrap" id="edMenu"></div></div>`
    + `<p class="sp-sub" id="edSub"></p><div class="sp-bars" id="edBars"></div><div class="sp-listing" id="listingCard"></div></section>`
    + (withPill ? `<span class="savestat clean" id="saveStatus" role="status"></span>` : '');
}
// Listing's red dot: a readiness item for the next step is a field on Listing.
const TAB_DOT = `<span class="tab-dot" role="img" aria-label="Needs attention"></span>`;
function renderStatusPanel(){
  const actEl=document.getElementById('edActs'), menuEl=document.getElementById('edMenu');
  if(!actEl || !menuEl || !_ctx || !editing || _ctx.ev!==editing) return;
  const m=editorFooterModel(editing, _ctx);
  paintInner(document.getElementById('edStatus'), checklistStepsHTML(m, m.stepNotes));
  paintInner(document.getElementById('edChecks'), nextStepHTML(m));
  paintInner(document.getElementById('edSub'), m.sub ? esc(m.sub) : '');
  const cur=m.steps.findIndex(s=>s.state==='current');   // phones' toggle; none when the stage has no step (Cancelled)
  paintInner(document.getElementById('edMore'), cur<0 ? '' : `Step ${cur+1} of ${m.steps.length} · see all steps <span class="sp-chev" aria-hidden="true">▾</span>`);
  const bEl=document.getElementById('epBadges'); if(bEl) paintInner(bEl, badgesHTML(editing));   // the badge follows the same stage
  paintInner(actEl, footerActsHTML(m));
  if(paintInner(menuEl, footerMenuHTML(m.menu, m.busy))) _menuOpen=false;   // items changed: it's a new (closed) menu
  paintEbBlock();
  const dot=document.querySelector('#epTabs [data-dot="details"]');
  if(dot) paintInner(dot, m.links.some(l=>l.field && (FIELD_SECTION[l.field] || 'details')==='details') ? TAB_DOT : '');
  paintFieldMarks();   // field markers/tags and the listing row follow the same event state
  // D8: the next push may overwrite Eventbrite's edits only once the conflict notice
  // was really on screen: the card's sentence (#edSub) is its one place, at every width.
  const ev=editing;
  if(!ev.eventbriteId || !ebConflict(ev.id)) _conflictShown.delete(ev.id);
  else if((m.sub||'').includes(EB_CONFLICT_NOTICE)) _conflictShown.add(ev.id);
}
// Phones: "Step N of 5 · see all steps" shows or hides the step list inline. The
// state lives on the card (class + aria-expanded), so it resets when the panel is
// rebuilt on open.
function toggleSteps(){
  const btn=document.getElementById('edMore'), card=btn && btn.closest('.sp-card'); if(!card) return;
  const open=!card.classList.contains('open');
  card.classList.toggle('open', open); btn.setAttribute('aria-expanded', String(open));
}
// One set of ids: on phones #edActs and #edMenu (moved, not copied) live in the sticky
// bottom bar (#epPhoneBar); above 600px, in the card's actions row. Their paint caches
// stay valid (a move doesn't change their inner HTML). A rebuilt panel's new pair
// replaces whatever the bar still holds; no panel (loading) empties the bar.
function placePhoneBar(){
  const bar=document.getElementById('epPhoneBar'); if(!bar) return;
  const home=document.querySelector('#epPanel .sp-acts');
  const acts=home && home.querySelector('#edActs');
  if(acts || !home) bar.replaceChildren();   // drop a previous build's pair
  if(!home) return;
  const a=acts || bar.querySelector('#edActs'), k=home.querySelector('#edMenu') || bar.querySelector('#edMenu');
  if(!a || !k) return;
  const to = epLayout()==='phone' ? bar : home;
  if(a.parentNode!==to) to.append(a, k);
}
// The event page's layout — 'wide' (tab list | main | panel), 'mid' (tab strip, then
// main | panel) or 'phone' (status card, tab strip, the tab, bottom bar) — is decided
// by CSS container queries on the page's own width (styles.css → "event page
// layouts", the one place the numbers live), so Help open beside the page counts. JS
// reads the answer back from --ep-layout rather than repeating the numbers.
function epLayout(){
  const g=document.querySelector('#eventPage .ep-grid');
  return (g && getComputedStyle(g).getPropertyValue('--ep-layout').trim()) || 'wide';
}
// The open page across a layout line (rotation, a resized window, Help opening): the
// bar's buttons change homes, the sticky offsets are re-measured, then a repaint.
function layoutEventPage(){
  if(!pageOpen() || !editing || !_ctx || _ctx.ev!==editing) return;
  kebabMenu(false); headMenu(false);
  placePhoneBar();
  layoutSticky();
  renderStatusPanel();
}
let _epLayoutSeen='';
new ResizeObserver(()=>{
  if(!pageOpen()) return;
  const l=epLayout(); if(l===_epLayoutSeen) return;
  _epLayoutSeen=l; layoutEventPage();
}).observe(document.getElementById('eventPage'));
function kebabMenu(open, focusFirst){
  const wrap=document.getElementById('edMenu'), btn=wrap && wrap.querySelector('.kb'), menu=wrap && wrap.querySelector('.kmenu');
  if(!btn || !menu){ _menuOpen=false; return; }
  _menuOpen=!!open;
  menu.hidden=!open; btn.setAttribute('aria-expanded', String(!!open)); btn.classList.toggle('on', !!open);
  if(open){ hideTip(); if(focusFirst){ const f=menu.querySelector('[role="menuitem"]'); if(f) f.focus(); } }
}
// Readiness links name a field that blocks the next step: bring it into view and focus it.
const FOCUS_FIELD_EL = { title:'f_title', description:'f_desc', programs:'f_progs', leads:'f_leads', date:'f_date', start:'f_start', end:'f_end',
  venue:'f_venue_box', capacity:'f_capacity', publicSummary:'f_pubsummary', publicDescription:'f_pubdesc', addressVisibility:'f_addrvis' };
// The tab each field lives on (anything not listed is on Listing, id 'details').
const FIELD_SECTION = { description:'planning', programs:'planning', leads:'planning' };
function focusField(field){
  const sec=FIELD_SECTION[field] || 'details';
  if(sec!==activeSection){ const b=document.querySelector(`#epTabs [data-sect="${sec}"]`); if(b) b.click(); }   // the tab list's own switch: autosave, render, panel, URL
  let el=document.getElementById(FOCUS_FIELD_EL[field]||'');
  if(!el && (field==='date' || field==='start' || field==='end')) el=document.getElementById('f_when');   // not an exact date yet
  if(!el) return;
  el.scrollIntoView({ block:'center', behavior:'smooth' });
  const target = el.matches('input,select,textarea,button') ? el : el.querySelector('input:not([disabled]),select,textarea,button:not([disabled])');
  if(target) target.focus({ preventScroll:true });
}
