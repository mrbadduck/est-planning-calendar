/* venue-form.js — the Where block's venue address line, and the venue dialog (#venueDialog): add a venue, fix a venue's address.
   Owns: venueSlotsHTML, wireVenueForm, paintVenueAddr, openVenueAdd, openVenueAddress, openVenueFormFor, closeVenueForm, dismissVenueDialog;
         the dialog's Esc (capture phase), focus-trap and scrim listeners
   Reads: VENUES, VENUE_TYPES, DB, cacheSet, setVenues, refreshVenues (data.js); VenueAddress (venue-address.js); CodaApplied (coda-applied.js);
          editing (editor-tabs.js); esc (util.js); toast (ui.js; call time); renderStatusPanel (status-panel.js; call time);
          _pushChecks (eventbrite.js; call time)
   Writes: VENUES (via setVenues + an entry's hasAddress); _pushChecks (eventbrite.js; delete)
   Loaded after: tabs-listing-planning.js and preview.js (its capture-phase Esc listener must register before editor-close.js's and help.js's) */

/* Spec 5.3. Two stable containers (D1, painted with paintInner):
   #venueAddr — in the Where block, under the picked venue, for editors only: its address
     (GET /venues/:id, once per venue per session), or "No street address yet", with
     Edit address / Add address;
   #vdBox — inside #venueDialog (index.html), a modal dialog above the event page and the
     create form's #modal: mode 'add' ("Add a venue": the picker's + Add "<name>" as a
     venue, or the venueOther readiness link) or 'address' ("Edit address": Edit/Add
     address, or the venueAddress readiness link; Name and Venue type read-only).
     Esc, Cancel and a scrim click close it, except while a write waits for Coda (busy);
     Tab stays inside it; focus goes back to whatever opened it.
   A write waits until Coda has applied it (D3) before the app uses the new row or
   says the address changed: an event must never point at a venue row Coda hasn't
   applied. /ref/venues is busted before Coda applies, so the local VENUES list is
   updated here at once, then refreshVenues re-reads /ref/venues?fresh=1 in the
   background (the write has applied by then) and refills the Worker's caches.
   A PUT with the address already saved comes back {unchanged:true}: no wait. Read-only, locked and signed-out views get
   neither container's controls and fetch nothing. */
const _vaddr=new Map();   // venue id → { status:'loading'|'ok'|'err', v:{id,name,type,street,unit,city,state,zip,address} }
let _vctx=null;           // { ev, editable } for the Where block on screen
let _vf=null;             // the open form: { mode, venueId, ev, busy, detached } (detached: its dialog was taken down mid-write)
let _vdOpener=null;       // the element focused when the dialog opened: focus goes back to it
let _vfPendingAdd=null;   // an add whose row Coda never confirmed: { key, name, id, requestId } — retried by polling, never re-POSTed
const VF_DEFAULTS={ city:'Nashville', state:'TN' };
const venueTypeName = id => (VENUE_TYPES.find(t=>t.id===id)||{}).name || '';
const venueHome = typeName => typeName==='Home';   // only a private home may have no address

