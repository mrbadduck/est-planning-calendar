/* save.js — the save model: on-blur autosave, the saveQueue wiring, optimistic local copies, the save pill, leaveForm, the unload guard.
   The save model's rules live in: saveQueue (one write in flight per event), applied / pendingFor
   (Saved = overlaid or applied, D3, 0012), confirmLater, leaveForm, flushAutosave, dropFailedEdits, guardUnload.
   Owns: scheduleReconcile, _form, _busy, _busyLabel, _authRetry, formCells, _applying, _confirming, _slow,
         _unconfirmed, CREATING_LABEL, applied, confirmLater, hasUnconfirmed, pendingFor, trackWorkerWrite, afterCreate, trackCreate,
         retryCreateConfirm, saveQueue, dropFailedEdits, retryFailedSave, guardUnload, paintSaveStatus,
         scheduleAutosave, autosaveEditor, leaveForm, flushAutosave, applyLocal
   Reads: editing, state (state.js, editor-tabs.js); _unsaved, _recent (state.js); _pushChecks (eventbrite.js)
   Writes: _unsaved (state.js; set/delete); _pushChecks (eventbrite.js; delete); state.events (applyLocal)
   Loaded after: ui.js (file-map order; the est:identity listener keeps its place before those in later files) */

/* ---- optimistic writes: reflect the change instantly, reconcile after ------ */
let _reconcileT=null;
function scheduleReconcile(){ clearTimeout(_reconcileT); _reconcileT=setTimeout(()=>refresh(), 2500); }  // let Coda index, then pull server truth (recent guard prevents flicker)

/* ---- workspace auto-save (existing events) --------------------------------
   Every editable workspace field saves on blur, debounced, in place — the modal
   stays open. A save sends ONLY the columns whose form value changed since the
   form was last queued (formCells vs _form.base) — only the user's edits;
   nothing read from Eventbrite is ever written (D4). So a column nobody touched — a
   relation mapped before its list loaded, a Status someone else just changed —
   is never written back; Status is written only by the lifecycle actions
   (transitionTo/cancelEvent). Writes go through saveQueue (web/save-queue.js):
   one at a time per event, later edits coalesce, a failed write rides along with
   the next one, and one event's saves never wait on or replace another's. A
   failed save stays retryable only while its editor is open; after that (and
   one more try on close) the event goes back to its saved values and a toast
   says so (dropFailedEdits) — a stale local copy must not linger. The calendar
   updates optimistically (applyLocal; _unsaved/_recent keep the local copy
   through re-fetches; scheduleReconcile pulls server truth after). */
