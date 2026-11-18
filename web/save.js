/* save.js — the save model: on-blur autosave, the saveQueue wiring, optimistic local copies, the save pill, leaveForm, the unload guard.
   The save model's rules live in: saveQueue (one write in flight per event), applied / pendingFor
   (Saved = applied, D3), leaveForm, flushAutosave, dropFailedEdits, guardUnload.
   Owns: scheduleReconcile, _form, _busy, _busyLabel, _authRetry, formCells, _applying, _slow,
         _unconfirmed, applied, pendingFor, trackWorkerWrite, afterCreate, trackCreate,
         retryCreateConfirm, saveQueue, dropFailedEdits, retryFailedSave, guardUnload, paintSaveStatus,
         scheduleAutosave, autosaveEditor, leaveForm, flushAutosave, applyLocal
   Reads: editing, state (state.js, editor-tabs.js); _unsaved (state.js); _pushChecks (eventbrite.js)
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
// Honest saves (D3): "Saved" means Coda has APPLIED a write, not just accepted it
// (202). applied() polls the Worker's /mutation route via CodaApplied.waitApplied.
// The queue's write awaits it, so saveQueue.status(id)==='saving' covers the apply
// time of edits; _applying counts only applies started outside the queue (create,
// transitions). pendingFor(id) is the one answer the pill and panel read.
const _applying=new Map();    // event id → applies in flight outside the queue
const _slow=new Set();        // event ids whose apply has passed CodaApplied's slow mark
const _createApply=new Map(); // new event id → its insert's apply promise (later writes wait on it)
const _unconfirmed=new Map(); // new event id → requestId of an insert Coda never confirmed (pill: Save failed — retry)
function applied(requestId, eventId, opts={}){
  const counted = opts.counted!==false;
  if(counted) _applying.set(eventId, (_applying.get(eventId)||0)+1);
  const repaint=()=>{ if(editing && editing.id===eventId) paintSaveStatus(); };
  repaint();
  return CodaApplied.waitApplied(requestId, {
    fetchStatus: rid => DB.mutationStatus(rid),
    sleep: ms => new Promise(r => setTimeout(r, ms)),
    now: () => Date.now(),
    onSlow: () => { _slow.add(eventId); if(editing && editing.id===eventId) setSaveStatus('slow'); },
  }).finally(()=>{
    if(counted){ const n=(_applying.get(eventId)||0)-1; if(n>0) _applying.set(eventId, n); else _applying.delete(eventId); }
    if(!((_applying.get(eventId)||0) > 0)) _slow.delete(eventId);   // the next write gets its own slow mark
    repaint();
  });
}
// Anything for this event queued, in flight, or written but not yet applied by Coda.
// A bare debounce timer doesn't count: the panel's primary must not turn into
// Saving… under a click, and every push/transition flushes the form and waits on
// this before it acts (settledForPush, transitionTo), so nothing goes out early.
function pendingFor(id){
  if(!id) return false;
  return saveQueue.status(id)==='saving'
    || (_applying.get(id)||0) > 0
    || _unconfirmed.has(id);
}
// A Worker write to this event's row (publish / cancel / unpublish, R19): Coda applies
// it 13–30 s later, so hold the primary at Saving… (pendingFor counts it) and keep the
// local copy over stale /rows reads (loadEvents holds _recent while it applies).
function trackWorkerWrite(ev, requestId){
  markRecent(ev.id, {e:ev});
  if(!requestId) return;
  applied(requestId, ev.id).then(
    ()=>{ markRecent(ev.id, {e:ev}); scheduleReconcile(); },
    err=>{ console.warn('worker write not confirmed:', err); markRecent(ev.id, {e:ev}); toast('Coda didn’t confirm the change. Check again in a minute.','err'); scheduleReconcile(); });
}
// Writes to a just-created row wait for its insert to apply (a failed confirm is
// handled by _unconfirmed, not here).
const afterCreate = id => Promise.resolve(_createApply.get(id)).catch(()=>{});
// Track a new event's insert until Coda applies it; unconfirmed → the pill offers a retry.
function trackCreate(id, requestId){
  const p=applied(requestId, id);
  _createApply.set(id, p);
  p.then(()=>{ _unconfirmed.delete(id); },
         err=>{ console.warn('create not confirmed:', err); _unconfirmed.set(id, requestId); })
   .finally(()=>{ if(_createApply.get(id)===p) _createApply.delete(id); if(editing && editing.id===id) paintSaveStatus(); });
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
  write: (id, cells) => afterCreate(id).then(() => DB.update(id, cells)).then(r => applied(r && r.requestId, id, { counted:false })),
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