function venueSlotsHTML(){
  return `<div class="vaddr" id="venueAddr" aria-live="polite"></div>`;
}
// Called by wireEventFields once the venue picker is set up. A Where block rebuilt for
// another event takes down an open dialog (an add already sent finishes on its own and
// toasts). Every lookup is scoped to the Where block wired here (the venue box's
// .fieldgroup), so a second copy of the same ids elsewhere in the document can never be
// read or painted. The address line is wired once (_vfWired); all submits go through submitVenueForm.
function wireVenueForm(ev, editable, box){
  const group=box && box.closest('.fieldgroup');
  const addrEl=group && group.querySelector('#venueAddr');
  _vctx={ ev, editable:!!editable, group, box, addrEl };
  if(_vf && (_vf.ev!==ev || !editable)) dismissVenueDialog();
  if(!addrEl) return;
  if(addrEl._vfWired){ paintVenueAddr(); return; }
  addrEl._vfWired=true;
  addrEl.addEventListener('click', e=>{
    const b=e.target.closest('[data-vact]'); if(!b) return;
    if(b.dataset.vact==='edit') openVenueAddress();
    else if(b.dataset.vact==='retry'){ _vaddr.delete(b.dataset.id); paintVenueAddr(); }
  });
  paintVenueAddr();
}
const vdScrim = () => document.getElementById('venueDialog');
const vdOpen = () => !vdScrim().hidden;
const vfEl = () => vdOpen() ? document.getElementById('vdBox') : null;
const vfEditable = () => !!(_vctx && _vctx.editable && _vctx.ev===editing && _vctx.addrEl && _vctx.addrEl.isConnected);
const pickedVenueId = () => { const b=_vctx && _vctx.box; return (b && b.dataset.venueId) || ''; };
function addrVisibility(){
  const p=_vctx && _vctx.group && _vctx.group.querySelector('#f_addrvis button[aria-pressed="true"]');
  return p ? p.dataset.addrvis : ((_vctx && _vctx.ev.addressVisibility) || '');
}
function venueAddrText(v){ return (v.street || v.city) ? VenueAddress.compose(v) : String(v.address||'').trim(); }
function fetchVenueAddr(id){
  const ent={ status:'loading', v:null };
  _vaddr.set(id, ent);
  ent.p=DB.getVenue(id).then(v=>{ ent.status='ok'; ent.v=v||{}; }, err=>{ console.warn('venue read failed:', err); ent.status='err'; })
    .finally(()=>{ if(_vaddr.get(id)===ent) paintVenueAddr(); });
  return ent;
}
// The address line under the picked venue (editors only).
function paintVenueAddr(){
  const el=_vctx && _vctx.addrEl; if(!el || !el.isConnected) return;
  const id=pickedVenueId();
  if(_vf && _vf.mode==='address' && !_vf.busy && _vf.venueId!==id) closeVenueForm();   // a different venue now
  if(!vfEditable() || !id){ paintInner(el, ''); return; }
  const ent=_vaddr.get(id) || fetchVenueAddr(id);
  let h;
  if(ent.status==='loading') h=`<span class="vaddr-txt">Loading address…</span>`;
  else if(ent.status==='err') h=`<span class="vaddr-txt">Couldn’t load the address.</span> <button type="button" class="lnk" data-vact="retry" data-id="${esc(id)}">Try again</button>`;
  else {
    const t=venueAddrText(ent.v);
    h = t ? `<span class="vaddr-txt">${esc(t)}</span>${addrVisibility()==='Registrants only' ? `<span class="vaddr-priv"> · Shared with registrants only</span>` : ''} <button type="button" class="lnk" data-vact="edit">Edit address</button>`
      : `<span class="vaddr-txt none">No street address yet</span> <button type="button" class="lnk" data-vact="edit">Add address</button>`;
  }
  paintInner(el, h);
}