let _autosaveT=null;
let _form=null;               // the open editable workspace: { ev, base: its form cells as last queued }
const _busy=new Set();        // event ids with a transition/cancel/delete in flight
const _busyLabel=new Map();   // event id → what its panel button says meanwhile ("Cancelling…"; default "Saving…")
const _authRetry=new Set();   // event ids whose save hit an expired session — sent again after sign-in
const sameVal=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const formCells = f => eventToCodaCells(f).filter(c => c.column!=='Status');
// Honest saves (D3, 0012): "Saved" means Coda accepted a write AND the Worker's
// overlay holds it (overlaid: every read through the Worker returns it), or, when
// it isn't overlaid, that Coda has APPLIED it. applied() polls the Worker's
// /mutation route via CodaApplied.waitApplied. An overlaid write's confirm runs in
// the background (confirmLater, counted in _confirming, never in pendingFor); a
// failure there still reaches the lead (toast). Otherwise the queue's write awaits
// the apply, so saveQueue.status(id)==='saving' covers it; _applying counts only
// applies started outside the queue (create, transitions that weren't overlaid).
// pendingFor(id) is the one answer the pill and panel read.
const _applying=new Map();    // event id → applies in flight outside the queue
const _confirming=SaveQueue.tracker();   // event id → background confirms of overlaid writes (hasUnconfirmed)
const CREATING_LABEL='Creating… (about half a minute)';   // the panel's primary while a new event's insert applies
const _slow=new Set();        // event ids whose apply has passed CodaApplied's slow mark
const _createApply=new Map(); // new event id → its insert's apply promise (later writes wait on it)
const _unconfirmed=new Map(); // new event id → requestId of an insert Coda never confirmed (pill: Save failed — retry)
function applied(requestId, eventId, opts={}){
  const counted = opts.counted!==false, background = opts.background===true;   // background: no slow mark (nothing on screen waits on it)
  if(counted) _applying.set(eventId, (_applying.get(eventId)||0)+1);
  const repaint=()=>{ if(editing && editing.id===eventId) paintSaveStatus(); };
  repaint();
  return CodaApplied.waitApplied(requestId, {
    fetchStatus: rid => DB.mutationStatus(rid),
    sleep: ms => new Promise(r => setTimeout(r, ms)),
    now: () => Date.now(),
    onSlow: background ? null : () => { _slow.add(eventId); if(editing && editing.id===eventId) setSaveStatus('slow'); },
  }).finally(()=>{
    if(counted){ const n=(_applying.get(eventId)||0)-1; if(n>0) _applying.set(eventId, n); else _applying.delete(eventId); }
    if(!background && !((_applying.get(eventId)||0) > 0)) _slow.delete(eventId);   // the next write gets its own slow mark
    repaint();
  });
}
// An overlaid write confirms in the background: the queue (or transition) moves on
// at once. Counted in _confirming until it settles, so loadEvents keeps the local
// copy over a read that missed the overlay and the event's actions go out flagged
// unconfirmed (hasUnconfirmed); then its _recent hold is renewed. onFail(err): the
// overlay or Coda gave up on it.
function confirmLater(requestId, id, onFail){
  if(!requestId) return;
  _confirming.track(id, applied(requestId, id, { counted:false, background:true })).then(
    ()=>{ const r=_recent.get(id); if(r){ const { until, ...rec }=r; markRecent(id, rec); } },
    err=>{ console.warn('overlaid write not confirmed:', err); if(onFail) onFail(err); });
}
// An overlaid write to this event is still confirming: publish / cancel / unpublish /
// delete tell the Worker (it refuses while it can't reach the overlay).
const hasUnconfirmed = id => !!id && _confirming.has(id);
// Anything for this event queued, in flight, or written (not overlaid) but not yet
// applied by Coda. Background confirms of overlaid writes don't count: the request
// returning is enough. A bare debounce timer doesn't count either: the panel's
// primary must not turn into Saving… under a click, and every push/transition
// flushes the form and waits on this before it acts (settledForPush, transitionTo),
// so nothing goes out early.
function pendingFor(id){
  if(!id) return false;
  return saveQueue.status(id)==='saving'
    || (_applying.get(id)||0) > 0
    || _unconfirmed.has(id);
}
// A Worker write to this event's row (publish / cancel / unpublish, R19). Overlaid:
// reads already return it, so it confirms in the background (confirmLater). Not
// overlaid: Coda applies it 13–30 s later, so hold the primary at Saving…
// (pendingFor counts it). Either way loadEvents keeps the local copy over stale
// /rows reads (it holds _recent while _applying or _confirming counts the event).
function trackWorkerWrite(ev, requestId, overlaid){
  markRecent(ev.id, {e:ev});
  if(!requestId) return;
  const fail=err=>{ console.warn('worker write not confirmed:', err); markRecent(ev.id, {e:ev}); toast('The change didn’t confirm. Check again in a minute.','err'); scheduleReconcile(); };
  if(overlaid){ confirmLater(requestId, ev.id, fail); return; }
  applied(requestId, ev.id).then(()=>{ markRecent(ev.id, {e:ev}); scheduleReconcile(); }, fail);
}
// Writes to a just-created row wait for its insert to apply (a failed confirm is
// handled by _unconfirmed, not here).
const afterCreate = id => Promise.resolve(_createApply.get(id)).catch(()=>{});
// Track a new event's insert until Coda applies it (creates always wait, overlaid or
// not): the panel's primary reads CREATING_LABEL meanwhile, then the Created toast;
// unconfirmed → the pill offers a retry (Save failed — retry).
function trackCreate(id, requestId){
  _busyLabel.set(id, CREATING_LABEL);
  const p=applied(requestId, id);
  _createApply.set(id, p);
  p.then(()=>{ _unconfirmed.delete(id); toast('Created','ok'); },
         err=>{ console.warn('create not confirmed:', err); _unconfirmed.set(id, requestId); })
   .finally(()=>{
     if(_createApply.get(id)===p) _createApply.delete(id);
     if(_busyLabel.get(id)===CREATING_LABEL) _busyLabel.delete(id);   // (a Deleting… set meanwhile stays)
     if(editing && editing.id===id) paintSaveStatus();
   });
}
// The pill's retry for an unconfirmed create: never re-POST (that would duplicate the
// row) — poll the same requestId once more; if that fails too, pull server truth and
// let loadEvents clear it once the row shows up in /rows.
function retryCreateConfirm(id){
  const rid=_unconfirmed.get(id);
  if(rid==null || (_applying.get(id)||0) > 0) return;
  applied(rid, id).then(()=>{ _unconfirmed.delete(id); }, ()=>{ scheduleReconcile(); })
    .finally(()=>{ if(editing && editing.id===id) paintSaveStatus(); });
}
const saveQueue = SaveQueue.create({
  // Overlaid: saved on the 202, the confirm runs in the background. Not overlaid: wait for the apply.
  write: (id, cells) => afterCreate(id).then(() => DB.update(id, cells)).then(r => r && r.overlaid
    ? confirmLater(r.requestId, id, ()=>{ const e=state.events.find(x=>x.id===id); toast(`Your last change to “${(e && e.title) || 'an event'}” didn’t save — open it and make the change again`,'err'); scheduleReconcile(); })
    : applied(r && r.requestId, id, { counted:false })),
  onState(id, st, err){
    if(st==='saved'){ const u=_unsaved.get(id); _unsaved.delete(id); guardUnload(); if(u) markRecent(id, {e:u.ev}); scheduleReconcile(); }
    if(st==='error'){
      console.warn('save failed:', err);
      if(err && err.status===401){ _authRetry.add(id); sessionExpired(); }
      // (A 404 is retryable like any failure: Coda can 404 a row created seconds ago.)
      else if(!(_form && _form.ev===editing && editing.id===id)) dropFailedEdits(id);   // no open editor to retry from
    }
    if(editing && editing.id===id) paintSaveStatus();
  },
});
// A save failed with no open editor to retry from: put back the fields the failed
// edits changed (the rest — a create, a status change — did save), forget the
// edits, and say so.
function dropFailedEdits(id, msg){
  const u=_unsaved.get(id), title=(u && u.ev.title) || 'an event';
  saveQueue.discard(id);
  _unsaved.delete(id); _authRetry.delete(id); guardUnload();
  if(u){
    Object.assign(u.ev, u.before); applyLocal(u.ev); rerender();
    markRecent(id, {e:u.ev});   // keep guarding what did save against Coda's list lag
  }
  scheduleReconcile();
  toast(msg || `Your last change to “${title}” didn’t save — open it and make the change again`,'err');
}
// A failed save gets one more try when its editor goes; if that fails too, the
// edits are dropped with a toast (onState → dropFailedEdits). An expired session
// retries after sign-in instead.
function retryFailedSave(id){
  if(saveQueue.status(id)==='error' && !_authRetry.has(id)) saveQueue.settle(id).catch(()=>{});
}
// Saves that hit an expired session go out again once the user has signed back in.
document.addEventListener('est:identity', ()=>{
  if(!(state.identity && state.identity.signedIn)) return;
  for(const id of [..._authRetry]){ _authRetry.delete(id); saveQueue.settle(id).catch(()=>{}); }
});
// Leaving (reload/close) with an editor open or a change not yet saved would lose
// it: queue what's in the form and let the browser ask (desktop browsers do;
// iPhone/iPad Safari doesn't). Only listened for while needed — a standing
// beforeunload listener keeps some browsers from caching the page for Back.
function onBeforeUnload(e){
  if(_form) autosaveEditor();
  if(_unsaved.size || _busy.size){ e.preventDefault(); e.returnValue=''; }   // _busy: a delete/transition still waiting on Coda
}
let _unloadGuarded=false;
function guardUnload(){
  const need=!!_form || _unsaved.size>0 || _busy.size>0;
  if(need===_unloadGuarded) return;
  _unloadGuarded=need;
  if(need) window.addEventListener('beforeunload', onBeforeUnload); else window.removeEventListener('beforeunload', onBeforeUnload);
}
function setSaveStatus(s){                     // 'clean' | 'dirty' | 'saving' | 'slow' | 'error'
  // The pill shows only a failed save (R21): saving shows in the panel's primary
  // ("Saving…" / "Still saving…"), and when nothing is saving, it's saved.
  const el=document.getElementById('saveStatus');
  if(el){
    el.className='savestat '+s;
    el.textContent = s==='error' ? 'Save failed — retry' : '';
  }
  renderStatusPanel();                        // the panel's primary slot follows pendingFor too
}

