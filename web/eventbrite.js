/* eventbrite.js — the Eventbrite push (Add / Update draft / Publish / Update listing), the live-status poll and the registrant emails.
   Owns: PUSH_ACTS, EB_CONFLICT_NOTICE, _ebStatus, _pushChecks, _conflictShown, _pushing, _sending,
         _justChanged, ebConflict, ebCapacity, mergePushChecks, refreshEbStatus, dismissChangeNotice,
         _regFetch, prefetchRegistrants, emailRegistrants, emailAfterChange, pushToEventbrite
   Reads: editing (editor-tabs.js); _ctx (editor.js); _unconfirmed, hasUnconfirmed (save.js)
   Writes: _busy (save.js; add/delete)
   Loaded after: transitions.js (file-map order; no load-time dependency) */

/* ---- Eventbrite push: Add to Eventbrite / Update draft / Publish / Update listing
   (spec 5.3–5.6, D8). The Worker builds the listing from the row it reads (Coda's,
   with overlaid writes merged in), so every edit must have reached it first (and,
   when not overlaid, applied: settledForPush); it re-checks readiness and answers 409 {error,
   checks} or 409 {conflict} (Eventbrite edited since our last push). On success
   it returns the snapshot it stored (`pushed`, R15), which the app adopts as-is.
   Nothing from the live status is ever put into the form or written (D4). */
// step: names the push in a late-failure toast (PageRules.lateFailMsg; {title} → “<title>”).
const PUSH_ACTS = {
  'add-eb':         { draftOnly:true,  ok:'Added to Eventbrite as a private draft', step:'Adding {title} to Eventbrite' },
  'update-eb':      { draftOnly:true,  ok:'Eventbrite draft updated',               step:'Updating the draft of' },
  'publish-eb':     { draftOnly:false, ok:'Published. Registration is open',        step:'Publishing' },
  'update-listing': { draftOnly:false, ok:'Eventbrite listing updated',             step:'Updating the listing of' },
};
const EB_CONFLICT_NOTICE = ListingRules.EB_CONFLICT_NOTICE;   // one text for the card and the panel
const _ebStatus=new Map();      // event id → { editedSincePush, sold, liveStatus } from GET /eventbrite/status (session-local)
const _ebStatusSeq=new Map();   // event id → latest request number (an older answer never overwrites a newer one)
const _pushChecks=new Map();    // event id → { draftOnly, checks } the Worker's last readiness 409, until the next edit
const _ebConflict=new Set();    // event ids whose last push got the conflict 409
const _conflictShown=new Set(); // event ids whose conflict notice has been shown: the next push sends force
const _pushing=new Set();       // event ids with a push under way (saving first, then sending)
const _sending=new Set();       // event ids whose Worker call is in flight (primary: Sending to Eventbrite…)
const _lastPushAt=new Map();    // event id → Last EB push at our own last push wrote (from the success body)
// A status/conflict answer that read Coda's Last EB push at from before our own last
// push (Coda's apply lag, 13–30 s) can't say whether Eventbrite was edited since.
// Treat it as no conflict. 2 s of slack covers Coda storing the time less precisely.
// Coda's "Last EB push at" must stay a text column: a date column would round the time and break this exact comparison.
function predatesOurPush(id, theirs){
  const mine=_lastPushAt.get(id); if(!mine) return false;
  const t=Date.parse(theirs||''); if(isNaN(t)) return true;
  return t < Date.parse(mine) - 2000;
}
const _justChanged=new Map();   // event id → { fields, registrants } after an Update listing that moved date/time/venue
const ebConflict = id => !!((_ebStatus.get(id)||{}).editedSincePush || _ebConflict.has(id));
// The capacity Eventbrite has (the pushed one), else the form's.
const ebCapacity = ev => ev.pushed && Number(ev.pushed.capacity) > 0 ? Number(ev.pushed.capacity) : ev.capacity;
// The Worker's failed checks override the app's own for the step it was asked for
// (a publish-step answer leaves the add checks alone), so the panel links and
// field tags point at what the server found missing.
function mergePushChecks(local, wc){
  if(!wc || !wc.checks || !wc.checks.length) return local;
  const over = list => {
    const out = list.map(c => { const w=wc.checks.find(x=>x.key===c.key); return w ? Object.assign({}, c, w, { ok:false }) : c; });
    for(const w of wc.checks) if(!out.some(c=>c.key===w.key)) out.push(Object.assign({}, w, { ok:false }));
    return out;
  };
  return { add: wc.draftOnly ? over(local.add) : local.add, publish: over(local.publish) };
}
// Live Eventbrite status for a linked event: registrants and whether someone edited
// the listing on Eventbrite since our last push. Display only.
async function refreshEbStatus(ev){
  if(!ev || !ev.id || !ev.eventbriteId) return;
  const id=ev.id, seq=(_ebStatusSeq.get(id)||0)+1;
  _ebStatusSeq.set(id, seq);
  let r=null;
  try{ r=await DB.ebStatus(id); }catch(_){ r=null; }
  if(_ebStatusSeq.get(id)!==seq || !r || !r.linked || !r.live) return;   // superseded, or nothing to show
  _ebStatus.set(id, { editedSincePush: !!r.editedSincePush && !predatesOurPush(id, r.lastPushAt), sold: r.live.sold!=null ? Number(r.live.sold) : null, liveStatus: r.live.status || '' });
  if(editing && editing.id===id) renderStatusPanel();   // panel + card; another open event ignores it
}
function dismissChangeNotice(){
  if(!editing) return;
  _justChanged.delete(editing.id); renderStatusPanel();
}
/* ---- Email registrants (Q3 interim, until Mailchimp comms exist): a BCC mailto:
   in the lead's own mail app, to the roster's Eventbrite registrants (orders —
   not gather-only sign-ups). Built with the Attendees tab's RosterLib helpers;
   past MAILTO_LIMIT the emails go to the clipboard and the draft opens with the
   subject + body only, so the change notice is never lost. The roster is fetched
   ahead (when the notice or the Eventbrite-cancel bar appears) and a click only
   uses a settled read, so the mail app opens inside the user-gesture window —
   never late. */