/* ---- the dialog ---- */
function vfFieldHTML(key, label, value, attrs){
  return `<div class="fld vf-${key}"><label for="vf_${key}">${label}</label><input id="vf_${key}" value="${esc(value||'')}" autocomplete="off" ${attrs||''}><span class="hint err" data-err="${key}"></span></div>`;
}
function venueFormHTML(mode, v){
  const add=mode==='add';
  const types=`<option value="">Choose…</option>` + VENUE_TYPES.map(t=>`<option value="${esc(t.id)}" ${t.id===v.typeId?'selected':''}>${esc(t.name)}</option>`).join('');
  return `<div class="vd-head"><h2 id="vdTitle">${add?'Add a venue':'Edit address'}</h2><span class="vd-sub" id="vdSub">${esc(v.name||'')}</span></div>`
    + `<div class="vd-body"><fieldset class="vform-fs"><div class="vform-grid">`
    + vfFieldHTML('name', 'Name', v.name, add ? 'maxlength="120"' : 'disabled')
    + `<div class="fld vf-type"><label for="vf_type">Venue type</label><select id="vf_type" ${add?'':'disabled'}>${types}</select><span class="hint err" data-err="type"></span></div>`
    + vfFieldHTML('street', 'Street', v.street, 'maxlength="120" autocomplete="address-line1"')
    + vfFieldHTML('unit', 'Unit (optional)', v.unit, 'maxlength="120" autocomplete="address-line2"')
    + vfFieldHTML('city', 'City', v.city, 'maxlength="120" autocomplete="address-level2"')
    + vfFieldHTML('state', 'State', v.state, 'maxlength="2" autocomplete="address-level1"')
    + vfFieldHTML('zip', 'ZIP', v.zip, 'inputmode="numeric" maxlength="10" autocomplete="postal-code"')
    + `</div>`
    + (v.legacy ? `<span class="hint">Saved now as: ${esc(v.legacy)}</span>` : '')
    + (add ? '' : `<span class="hint">This changes the address for every event at this venue.</span>`)
    + `<span class="hint err" data-err="form" role="alert"></span><span class="hint" data-vf-slow aria-live="polite"></span></fieldset></div>`
    + `<div class="mfoot vd-foot"><span class="push"></span><button type="button" class="btn" data-vact="cancel">Cancel</button><button type="button" class="btn primary" data-vact="submit">${add?'Add venue':'Save address'}</button></div>`;
}
// Focusable controls inside the dialog (a disabled fieldset's fields don't count).
const vdFocusables = box => [...box.querySelectorAll('input,select,button')].filter(el=>!el.matches(':disabled') && el.getClientRects().length);
function showVenueForm(mode, venueId, v){
  const box=document.getElementById('vdBox');
  const a=document.activeElement;
  _vdOpener = (a && a!==document.body && !box.contains(a)) ? a : null;
  _vf={ mode, venueId, ev:editing, busy:false, detached:false };
  hideTip();
  paintInner(box, venueFormHTML(mode, v));
  vdScrim().hidden=false;
  document.body.classList.add('vd-open');
  // the first empty field (Unit is optional, so skipped); all filled: Street (Name when adding without one)
  const first=['name','type','street','city','state','zip'].map(k=>box.querySelector('#vf_'+k)).find(el=>el && !el.disabled && !el.value)
    || box.querySelector(mode==='add' && !v.name ? '#vf_name' : '#vf_street');
  if(first) first.focus();
  return first;
}
// + Add "<name>" as a venue (the picker) and the venueOther readiness link.
// A write still waiting for Coda holds the form: say so rather than ignore the click.
function vfBusyNote(){
  if(!(_vf && _vf.busy)) return false;
  toast(_vf.mode==='add' ? 'Still adding the last venue…' : 'Still saving the last address…');
  return true;
}
function openVenueAdd(name){
  if(!vfEditable() || vfBusyNote()) return null;
  const sel=_vctx.group.querySelector('#f_vtype');
  return showVenueForm('add', '', Object.assign({ name:String(name||'').trim(), typeId:(sel && sel.value)||'', street:'', unit:'', zip:'' }, VF_DEFAULTS));
}
// Edit address / Add address and the venueAddress readiness link.
function openVenueAddress(){
  const id=pickedVenueId();
  if(!vfEditable() || !id || vfBusyNote()) return null;
  const ent=_vaddr.get(id);
  if(!ent || ent.status!=='ok'){   // not loaded yet: open once it is (a failed read: the line offers Try again)
    paintVenueAddr();
    const now=_vaddr.get(id);
    if(now && now.status==='loading') now.p.then(()=>{ if(now.status==='ok' && pickedVenueId()===id && !_vf) openVenueAddress(); });
    return null;
  }
  const v=ent.v, rec=VENUES.find(x=>x.id===id)||{};
  const structured=!!(v.street || v.city);
  return showVenueForm('address', id, { name:v.name||rec.name||'', typeId:(VENUE_TYPES.find(t=>t.name===(v.type||rec.type))||{}).id||'',
    street:v.street, unit:v.unit, city:structured ? v.city : VF_DEFAULTS.city, state:(structured && v.state) || VF_DEFAULTS.state, zip:v.zip,
    legacy: structured ? '' : String(v.address||'').trim() });
}
// A readiness ✗ link (focusField → Where): open the form its check asks for. Returns the
// element it focused, or null when there's no form to open (read-only, locked).
function openVenueFormFor(check){
  if(check==='venueOther'){
    const other=_vctx && _vctx.box && _vctx.box.querySelector('.venue-other-wrap:not([hidden]) .venue-other');
    return openVenueAdd(other ? other.value : ((editing && editing.venueOther) || ''));
  }
  if(check==='venueAddress') return openVenueAddress();
  return null;
}
function vdHide(){
  const box=document.getElementById('vdBox');
  vdScrim().hidden=true; document.body.classList.remove('vd-open');
  paintInner(box, '');
}
// Cancel, Esc, a scrim click and a finished write: close and put focus back where it was
// (the picker input or the Edit/Add address link; if that's gone, the address line's link,
// else the picker input). Never while a write is waiting for Coda.
function closeVenueForm(){
  if(_vf && _vf.busy) return;
  const shown=vdOpen();
  _vf=null;
  vdHide();
  if(!shown) return;
  hideTip();
  const back=[_vdOpener, _vctx && _vctx.addrEl && _vctx.addrEl.querySelector('[data-vact="edit"]'), _vctx && _vctx.box && _vctx.box.querySelector('.ta-input')]
    .find(el=>el && el.isConnected && el.getClientRects().length && !el.disabled);
  _vdOpener=null;
  if(back) back.focus({ preventScroll:true });
}
// The page or the create form is going away (or its Where block now shows another event):
// take the dialog down even mid-write. That write still finishes and says how it went in a toast.
function dismissVenueDialog(){
  if(_vf && _vf.busy){ _vf.detached=true; _vdOpener=null; vdHide(); return; }
  _vdOpener=null; _vf=null;
  if(vdOpen()) vdHide();
}
function vfRead(){
  const el=vfEl(), g=k=>{ const e=el && el.querySelector('#vf_'+k); return e ? e.value : ''; };
  return { name:g('name').replace(/\s+/g,' ').trim(), typeId:g('type'),
    addr:VenueAddress.normalize({ street:g('street'), unit:g('unit'), city:g('city'), state:g('state'), zip:g('zip') }) };
}
function vfErrors(errs, formMsg){
  const el=vfEl(); if(!el) return;
  el.querySelectorAll('[data-err]').forEach(s=>{ const k=s.dataset.err; s.textContent = k==='form' ? (formMsg||'') : ((errs && errs[k]) || ''); });
  const bad=el.querySelector('[data-err]:not(:empty)'); const inp=bad && bad.closest('.fld') && bad.closest('.fld').querySelector('input,select');
  if(inp && !inp.disabled) inp.focus();
  else if(formMsg){ const b=el.querySelector('[data-vact="submit"]'); if(b) b.focus(); }   // a form-level message: stay in the dialog
}
// Busy: the whole dialog is disabled in place (no repaint, so nothing typed is lost):
// fields, Cancel and the primary, which shows a spinner and the busy label. Focus parks on
// the dialog itself so Tab and Esc stay inside it.
function vfBusy(on, label){
  const el=vfEl(); if(!el) return;
  const fs=el.querySelector('fieldset'), btn=el.querySelector('[data-vact="submit"]'), cancel=el.querySelector('[data-vact="cancel"]'), slow=el.querySelector('[data-vf-slow]');
  if(fs) fs.disabled=on;
  if(cancel) cancel.disabled=on;
  el.setAttribute('aria-busy', String(!!on));
  if(btn){
    btn.disabled=on;
    if(on){ btn.dataset.label=btn.textContent; btn.innerHTML=`<span class="ndoc-spin" aria-hidden="true"></span>${esc(label)}`; }
    else if(btn.dataset.label) btn.textContent=btn.dataset.label;
  }
  if(on) el.focus({ preventScroll:true });
  if(slow && !on) slow.textContent='';
}
// Wait for Coda to apply a venue write (the same poller as event saves, D3).
function venueApplied(requestId){
  return CodaApplied.waitApplied(requestId, {
    fetchStatus: rid => DB.mutationStatus(rid),
    sleep: ms => new Promise(r => setTimeout(r, ms)),
    now: () => Date.now(),
    onSlow: () => { const el=vfEl(), s=el && el.querySelector('[data-vf-slow]'); if(s) s.textContent='Coda is slow right now. This can take a minute.'; },
  });
}
// The dialog this write came from is still showing (not taken down by leaving the page or the create form).
const vfOnScreen = f => { const el=vfEl(); return _vf===f && !f.detached && !!(el && el.querySelector('fieldset')); };
// The one way a venue write starts (the button's click and Enter in a field both land
// here). _vfSubmitting is set before anything else runs and cleared only when that
// submit has finished, so no second request can start meanwhile.
let _vfSubmitting=false;
async function submitVenueForm(){
  if(_vfSubmitting || !_vf || _vf.busy || !vfEl() || !vfEditable()) return;
  _vfSubmitting=true;
  try{ await (_vf.mode==='add' ? submitAdd(_vf) : submitAddress(_vf)); }
  finally{ _vfSubmitting=false; }
}
async function submitAdd(f){
  const { name, typeId, addr }=vfRead(), typeName=venueTypeName(typeId);
  const errs=Object.assign({}, VenueAddress.validate(addr, { allowBlank:venueHome(typeName) }).errors);
  if(!name) errs.name='Add the name';
  else if(VENUES.some(v=>VenueAddress.sameName(v.name, name))) errs.name=`A venue called ${name} already exists`;
  // An add Coda hasn't confirmed may still land: the same name must retry with the same details (it polls), never insert again.
  else if(_vfPendingAdd && VenueAddress.sameName(_vfPendingAdd.name, name) && _vfPendingAdd.key!==JSON.stringify(Object.assign({ name, typeId }, addr)))
    errs.name=`${name} is still being added. Add it again with the same details, or wait a minute and reload.`;
  if(!typeId) errs.type='Choose a venue type';
  if(Object.keys(errs).length){ vfErrors(errs); return; }
  vfErrors(null); f.busy=true; vfBusy(true, 'Adding venue…');
  const body=Object.assign({ name, typeId }, addr), key=JSON.stringify(body);
  try{
    let p=_vfPendingAdd && _vfPendingAdd.key===key ? _vfPendingAdd : null;   // the same add again: poll, don't insert twice
    if(!p){ const r=await DB.createVenue(body); p=_vfPendingAdd={ key, name, id:r && r.id, requestId:(r && r.requestId)||'' }; }
    if(!p.id) throw new Error('The Worker didn’t return the new venue');
    try{ await venueApplied(p.requestId); }
    catch(_){ const e=new Error('Coda didn’t confirm the new venue yet. Try Add venue again in a minute.'); e.unconfirmed=true; throw e; }
    _vfPendingAdd=null;
    const v={ id:p.id, name, type:typeName, closed:false, hasAddress:VenueAddress.hasAddress(addr) };
    setVenues(VENUES.filter(x=>x.id!==v.id).concat([v])); cacheSet('venues', VENUES);
    refreshVenues(v.id);   // not awaited: pulls the applied list past the Worker's caches
    _vaddr.set(v.id, { status:'ok', v:Object.assign({ id:v.id, name, type:typeName, address:VenueAddress.compose(addr) }, addr) });
    f.busy=false;
    const shown=vfOnScreen(f);
    if(_vf===f) closeVenueForm();
    const box=_vctx && _vctx.box;
    const picked = !!(box && box.isConnected && box.pickVenue && editing===f.ev && box.pickVenue(v.id));   // the picker's onChange: address default, address line, autosave
    if(picked && shown){ const l=_vctx.addrEl && _vctx.addrEl.querySelector('[data-vact="edit"]'); if(l) l.focus({ preventScroll:true }); }   // the picker's input is hidden now
    toast(picked ? 'Venue added' : 'Venue added. Choose it under Where.');   // the lead left the page or the create form meanwhile
  }catch(err){
    f.busy=false;
    if(!err.unconfirmed) _vfPendingAdd=null;   // refused: nothing was inserted
    if(!vfOnScreen(f)){ if(_vf===f) _vf=null; toast(err.message || 'The venue wasn’t added','err'); return; }
    vfBusy(false);
    if(err.status===409) vfErrors({ name:err.message });
    else vfErrors(err.errors, err.message || 'The venue wasn’t added');   // a 400 names the fields it can (errors) and says why
  }
}
async function submitAddress(f){
  const { addr }=vfRead(), id=f.venueId, rec=VENUES.find(x=>x.id===id)||{};
  const ent=_vaddr.get(id), typeName=(ent && ent.v && ent.v.type) || rec.type || '';
  const res=VenueAddress.validate(addr, { allowBlank:venueHome(typeName) });
  if(!res.ok){ vfErrors(res.errors); return; }
  vfErrors(null); f.busy=true; vfBusy(true, 'Saving address…');
  try{
    const r=await DB.updateVenue(id, addr);
    const unchanged=!!(r && r.unchanged);   // the same address as saved: nothing was written, nothing to wait for
    if(!unchanged){
      try{ await venueApplied(r && r.requestId); }
      catch(_){ const e=new Error('Coda didn’t confirm the address yet. Try Save address again in a minute.'); throw e; }
    }
    _vaddr.set(id, { status:'ok', v:Object.assign({}, ent && ent.v, addr, { address:VenueAddress.compose(addr) }) });
    if(rec.id){ rec.hasAddress=VenueAddress.hasAddress(addr); setVenues(VENUES); cacheSet('venues', VENUES); }
    if(!unchanged) refreshVenues(id);   // not awaited
    f.busy=false;
    paintVenueAddr();                   // repaints the line (the Edit address link is new), then the dialog closes onto it
    if(_vf===f) closeVenueForm();
    if(editing) _pushChecks.delete(editing.id);   // the Worker's last "needs X" may be about this address
    renderStatusPanel();                          // readiness re-runs against the new hasAddress
  }catch(err){
    f.busy=false;
    if(!vfOnScreen(f)){ if(_vf===f) _vf=null; toast(err.message || 'The address wasn’t saved','err'); return; }
    vfBusy(false);
    vfErrors(err.errors, err.message || 'The address wasn’t saved');
  }
}

