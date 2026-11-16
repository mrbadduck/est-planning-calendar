/* footer.js — the editor footer wizard: ListingRules.footerModel painted into stable containers, the ⋮ menu, field focus.
   Owns: _menuOpen, editorFooterModel, paintInner, renderEditorFooter, kebabMenu, focusField
   Reads: editing, activeSection, SECTIONS (editor-tabs.js); _ctx (editor.js); state (state.js);
          _busy, _busyLabel, _slow (save.js); _ebStatus, _pushChecks, _pushing, _sending, _justChanged (eventbrite.js)
   Writes: nothing
   Loaded after: save.js (file-map order; no load-time dependency) */

/* ---- footer wizard (spec 5.5; D1 stable containers, D6 pure model) ----------
   ListingRules.footerModel decides everything; this only paints it. Called on open,
   on a tab switch and whenever the save pill repaints, so the primary slot follows
   pendingFor: "Saving…" (disabled) until every queued edit is applied. */
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
  return m;
}
function footerStepsHTML(m){
  const cur=m.steps.findIndex(s=>s.state==='current');
  let steps='';
  if(cur>=0){
    const last=m.steps.length-1;
    const dots=m.steps.map((s,i)=>{
      const ln = i ? `<span class="ln${s.state!=='todo'?' d':''}"></span>` : '';
      const tone = s.state==='current' && i===last ? ' g' : '';
      return `${ln}<span class="dot ${s.state}${tone}"></span><span class="${s.state==='current'?'cur'+tone:''}">${esc(s.label)}</span>`;
    }).join('');
    steps = `<div class="fsteps" aria-label="Step ${cur+1} of ${m.steps.length}: ${esc(m.steps[cur].label)}">${dots}</div>`
      + `<div class="fsteps-ph" aria-hidden="true">Step ${cur+1} of ${m.steps.length} · ${esc(m.steps[cur].label)}</div>`;
  }
  return steps;
}
function footerMsgHTML(m){
  const links = m.links.length ? `<span class="fsub flinks">${m.links.map(l=>
    l.field ? `<a href="#" data-focus-field="${esc(l.field)}">${esc(l.label)}</a>` : esc(l.label)).join(' · ')}</span>` : '';
  return `${m.title?`<b class="ftitle">${esc(m.title)}</b>`:''}${links}${m.sub?`<span class="fsub">${esc(m.sub)}</span>`:''}`;
}
function footerActsHTML(m, onDetails){
  // Off Details only an in-flight button shows (Saving…, Deleting…): the pill no
  // longer says Saving, so this is every tab's saving signal.
  if(!onDetails){
    const p=m.primary;
    if(!(p && !p.act && !p.enabled && p.tone!=='quiet')) return '';
    m = { primary: p };
  }
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
function renderEditorFooter(){
  const msgEl=document.getElementById('edFoot'), actEl=document.getElementById('edActs'), menuEl=document.getElementById('edMenu');
  if(!msgEl || !actEl || !menuEl || !_ctx || !editing || _ctx.ev!==editing) return;
  const m=editorFooterModel(editing, _ctx), onDetails = activeSection==='details';
  const stepsEl=document.getElementById('edSteps'); if(stepsEl) paintInner(stepsEl, onDetails ? footerStepsHTML(m) : '');
  // Other tabs: one line on what the tab is for, plus ⋮ (R28).
  const foot = (SECTIONS.find(x=>x.id===activeSection)||{}).foot;
  paintInner(msgEl, onDetails ? footerMsgHTML(m) : foot ? `<span class="fsub ftabdesc">${esc(foot)}</span>` : '');
  const bEl=document.getElementById('epBadges'); if(bEl) paintInner(bEl, badgesHTML(editing));   // the badge follows the same stage
  paintInner(actEl, footerActsHTML(m, onDetails));
  if(paintInner(menuEl, footerMenuHTML(m.menu, m.busy))) _menuOpen=false;   // items changed: it's a new (closed) menu
  paintFieldMarks();   // field markers/tags follow the same event state as the footer
}
function kebabMenu(open, focusFirst){
  const wrap=document.getElementById('edMenu'), btn=wrap && wrap.querySelector('.kb'), menu=wrap && wrap.querySelector('.kmenu');
  if(!btn || !menu){ _menuOpen=false; return; }
  _menuOpen=!!open;
  menu.hidden=!open; btn.setAttribute('aria-expanded', String(!!open)); btn.classList.toggle('on', !!open);
  if(open){ hideTip(); if(focusFirst){ const f=menu.querySelector('[role="menuitem"]'); if(f) f.focus(); } }
}
// Footer links name a field that blocks the next step: bring it into view and focus it.
const FOCUS_FIELD_EL = { title:'f_title', description:'f_desc', programs:'f_progs', leads:'f_leads', date:'f_date', start:'f_start', end:'f_end',
  venue:'f_venue_box', capacity:'f_capacity', publicSummary:'f_pubsummary', publicDescription:'f_pubdesc', addressVisibility:'f_addrvis' };
// The tab each field lives on (anything not listed is on Details).
const FIELD_SECTION = { description:'planning', programs:'planning', leads:'planning' };
function focusField(field){
  const sec=FIELD_SECTION[field] || 'details';
  if(sec!==activeSection){ const b=document.querySelector(`#epTabs [data-sect="${sec}"]`); if(b) b.click(); }   // the tab list's own switch: autosave, render, footer, URL
  let el=document.getElementById(FOCUS_FIELD_EL[field]||'');
  if(!el && (field==='date' || field==='start' || field==='end')) el=document.getElementById('f_when');   // not an exact date yet
  if(!el) return;
  el.scrollIntoView({ block:'center', behavior:'smooth' });
  const target = el.matches('input,select,textarea,button') ? el : el.querySelector('input:not([disabled]),select,textarea,button:not([disabled])');
  if(target) target.focus({ preventScroll:true });
}