const MAILTO_LIMIT=1800;
const REG_FETCH_TTL=60000;
const _regFetch=new Map();   // event id → { at, settled, data, err }: a roster read started ahead of the click
const _emailing=new Set();   // event ids with an Email click being handled
function prefetchRegistrants(id){
  const entry={ at:Date.now(), settled:false, data:null, err:null };
  _regFetch.set(id, entry);
  DB.roster(id, true).then(d=>{ entry.data=d; }, e=>{ entry.err=e || new Error('roster failed'); }).finally(()=>{ entry.settled=true; });
}
function openMailto(href){ const a=document.createElement('a'); a.href=href; a.hidden=true; document.body.appendChild(a); a.click(); a.remove(); }
// Returns true when it acted (the mail app opened, or the emails were copied).
async function emailRegistrants(ev, subject, body){
  if(!ev || !ev.id || _emailing.has(ev.id)) return false;
  const L=window.RosterLib;
  let f=_regFetch.get(ev.id);
  if(f && Date.now()-f.at > REG_FETCH_TTL){ _regFetch.delete(ev.id); f=null; }   // too old to trust
  if(!f || !f.settled){                        // nothing ready: load now, the next click sends
    if(!f) prefetchRegistrants(ev.id);
    toast('Loading registrants…');            // (auto-hides: no click may follow)
    return false;
  }
  if(f.err){
    _regFetch.delete(ev.id);                   // the next click tries again
    if(f.err.status===401) sessionExpired();
    else toast(f.err.message || 'Couldn’t load the registrants. Try again.','err');
    return false;
  }
  _emailing.add(ev.id);
  try{
    const emails=L.emailsOf(((f.data && f.data.rows) || []).filter(r=>r.kind==='order'));
    if(!emails.length){ toast('No registrant emails to send to.','err'); return false; }
    const href=L.mailtoHref(emails, subject, body, MAILTO_LIMIT);
    if(href){ hideToast(); openMailto(href); return true; }
    // Too long for one link: emails to the clipboard (focus still here), then the draft with the text.
    if(!(await copyText(emails.join(', ')))){ toast('Couldn’t reach the clipboard. Use Copy emails on the Attendees tab.','err'); return false; }
    const draft=L.mailtoHref([], subject, body, Infinity);
    if(draft && draft!=='mailto:?') openMailto(draft);
    toast('Emails copied. Paste them into BCC.','ok');
    return true;
  }finally{ _emailing.delete(ev.id); }
}
// "Email registrants" on the after-update notice: subject + body from changeNotice.
async function emailAfterChange(){
  const ev=editing, jc=ev && _justChanged.get(ev.id);
  if(!jc) return;
  if(await emailRegistrants(ev, jc.subject, jc.body)){
    _justChanged.delete(ev.id);              // the lead acted: the notice is done
    if(editing===ev) renderStatusPanel();
  }
}
// Wait until nothing for this event is queued or in flight, and (for a write that
// wasn't overlaid, or a create) applied — pendingFor drops an overlaid write once its
// request returns. Resolves false when an edit failed or a create was never
// confirmed (nothing to wait for).
async function settledForPush(id){
  const deadline=Date.now()+150000;            // waitApplied gives up at 120 s (a fallback wait or a create)
  while(pendingFor(id)){
    if(_unconfirmed.has(id) || Date.now()>deadline) return false;
    await saveQueue.settle(id).catch(()=>{});
    await afterCreate(id);
    if(pendingFor(id)) await new Promise(r=>setTimeout(r, 300));
  }
  return saveQueue.status(id)!=='error' && !_unconfirmed.has(id);
}
async function pushToEventbrite(act){
  const spec=PUSH_ACTS[act], ev=editing;
  if(!spec || !ev || !ev.id || !_ctx || _ctx.ev!==ev || _busy.has(ev.id)) return;
  const m=editorFooterModel(ev, _ctx);
  if(!m.primary || m.primary.act!==act || !m.primary.enabled) return;   // only the action the panel offers right now
  const id=ev.id, force=_conflictShown.has(id);
  _busy.add(id); _pushing.add(id); guardUnload();
  if(editing===ev) renderStatusPanel();
  try{
    try{ await flushAutosave(); }
    catch(err){
      if(err && err.status===401) sessionExpired();
      else toast('Your changes didn’t save, so nothing was sent to Eventbrite. Try again.','err');
      return;
    }
    if(!(await settledForPush(id))){
      toast('Your changes didn’t save, so nothing was sent to Eventbrite. Try again.','err');
      return;
    }
    _sending.add(id); if(editing===ev) renderStatusPanel();   // the panel's button says Sending to Eventbrite… (R21), no busy toast
    let res;
    try{ res=await DB.publishEventbrite(id, spec.draftOnly, force, hasUnconfirmed(id)); }
    catch(err){
      _sending.delete(id);
      if(err && err.status===401){ sessionExpired(); return; }
      // The Worker may have created the event (or written the row) before failing:
      // adopt its id so nothing re-creates it, and wait for that write to apply.
      if(err && err.eventbriteId && !ev.eventbriteId){ ev.eventbriteId=err.eventbriteId; applyLocal(ev); rerender(); }
      if(err && (err.requestId || err.eventbriteId)) trackWorkerWrite(ev, err.requestId, err.overlaid, spec.step);
      if(err && err.status===409 && err.checks && err.checks.length){
        _pushChecks.set(id, { draftOnly: spec.draftOnly, checks: err.checks });
        toast(err.checks[0].message || err.message,'err');
      } else if(err && err.status===409 && err.conflict && predatesOurPush(id, err.lastPushAt)){
        toast('Your last update is still being saved. Try again in a few seconds.','err');   // Coda lag, not an edit
      } else if(err && err.status===409 && err.conflict){
        _ebConflict.add(id);
        toast(EB_CONFLICT_NOTICE,'err');
      } else {
        toast((err && err.message) || 'Couldn’t reach Eventbrite. Try again.','err');
        scheduleReconcile();                   // the Worker may have recorded the error on the row
      }
      return;
    }
    _sending.delete(id);
    const prevPushed=ev.pushed || null;
    _lastPushAt.set(id, res.lastPushAt || new Date().toISOString());
    // The step notes read these; mirror what the Worker just wrote so they don't lag
    // until the next read. Display only: eventToCodaCells never writes them.
    ev.lastEbPushAt=_lastPushAt.get(id);
    if(!spec.draftOnly) ev.lastPublishedAt=ev.lastEbPushAt;   // the Worker stamps Last published at on every public push
    if(res.eventbriteId) ev.eventbriteId=String(res.eventbriteId);
    if(res.url) ev.eventbriteUrl=res.url;
    ev.publishStatus = res.publishStatus || (spec.draftOnly ? 'Draft' : 'Published');
    ev.lastPublishError='';
    if(res.pushed && typeof res.pushed==='object') ev.pushed=res.pushed;   // R15: the Worker's own snapshot
    _pushChecks.delete(id); _ebConflict.delete(id); _conflictShown.delete(id); clearEbBlock(id);
    const st=_ebStatus.get(id); if(st) st.editedSincePush=false;
    applyLocal(ev); rerender();
    trackWorkerWrite(ev, res.requestId, res.overlaid, spec.step); scheduleReconcile();
    let msg=spec.ok;
    if(act==='update-listing' && prevPushed && ev.pushed){
      const n=ListingRules.changeNotice(prevPushed, ev.pushed, ev);
      if(n.fields.length){
        if(!_ebStatus.has(id)) await refreshEbStatus(ev);   // registrants not loaded yet: read them before deciding
        const st2=_ebStatus.get(id);
        const sold = st2 && st2.sold!=null ? Number(st2.sold) : 0;
        if(sold > 0){ _justChanged.set(id, { fields:n.fields, registrants:sold, subject:n.subject, body:n.body }); prefetchRegistrants(id); }
      }
    }
    if(res.ticketNote) msg += '. ' + res.ticketNote;   // R16: the toast is the action's copy, plus the ticket note as its own sentence
    toast(msg,'ok');
    refreshEbStatus(ev);
  }finally{
    _busy.delete(id); _pushing.delete(id); _sending.delete(id); guardUnload();
    if(editing===ev) renderStatusPanel();     // panel + card only (D1); the form keeps focus and values
  }
}