/* ---- the dialog's wiring (once; #venueDialog is a stable element in index.html) ---- */
(function wireVenueDialog(){
  const scrim=vdScrim(), box=document.getElementById('vdBox');
  box.addEventListener('click', e=>{
    const b=e.target.closest('[data-vact]'); if(!b || b.disabled) return;
    if(b.dataset.vact==='cancel') closeVenueForm();
    else if(b.dataset.vact==='submit') submitVenueForm();
  });
  box.addEventListener('input', e=>{ if(e.target.id==='vf_name'){ const sub=document.getElementById('vdSub'); if(sub) sub.textContent=e.target.value; } });
  scrim.addEventListener('click', e=>{ if(e.target===scrim) closeVenueForm(); });   // a no-op while busy
  scrim.addEventListener('keydown', e=>{
    if(e.key==='Enter' && !e.isComposing && e.target.matches('input')){ e.preventDefault(); submitVenueForm(); return; }
    if(e.key!=='Tab') return;
    const f=vdFocusables(box);   // Tab cycles inside the dialog
    if(!f.length){ e.preventDefault(); box.focus(); return; }
    const a=document.activeElement, first=f[0], last=f[f.length-1];
    if(e.shiftKey && (a===first || a===box)){ e.preventDefault(); last.focus(); }
    else if(!e.shiftKey && a===last){ e.preventDefault(); first.focus(); }
  });
  // Focus that lands outside the dialog (a click-through, the browser's own focus moves)
  // comes back in. The Help drawer and the Preview overlay, above the dialog, keep their own focus.
  document.addEventListener('focusin', e=>{
    if(!vdOpen() || box.contains(e.target) || (e.target.closest && e.target.closest('#helpDrawer, #pvScrim'))) return;
    (vdFocusables(box)[0] || box).focus({ preventScroll:true });
  });
})();
// Esc closes the venue dialog (and only the dialog) before the modal's requestClose and the
// ⋮ menus see it; while a write waits for Coda it's swallowed and nothing closes. Topmost
// first: with the Help drawer open (above the dialog) Esc is left for help.js to close Help.
document.addEventListener('keydown', e=>{
  if(e.key!=='Escape' || !vdOpen()) return;
  const help=document.getElementById('helpDrawer'); if(help && !help.hidden) return;
  e.preventDefault(); e.stopImmediatePropagation(); hideTip();
  closeVenueForm();
}, true);