function paintSaveStatus(){
  if(!editing || !editing.id) return;
  const id=editing.id, q=saveQueue.status(id);
  const saving = q==='saving' || (_applying.get(id)||0) > 0;
  setSaveStatus(saving ? (_slow.has(id) ? 'slow' : 'saving') : (q==='error' || _unconfirmed.has(id)) ? 'error' : _autosaveT ? 'dirty' : 'clean');
}
function scheduleAutosave(){
  if(!_form || _form.ev!==editing) return;     // create modal / read-only: nothing to auto-save into
  // Every focusout lands here, including the one from clicking a panel button: only
  // a real change marks the form dirty, so a bare blur never repaints the panel
  // under the click (which would swallow it).
  if(!SaveQueue.changedCells(_form.base, formCells(readForm())).length) return;
  clearTimeout(_autosaveT); _autosaveT=setTimeout(autosaveEditor, 800);
  setSaveStatus('dirty');                      // pill: Unsaved changes (the panel's primary stays put)
}
// Queue whatever the open form changed since it was last queued. Synchronous, so
// leaving (leaveForm, via closeModal/leaveEventPage) can call it on the way out — the
// queue writes it after the editor is gone.
function autosaveEditor(){
  clearTimeout(_autosaveT); _autosaveT=null;
  if(!_form || _form.ev!==editing || !editing.id) return;   // the modal shows something else now
  const ev=_form.ev, f=readForm(), cells=formCells(f), changes=SaveQueue.changedCells(_form.base, cells);
  if(changes.length){
    let u=_unsaved.get(ev.id);
    if(!u || u.ev!==ev){ u={ ev, before:(u&&u.before)||{} }; _unsaved.set(ev.id, u); guardUnload(); }
    for(const k of Object.keys(f)) if(!(k in u.before) && !sameVal(ev[k], f[k])) u.before[k]=ev[k];   // saved values — put back if this never saves
    Object.assign(ev, f);
    ev.editedBy=(state.identity && state.identity.name) || ev.editedBy;
    _form.base=cells;
    _pushChecks.delete(ev.id);                 // the Worker's last "needs X" answer is stale after an edit
    saveQueue.stage(ev.id, changes);           // queue first: a render error must not lose the edit
    applyLocal(ev); rerender();                // reflect in the calendar behind the modal
  }
  paintSaveStatus();
}
// The modal is about to show something else: queue the open form's edits, then let
// it go — and give its failed save, if any, that one more try.
function leaveForm(){
  const id=_form && _form.ev.id;
  if(_form) autosaveEditor();
  _form=null; clearTimeout(_autosaveT); _autosaveT=null; guardUnload();
  if(id) retryFailedSave(id);
}
// Write everything in the open form now; rejects if that fails. Publishing needs
// this first — the Worker builds the listing from what Coda has.
async function flushAutosave(){
  if(!editing || !editing.id) return;
  autosaveEditor();
  await saveQueue.settle(editing.id);
}
function applyLocal(e, remove){
  const i=state.events.findIndex(x=>x.id===e.id);
  if(remove){ if(i>=0) state.events.splice(i,1); return; }
  if(i>=0) state.events[i]=e; else state.events.push(e);
}
