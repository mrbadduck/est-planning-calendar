/* transitions.js — lifecycle transitions (Propose/Approve/Reopen), Cancel, Delete, unpublish, and the Eventbrite-cancel bar (in the panel's #edBars).
   Owns: TRANSITION_STEP, transitionTo, cancelEvent, deleteEditor, unpublishEvent, _ebBlock, clearEbBlock, paintEbBlock
   Reads: editing, activeSection (editor-tabs.js); state, todayStr (state.js); confirmLater, hasUnconfirmed, lateFailMsg (save.js; the flag goes with cancel/unpublish/delete); PageRules (page-rules.js)
   Writes: _form, _busy, _busyLabel, _authRetry, _unconfirmed (save.js); _unsaved (state.js; delete)
   Loaded after: status-panel.js (file-map order; no load-time dependency) */

// Lifecycle transition (Propose/Approve/Reopen): the event's queued field edits
// land first, then the new Status goes out on its own, then the editor is rebuilt
// (openEditor → the event page) so its locks and the Status & next step panel reflect the new state. Works on the event it started
// with — `editing` may close or change while it waits. Cancel is separate (it
// tears down Eventbrite).
const TRANSITION_STEP = { approved:'Approving', proposed:'Proposing', draft:'Reopening' };   // names a late failure
async function transitionTo(status){
  const ev=editing;
  if(!ev || !ev.id || _busy.has(ev.id)) return;
  if(status==='approved' && isPastEvent(ev) && !confirm('This event’s date has passed. Once it’s approved, its details lock and it can’t be cancelled or deleted. Approve anyway?')) return;
  autosaveEditor();                            // queue any field edit still in the form
  _busy.add(ev.id); guardUnload();
  const prev={ status:ev.status, approvedBy:ev.approvedBy, approvedAt:ev.approvedAt };
  ev.status=status;
  ev.editedBy=(state.identity && state.identity.name) || ev.editedBy;
  applyLocal(ev); rerender(); renderStatusPanel();   // in flight: the panel's button says Saving… (R21), no toast
  let fieldsFailed=false;
  try{
    await saveQueue.settle(ev.id).catch(err=>{ fieldsFailed=true; throw err; });
    await afterCreate(ev.id);
    const w=await DB.update(ev.id, [{column:'Status', value:cap(status)}]);
    // Approve → Add to Eventbrite reads the Status through the overlay: wait for the
    // apply only when the write wasn't overlaid.
    // A background failure reverts it like a failed wait does (below), unless a later
    // transition has moved the event on since (PageRules.revertTransition).
    if(w && w.overlaid) confirmLater(w.requestId, ev.id, ()=>{
      if(PageRules.revertTransition(ev, prev, status)){   // (moved on since: the later write decides, say nothing)
        applyLocal(ev); markRecent(ev.id, {e:ev}); rerender();
        toast(lateFailMsg(TRANSITION_STEP[status], ev.title),'err');
      }
      scheduleReconcile();
      if(editing===ev && !_busy.has(ev.id)) openEditor(ev, activeSection, 'none');
    });
    else await applied(w && w.requestId, ev.id);
    if(status==='approved'){                    // the Approved step note, until the next read brings Coda's (display only, never written)
      ev.approvedBy=(state.identity && state.identity.name) || ev.approvedBy;
      ev.approvedAt=todayStr;
    }
    markRecent(ev.id, {e:ev}); scheduleReconcile(); clearEbBlock(ev.id);
    toast(status==='approved'?'Approved':(status==='draft'?'Reopened':'Proposed'),'ok');
  }catch(err){
    Object.assign(ev, prev); applyLocal(ev); rerender();
    if(err && err.status===401) sessionExpired();
    else {
      const unconfirmed = !fieldsFailed && err && err.message==='save not confirmed';   // accepted, but Coda never said it applied
      toast(fieldsFailed ? 'Your changes didn’t save, so the status wasn’t changed — try again' : unconfirmed ? lateFailMsg(TRANSITION_STEP[status], ev.title) : 'Update failed — reverted','err');
      console.warn('transition failed:', err);
      if(unconfirmed) scheduleReconcile();
    }
  }finally{
    _busy.delete(ev.id); guardUnload();
    if(editing===ev) openEditor(ev, activeSection, 'none');   // (openEditor first queues anything typed meanwhile)
  }
}
// Cancel: set Status=Cancelled AND tear down the Eventbrite listing (Worker
// unpublishes, or cancels if it has registrants). Works with or without an EB id.
async function cancelEvent(){
  const ev=editing;
  if(!ev || !ev.id || _busy.has(ev.id)) return;
  if(!confirm('Cancel this event?' + (ev.eventbriteId ? ' Its Eventbrite listing will be taken down.' : ''))) return;
  autosaveEditor();
  _busy.add(ev.id); guardUnload();
  const prev={ status:ev.status, publishStatus:ev.publishStatus };
  _busyLabel.set(ev.id, 'Cancelling…');
  ev.status='cancelled'; applyLocal(ev); rerender(); renderStatusPanel();   // in flight: the panel's button, no toast
  try{
    await saveQueue.settle(ev.id).catch(()=>{});   // queued edits land first; one that fails is reported, not a reason to stop
    const res=await DB.cancelEventbrite(ev.id, hasUnconfirmed(ev.id));
    if(res && res.publishStatus) ev.publishStatus=res.publishStatus;
    trackWorkerWrite(ev, res && res.requestId, res && res.overlaid, 'Cancelling'); scheduleReconcile(); clearEbBlock(ev.id);
    // The event is locked now, so a field edit that failed has nowhere to be retried.
    if(saveQueue.status(ev.id)==='error') dropFailedEdits(ev.id, 'Event cancelled, but your last change to it didn’t save');
    else toast('Event cancelled','ok');
  }catch(err){
    Object.assign(ev, prev); applyLocal(ev); rerender();
    if(err && err.status===401) sessionExpired();
    else if(err && err.status===409 && err.needsEventbriteCancel){ hideToast(); showEbBlock(ev, err); }   // people registered: nothing changed
    else toast((err&&err.message)||'Cancel failed','err');   // (a 409 "still being saved" shows the Worker's words)
  }finally{
    _busy.delete(ev.id); _busyLabel.delete(ev.id); guardUnload();
    if(editing===ev) openEditor(ev, activeSection, 'none');
  }
}
async function deleteEditor(){
  const ev=editing;
  if(!ev || !ev.id) return;   // (only a saved event's page offers Delete)
  if(_busy.has(ev.id)) return;
  if(!confirm('Delete this event? This can\'t be undone.' + (ev.eventbriteId ? ' Its private Eventbrite draft is deleted too.' : ''))) return;
  const id=ev.id;
  _busy.add(id); _busyLabel.set(id, 'Deleting…');
  _form=null; _unsaved.delete(id); _authRetry.delete(id); guardUnload();   // its unsaved edits go with it — leaving the page has nothing to queue or retry
  const drained=saveQueue.discard(id);
  // The editor stays open (inert) while the delete runs: its panel button says
  // Deleting… (R21) instead of a busy toast. It closes once the row is gone.
  const panel=document.getElementById('wpanel'); if(panel) panel.inert=true;
  applyLocal({id}, true); rerender(); renderStatusPanel();
  try{
    await drained;                             // …and a write already in flight finishes before the delete
    await afterCreate(id);                     // a just-created row: let its insert apply first
    await DB.remove(id, hasUnconfirmed(id));
    _unconfirmed.delete(id);
    markRecent(id, { deleted:true });
    if(editing===ev) leaveEventPage('back');   // the event is gone: back to the calendar
    toast('Deleted','ok'); scheduleReconcile();
  }catch(err){
    applyLocal(ev); rerender();
    if(err && err.status===401) sessionExpired();
    else { toast((err && (err.status===409 || err.status===502) && err.message) || 'Delete failed — restored','err'); console.warn('delete failed:', err); }   // the Worker's reason (cancel first / still being saved / Eventbrite refused); the row is kept
  }finally{
    _busy.delete(id); _busyLabel.delete(id); guardUnload();
    if(editing===ev) openEditor(ev, activeSection, 'none');   // failed (success closed it): back to a live editor — its form was let go
  }
}

