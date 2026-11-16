/* editor-close.js — closing the editor: the leave guard, requestClose, close, footer-action dispatch, ⋮ menu keys, header actions.
   Owns: show, leaveGuard, hideLeaveGuard, close, footerAct
   Reads: editing, activeSection, SECTIONS (editor-tabs.js); _ctx (editor.js); _form, _unconfirmed (save.js)
   Writes: editing (editor-tabs.js; close); _ndocGen (notes-doc.js; close); _menuOpen (footer.js); _regFetch (eventbrite.js)
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
  bar.querySelector('[data-guard="keep"]').focus();
  return true;
}
function hideLeaveGuard(){
  _guardThen=null;
  const bar=document.getElementById('edGuard'); if(bar && !bar.hidden){ bar.hidden=true; bar.innerHTML=''; }
}
const leaveGuardShown = () => { const b=document.getElementById('edGuard'); return !!(b && !b.hidden); };
// ✕, Esc, a click on the scrim and the modals' Close/Cancel buttons come here.
function requestClose(viaEsc){
  if(closePreview()) return;                     // the preview sits on top: close it first
  if(leaveGuardShown()){ if(viaEsc) hideLeaveGuard(); return; }   // Esc again = keep editing
  if(leaveGuard(()=>close())) return;
  close();
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
function close(){
  _ndocGen++;
  hideLeaveGuard(); closePreview(); clearEbBlock();
  if(editing && editing.id) _regFetch.delete(editing.id);   // a registrants read doesn't outlive the editor
  // Queue any edit before tearing down so a fast Done/Esc/✕ can't drop the last
  // change — including a field still being typed in (Esc closes without its blur).
  // The queue writes it after the editor is gone.
  const id=editing && editing.id;
  hideTip();
  leaveForm();   // (retries the open form's failed save once)
  document.getElementById('scrim').classList.remove('open');
  document.body.classList.remove('modal-open');
  document.getElementById('modal').classList.remove('ws','create'); document.getElementById('mBody').classList.remove('ws');
  editing=null; clearUrl();
  if(id) retryFailedSave(id);   // …and a read-only editor's, whose form wasn't bound
}

document.getElementById('scrim').addEventListener('click',e=>{ if(e.target.id==='scrim') requestClose(); });
document.getElementById('mClose').addEventListener('click', ()=>requestClose());   // dedicated top-right ✕ (avoids mis-hitting Approve)
document.addEventListener('keydown',e=>{ if(e.key==='Escape') requestClose(true); });

document.getElementById('mFoot').addEventListener('click',e=>{
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
});
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
document.getElementById('mActions').addEventListener('click',e=>{
  const btn=e.target.closest('[data-act]'); const act=btn?.dataset.act; if(!act) return;
  if(act==='copylink'){ const u=new URL(location.href); u.searchParams.delete('help'); navigator.clipboard.writeText(u.href).then(()=>toast('Link copied','ok'), ()=>toast('Copy failed','err')); }   // share the event, not a guide open beside it
  else if(act==='help'){ const s=SECTIONS.find(x=>x.id===activeSection); openHelp((s && s.help) || '', btn); }
});
