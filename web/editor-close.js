/* editor-close.js — leaving: the leave guard, requestClose/closeModal (the modal), leaveEventPage/← Calendar (the event page), footer-action dispatch, ⋮ menu keys, header actions.
   Owns: show, leaveGuard, hideLeaveGuard, closeModal, leaveEventPage, onPopState, footerAct
   Reads: editing, activeSection, SECTIONS (editor-tabs.js); _ctx, _calScrollY, pageOpen, openedInApp, eventUrl, calendarUrl, openFromUrl (editor.js); _form, _unconfirmed (save.js); scrollCalendarToToday (shell.js)
   Writes: editing (editor-tabs.js; closeModal, leaveEventPage); _epState (editor.js; leaveEventPage); _ndocGen (notes-doc.js; leaveEventPage); _menuOpen (footer.js); _regFetch (eventbrite.js)
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
document.getElementById('edBlock').addEventListener('click', e=>{
  if(!e.target.closest('[data-block="email"]') || !editing) return;
  emailRegistrants(editing, 'Update: ' + (editing.title || ''), '');
});
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
  hideTip(); kebabMenu(false);
  leaveForm();   // (retries the open form's failed save once)
  document.getElementById('eventPage').hidden=true;
  document.getElementById('eventPage').classList.remove('loading');
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
//   The page is open and the URL left its event: through the leave guard. If it holds
//   (edits not on Eventbrite yet), re-push the page's entry so the user stays put, with
//   the leave bar showing; "Close anyway" closes the page, then steps back again.
//   Otherwise close the page, and open the event the URL names, if any.
//   The page is closed and the URL names an event (Forward): open it.
function onPopState(){
  const id=new URL(location.href).searchParams.get('event');
  if(pageOpen() && editing){
    if(id===editing.id) return;
    const ev=editing, st=_epState;
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

// The footer's actions: in #mFoot for the modals, in #epPanel on the event page.
function onFootClick(e){
  if(e.target.id==='saveStatus' && e.target.classList.contains('error')){
    if(editing && _unconfirmed.has(editing.id)) retryCreateConfirm(editing.id);
    if(!editing || saveQueue.status(editing.id)==='error' || !_unconfirmed.has(editing.id)) flushAutosave().catch(()=>{});
    return;
  }   // the label reports the outcome
  const ff=e.target.closest('[data-focus-field]');
  if(ff){ e.preventDefault(); focusField(ff.dataset.focusField); return; }
  const act=e.target.closest('[data-act]')?.dataset.act; if(!act) return;
  if(act==='menu'){ kebabMenu(!_menuOpen, true); return; }
  if(e.target.closest('.kmenu')) kebabMenu(false);
  footerAct(act);
}
document.getElementById('mFoot').addEventListener('click', onFootClick);
document.getElementById('epPanel').addEventListener('click', onFootClick);
// One dispatcher for the footer's and the preview's actions.
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
// ⋮ menu: closes on an outside click or Esc (before Esc closes the modal); arrow keys
// move between its items.
document.addEventListener('click', e=>{ if(_menuOpen && !e.target.closest('#edMenu')) kebabMenu(false); });
document.addEventListener('keydown', e=>{
  if(!_menuOpen) return;
  const wrap=document.getElementById('edMenu'); if(!wrap || !wrap.querySelector('.kb')){ _menuOpen=false; return; }
  const items=[...wrap.querySelectorAll('[role="menuitem"]')], i=items.indexOf(document.activeElement);
  if(e.key==='Escape'){ e.preventDefault(); e.stopImmediatePropagation(); kebabMenu(false); wrap.querySelector('.kb').focus(); }
  else if(e.key==='ArrowDown' || e.key==='ArrowUp'){ e.preventDefault(); const n=items.length; items[((i<0?(e.key==='ArrowDown'?-1:0):i)+(e.key==='ArrowDown'?1:-1)+n)%n].focus(); }
  else if(e.key==='Home' || e.key==='End'){ e.preventDefault(); items[e.key==='Home'?0:items.length-1].focus(); }
  else if(e.key==='Tab') kebabMenu(false);
}, true);
// header actions: ? (help for the active tab) + copy-link. The status badge opens
// the lifecycle guide through data-help; transitions are in the footer.
function onHeadClick(e){
  const btn=e.target.closest('[data-act]'); const act=btn?.dataset.act; if(!act) return;
  if(act==='copylink'){ const u=new URL(location.href); u.searchParams.delete('help'); navigator.clipboard.writeText(u.href).then(()=>toast('Link copied','ok'), ()=>toast('Copy failed','err')); }   // share the event, not a guide open beside it
  else if(act==='help'){ const s=SECTIONS.find(x=>x.id===activeSection); openHelp((s && s.help) || '', btn); }
}
document.getElementById('mActions').addEventListener('click', onHeadClick);
document.getElementById('epActions').addEventListener('click', onHeadClick);