// Unpublish (back to private): the listing goes back to a private Eventbrite draft
// and gather hides it. Refused (409 needsEventbriteCancel) once anyone registered.
async function unpublishEvent(){
  const ev=editing;
  if(!ev || !ev.id || !ev.eventbriteId || _busy.has(ev.id)) return;
  if(!confirm('Make this listing private again? It disappears from Eventbrite and gather until you publish it again.')) return;
  const id=ev.id;
  _busy.add(id); _busyLabel.set(id, 'Unpublishing…'); guardUnload(); renderStatusPanel();   // in flight: the panel's button (R21)
  try{
    const res=await DB.unpublishEventbrite(id, hasUnconfirmed(id));
    ev.publishStatus=(res && res.publishStatus) || 'Draft';
    clearEbBlock(id);
    applyLocal(ev); rerender();
    trackWorkerWrite(ev, res && res.requestId, res && res.overlaid, 'Unpublishing'); scheduleReconcile();
    toast('Unpublished. It’s a private draft on Eventbrite again','ok');
    refreshEbStatus(ev);
  }catch(err){
    if(err && err.status===401) sessionExpired();
    else if(err && err.status===409 && err.needsEventbriteCancel){ hideToast(); showEbBlock(ev, err); }
    else { toast((err && err.message) || 'Couldn’t unpublish. Try again.','err'); scheduleReconcile(); }   // (e.g. it was cancelled on Eventbrite)
  }finally{
    _busy.delete(id); _busyLabel.delete(id); guardUnload();
    if(editing===ev) renderStatusPanel();     // panel + card only (D1)
  }
}
// Eventbrite-cancel bar (Q2): Unpublish/Cancel refused because people registered.
// Shows the Worker's message, Open in Eventbrite and Email the N registrants. The
// status doesn't change; the bar goes on the next successful action or on close.
let _ebBlock=null;   // { id, error, registrants } for the open editor's event
function showEbBlock(ev, err){
  if(editing!==ev) return;                     // the editor moved on meanwhile
  _ebBlock={ id:ev.id, error:(err && err.message) || '', registrants:Number(err && err.registrants) || 0 };
  if(_ebBlock.registrants > 0) prefetchRegistrants(ev.id);
  paintEbBlock();
}
function clearEbBlock(id){ if(_ebBlock && (!id || _ebBlock.id===id)){ _ebBlock=null; paintEbBlock(); } }
// Painted into the panel's #edBars (inside the Status & next step card, spec 5.3)
// by renderStatusPanel and whenever the bar changes.
function ebBlockHTML(){
  const b=_ebBlock, ev=editing;
  if(!b || !ev || ev.id!==b.id) return '';
  const url=/^https?:\/\//i.test(ev.eventbriteUrl || '') ? ev.eventbriteUrl : '';
  const n=b.registrants;
  return `<div class="sp-bar" role="alert"><span class="edguard-msg">${esc(b.error)}</span>`
    + (url ? `<a class="btn fbtn sec" href="${esc(url)}" target="_blank" rel="noopener">Open in Eventbrite ↗</a>` : '')
    + (n > 0 ? `<button type="button" class="btn fbtn sec" data-block="email">Email the ${n} registrant${n===1?'':'s'}</button>` : '')
    + `</div>`;
}
function paintEbBlock(){
  const bar=document.getElementById('edBars'); if(bar) paintInner(bar, ebBlockHTML());
}
