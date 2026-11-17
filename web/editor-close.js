/* editor-close.js — leaving: the leave guard, requestClose/closeModal (the modal), leaveEventPage/← Calendar (the event page), the modal footer's and the panel's action dispatch, ⋮ menu keys, header actions.
   Owns: show, leaveGuard, hideLeaveGuard, closeModal, leaveEventPage, onPopState, footerAct, _headMenuOpen, headMenuHTML, headMenu
   Reads: editing, activeSection, SECTIONS (editor-tabs.js); _ctx, _calScrollY, pageOpen, openedInApp, eventUrl, calendarUrl, openFromUrl (editor.js); _form, _unconfirmed (save.js); scrollCalendarToToday (shell.js); KEBAB_ICON, kebabMenu (status-panel.js; call time)
   Writes: editing (editor-tabs.js; closeModal, leaveEventPage); _epState (editor.js; leaveEventPage); _ndocGen (notes-doc.js; leaveEventPage); _menuOpen (status-panel.js); _regFetch (eventbrite.js)
   Loaded after: eventbrite.js (file-map order; its Escape and click listeners keep their order after preview.js and before help.js's) */

/* =========================================================================
   WIRING
   ========================================================================= */
function show(){ document.getElementById('scrim').classList.add('open'); document.body.classList.add('modal-open'); }   // lock background scroll while any modal is open
// Leave guard (spec 5.7): closing a linked event's editor with edits that aren't on
// Eventbrite yet asks first, in the modal (no window.confirm). `proceed` runs on
// "Close anyway". Returns true when it held the close.
let _guardThen=null;
let _guardBypass=false;   // set while "Close anyway" runs its proceed(): the re-entered opener must not ask again
function unpushedOnLeave(){
  if(!editing || !_ctx || _ctx.ev!==editing || !_ctx.role.canEdit || _ctx.past) return 0;
  const st=ListingRules.stageOf(editing);
  if(st!=='onEventbrite' && st!=='published') return 0;
  if(_form && _form.ev===editing) autosaveEditor();   // count what's in the form (close would queue it anyway)
  return ListingRules.unpushedFields(editing, editing.pushed || null).length;
}
function leaveGuard(proceed){
  if(_guardBypass){ _guardBypass=false; hideLeaveGuard(); return false; }   // one shot: consumed by the first check
  const n=unpushedOnLeave();
  if(!n){ hideLeaveGuard(); return false; }
  _guardThen=proceed;
  const bar=document.getElementById('edGuard'); if(!bar) return false;
  bar.innerHTML=`<span class="edguard-msg">${n===1 ? "You have 1 change that isn't on Eventbrite yet." : `You have ${n} changes that aren't on Eventbrite yet.`}</span>
    <button type="button" class="btn fbtn sec" data-guard="keep">Keep editing</button><button type="button" class="btn fbtn danger" data-guard="go">Close anyway</button>`;
  bar.hidden=false;
  bar.scrollIntoView({block:'center'});   // not under the sticky top bar
  bar.querySelector('[data-guard="keep"]').focus({ preventScroll:true });
  return true;
}
function hideLeaveGuard(){
  _guardThen=null;
  const bar=document.getElementById('edGuard'); if(bar && !bar.hidden){ bar.hidden=true; bar.innerHTML=''; }
}
const leaveGuardShown = () => { const b=document.getElementById('edGuard'); return !!(b && !b.hidden); };
// The modal's ✕, Esc, a click on the scrim and the modals' Close/Cancel buttons come
// here. (The event page has no ✕ and Esc doesn't leave it: ← Calendar does.)
function requestClose(viaEsc){
  if(closePreview()) return;                     // the preview sits on top: close it first
  if(leaveGuardShown()){ if(viaEsc) hideLeaveGuard(); return; }   // Esc again = keep editing
  if(leaveGuard(()=>closeModal())) return;
  closeModal();
}
// ← Calendar: the page's way out, through the leave guard like every other exit.
// (leaveEventPage('back') decides between history.back() and pushing the calendar.)
function backToCalendar(){
  if(leaveGuard(()=>leaveEventPage('back'))) return;
  leaveEventPage('back');
}
document.getElementById('edGuard').addEventListener('click', e=>{
  const b=e.target.closest('[data-guard]'); if(!b) return;
  const then=_guardThen;
  hideLeaveGuard();
  if(b.dataset.guard==='go' && then){
    _guardBypass=true;
    try{ then(); } finally{ _guardBypass=false; }   // (a proceed that never re-checks mustn't leave it armed)
  }
});
// The modal (create form, reference event, day picker, Feedback) goes away.
function closeModal(){
  hideTip();
  leaveForm();   // (the create form binds no _form; harmless)
  document.getElementById('scrim').classList.remove('open');
  document.body.classList.remove('modal-open');
  document.getElementById('modal').classList.remove('create');
  if(!pageOpen()) editing=null;   // a modal over the event page mustn't orphan the page's event
}
// The event page goes away and the calendar comes back as it was: view, year and
// scroll. `how` (spec 5.1):
//   'back'   ← Calendar and other in-app exits (after a delete): history.back() when the
//            page's entry is our in-app stamp, else push the calendar URL. The page
//            closes first, so the popstate that follows finds it closed and does nothing.
//   'push'   push the calendar URL (a fresh deep link has no in-app entry to go back to);
//   'popped' Back/Forward already moved the URL: history is left alone.
function leaveEventPage(how){
  if(how==='back') how = openedInApp() ? 'goBack' : 'push';
  _ndocGen++;
  hideLeaveGuard(); closePreview(); clearEbBlock();
  if(editing && editing.id) _regFetch.delete(editing.id);   // a registrants read doesn't outlive the editor
  // Queue any edit before tearing down so a fast ← Calendar can't drop the last
  // change — including a field still being typed in (no blur yet).
  // The queue writes it after the page is gone.
  const id=editing && editing.id;
  hideTip(); kebabMenu(false); headMenu(false);
  leaveForm();   // (retries the open form's failed save once)
  document.getElementById('eventPage').hidden=true;
  document.getElementById('eventPage').classList.remove('loading', 'ep-fill', 'ep-scroll');
  document.body.classList.remove('event-open');
  editing=null; _epState=null;
  if(how==='goBack') history.back();
  else if(how==='push') history.pushState(null, '', calendarUrl());
  if(id) retryFailedSave(id);   // …and a read-only editor's, whose form wasn't bound
  layoutSticky();
  if(_calScrollY===null) scrollCalendarToToday();   // opened from a deep link before the calendar was placed
  else window.scrollTo(0, _calScrollY);
}
// Back/Forward (spec 5.1, 5.7, risk 9.1). popstate fires after the URL has changed.
//   The page is open and the URL left its event: a Preview on top just closes (the
//   page's entry is re-pushed). Otherwise through the leave guard. If it holds
//   (edits not on Eventbrite yet), re-push the page's entry so the user stays put, with
//   the leave bar showing; "Close anyway" closes the page, then steps back again.
//   Otherwise close the page, and open the event the URL names, if any.
//   The page is closed and the URL names an event (Forward): open it.
function onPopState(){
  const id=new URL(location.href).searchParams.get('event');
  if(pageOpen() && editing){
    if(id===editing.id) return;
    const ev=editing, st=_epState;
    // Back with the Preview open closes the preview, like Esc: the page stays, its
    // entry re-pushed, and no leave bar appears under the overlay.
    if(closePreview()){ history.pushState(st, '', eventUrl(ev, activeSection)); return; }
    if(leaveGuard(()=>{ if(editing===ev) leaveEventPage('popped'); history.back(); })){
      history.pushState(st, '', eventUrl(ev, activeSection));
      return;
    }
    leaveEventPage('popped');
  }
  if(id) openFromUrl();
}

document.getElementById('scrim').addEventListener('click',e=>{ if(e.target.id==='scrim') requestClose(); });
document.getElementById('mClose').addEventListener('click', ()=>requestClose());   // dedicated top-right ✕ (avoids mis-hitting Approve)
document.getElementById('epBack').addEventListener('click', backToCalendar);
// Esc: the modal closes; on the page it only takes down the leave bar (the preview,
// ⋮ and Help peel off first in their own capture-phase listeners).
document.addEventListener('keydown',e=>{
  if(e.key!=='Escape') return;
  if(document.getElementById('scrim').classList.contains('open')) requestClose(true);
  else if(pageOpen() && leaveGuardShown()) hideLeaveGuard();
});

// The modals' footer (#mFoot: the create form's Create/Cancel, Close): its buttons only.
document.getElementById('mFoot').addEventListener('click', e=>{
  const act=e.target.closest('[data-act]')?.dataset.act; if(act) footerAct(act);
});
// The event page's Status & next step panel (#epPanel): save retry, readiness links,
// the primary and ⋮, the Eventbrite-cancel bar's Email, the listing card's Preview.
function onPanelClick(e){
  if(e.target.id==='saveStatus' && e.target.classList.contains('error')){
    if(editing && _unconfirmed.has(editing.id)) retryCreateConfirm(editing.id);
    if(!editing || saveQueue.status(editing.id)==='error' || !_unconfirmed.has(editing.id)) flushAutosave().catch(()=>{});
    return;
  }   // the label reports the outcome
  const ff=e.target.closest('[data-focus-field]');
  if(ff){ e.preventDefault(); focusField(ff.dataset.focusField, ff.dataset.focusCheck); return; }
  const sl=e.target.closest('[data-sect]');   // a link in the sentence (Past → Budget & expenses, Feedback): the tab list's own switch
  if(sl){ e.preventDefault(); const b=document.querySelector(`#epTabs [data-sect="${sl.dataset.sect}"]`); if(b) b.click(); return; }
  if(e.target.closest('[data-block="email"]')){ if(editing) emailRegistrants(editing, 'Update: ' + (editing.title || ''), ''); return; }
  if(e.target.closest('#epPanel [data-pv-open]')){ openPreview(); return; }   // the card's listing row
  if(e.target.closest('#edMore')){ toggleSteps(); return; }   // phones: see all steps
  const act=e.target.closest('[data-act]')?.dataset.act; if(!act) return;
  if(act==='menu'){ kebabMenu(!_menuOpen, true); return; }
  if(e.target.closest('.kmenu')) kebabMenu(false);
  footerAct(act);
}
document.getElementById('epPanel').addEventListener('click', onPanelClick);
document.getElementById('epPhoneBar').addEventListener('click', onPanelClick);   // phones: the primary and ⋮ live in the bottom bar
// One dispatcher for the modal footer's, the panel's and the preview's actions.
function footerAct(act){
  if(act==='close') requestClose();
  else if(act==='create') createFromForm();
  else if(act==='propose') transitionTo('proposed');
  else if(act==='approve') transitionTo('approved');
  else if(act==='cancel') cancelEvent();
  else if(act==='reopen') transitionTo('draft');
  else if(act==='delete') deleteEditor();
  else if(PUSH_ACTS[act]) pushToEventbrite(act);
  else if(act==='dismiss-notice') dismissChangeNotice();
  else if(act==='email-registrants') emailAfterChange();
  else if(act==='unpublish') unpublishEvent();
}
// The two ⋮ menus — the panel's (#edMenu, kebabMenu) and the top bar's (#epMenu,
// headMenu) — close on an outside click or Esc (before Esc does anything else); arrow
// keys, Home and End move between the open one's items; Tab closes it.
document.addEventListener('click', e=>{
  if(_menuOpen && !e.target.closest('#edMenu')) kebabMenu(false);
  if(_headMenuOpen && !e.target.closest('#epMenu')) headMenu(false);
});
document.addEventListener('keydown', e=>{
  if(!_menuOpen && !_headMenuOpen) return;
  const head=!_menuOpen, close = head ? headMenu : kebabMenu;
  const wrap=document.getElementById(head ? 'epMenu' : 'edMenu');
  if(!wrap || !wrap.querySelector('.kb')){ close(false); return; }
  const items=[...wrap.querySelectorAll('[role="menuitem"]')], i=items.indexOf(document.activeElement);
  if(e.key==='Escape'){ e.preventDefault(); e.stopImmediatePropagation(); close(false); wrap.querySelector('.kb').focus(); }
  else if(e.key==='ArrowDown' || e.key==='ArrowUp'){ e.preventDefault(); const n=items.length; items[((i<0?(e.key==='ArrowDown'?-1:0):i)+(e.key==='ArrowDown'?1:-1)+n)%n].focus(); }
  else if(e.key==='Home' || e.key==='End'){ e.preventDefault(); items[e.key==='Home'?0:items.length-1].focus(); }
  else if(e.key==='Tab') close(false);
}, true);
// The top bar's ⋮ (phone layout only; wide and mid show the icons in #epActions): Help for this tab (the active tab's guide), View
// in gather, Copy link. Same markup and keys as the panel's ⋮ (footerMenuHTML), its own
// id (#epMenu) and state.
let _headMenuOpen=false;
function headMenuHTML(gatherUrl){
  return `<button type="button" class="kb" data-act="head-menu" aria-label="More" data-tip="More" aria-haspopup="menu" aria-expanded="false">${KEBAB_ICON}</button>`
    + `<div class="kmenu" role="menu" aria-label="More" hidden>`
    + `<button type="button" class="mi" role="menuitem" tabindex="-1" data-act="help"><b>Help for this tab</b></button>`
    + `<a class="mi" role="menuitem" tabindex="-1" href="${esc(gatherUrl)}" target="_blank" rel="noopener"><b>View in gather</b></a>`
    + `<button type="button" class="mi" role="menuitem" tabindex="-1" data-act="copylink"><b>Copy link</b></button></div>`;
}
function headMenu(open, focusFirst){
  const wrap=document.getElementById('epMenu'), btn=wrap && wrap.querySelector('.kb'), menu=wrap && wrap.querySelector('.kmenu');
  if(!btn || !menu){ _headMenuOpen=false; return; }
  _headMenuOpen=!!open;
  menu.hidden=!open; btn.setAttribute('aria-expanded', String(!!open)); btn.classList.toggle('on', !!open);
  if(open){ hideTip(); if(focusFirst){ const f=menu.querySelector('[role="menuitem"]'); if(f) f.focus(); } }
}
// The top bar's icons (#epActions) and ⋮ (#epMenu), and the modal's #mActions: help for the active tab, copy link.
function onHeadClick(e){
  const btn=e.target.closest('[data-act]'), act=btn?.dataset.act;
  if(act==='head-menu'){ headMenu(!_headMenuOpen, true); return; }
  if(e.target.closest('.kmenu')) headMenu(false);   // any item (View in gather too) closes the menu
  if(act==='copylink'){ const u=new URL(location.href); u.searchParams.delete('help'); navigator.clipboard.writeText(u.href).then(()=>toast('Link copied','ok'), ()=>toast('Copy failed','err')); }   // share the event, not a guide open beside it
  else if(act==='help'){ const s=SECTIONS.find(x=>x.id===activeSection); openHelp((s && s.help) || '', btn.closest('.kmenu') ? document.querySelector('#epMenu .kb') : btn); }
}
document.getElementById('mActions').addEventListener('click', onHeadClick);
document.getElementById('epActions').addEventListener('click', onHeadClick);
document.getElementById('epMenu').addEventListener('click', onHeadClick);
