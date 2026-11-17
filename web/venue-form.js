/* venue-form.js — the Where block's venue address line and its inline form: add a venue, fix a venue's address.
   Owns: venueSlotsHTML, wireVenueForm, paintVenueAddr, openVenueAdd, openVenueAddress, openVenueFormFor, closeVenueForm
   Reads: VENUES, VENUE_TYPES, DB, cacheSet, setVenues (data.js); VenueAddress (venue-address.js); CodaApplied (coda-applied.js);
          editing (editor-tabs.js); esc (util.js); toast (ui.js; call time); renderStatusPanel (status-panel.js; call time);
          _pushChecks (eventbrite.js; call time)
   Writes: VENUES (via setVenues + an entry's hasAddress); _pushChecks (eventbrite.js; delete)
   Loaded after: tabs-listing-planning.js (file-map order; no load-time dependency) */

/* Spec 5.3. Two stable containers in the Where block (D1, painted with paintInner):
   #venueAddr — under the picked venue, for editors only: its address
     (GET /venues/:id, once per venue per session), or "No street address yet", with
     Edit address / Add address;
   #venueForm — the inline form, mode 'add' (the picker's + Add "<name>" as a venue, or
     the venueOther readiness link) or 'address' (Edit/Add address, or the venueAddress
     readiness link; Name and Venue type read-only).
   A write waits until Coda has applied it (D3) before the app uses the new row or
   says the address changed: an event must never point at a venue row Coda hasn't
   applied. /ref/venues is busted before Coda applies, so the local VENUES list is
   updated here rather than refetched. Read-only, locked and signed-out views get
   neither container's controls and fetch nothing. */
const _vaddr=new Map();   // venue id → { status:'loading'|'ok'|'err', v:{id,name,type,street,unit,city,state,zip,address} }
let _vctx=null;           // { ev, editable } for the Where block on screen
let _vf=null;             // the open form: { mode, venueId, ev, busy }
let _vfPendingAdd=null;   // an add whose row Coda never confirmed: { key, name, id, requestId } — retried by polling, never re-POSTed
const VF_DEFAULTS={ city:'Nashville', state:'TN' };
const venueTypeName = id => (VENUE_TYPES.find(t=>t.id===id)||{}).name || '';
const venueHome = typeName => typeName==='Home';   // only a private home may have no address

function venueSlotsHTML(){
  return `<div class="vaddr" id="venueAddr" aria-live="polite"></div><div class="vform" id="venueForm"></div>`;
}
// Called by wireEventFields once the venue picker is set up. A rebuilt panel closes any
// open form (an add already sent finishes on its own and still selects the venue).
// Every lookup is scoped to the Where block wired here (the venue box's .fieldgroup), so a
// second copy of the same ids elsewhere in the document can never be read or painted.
// Each container is wired once (_vfWired), and all submits go through submitVenueForm.
function wireVenueForm(ev, editable, box){
  const group=box && box.closest('.fieldgroup');
  const addrEl=group && group.querySelector('#venueAddr'), formEl=group && group.querySelector('#venueForm');
  _vctx={ ev, editable:!!editable, group, box, addrEl, formEl };
  if(!(_vf && _vf.busy)) _vf=null;
  if(!addrEl || !formEl) return;
  if(formEl._vfWired){ paintVenueAddr(); return; }
  formEl._vfWired=true;
  addrEl.addEventListener('click', e=>{
    const b=e.target.closest('[data-vact]'); if(!b) return;
    if(b.dataset.vact==='edit') openVenueAddress();
    else if(b.dataset.vact==='retry'){ _vaddr.delete(b.dataset.id); paintVenueAddr(); }
  });
  formEl.addEventListener('click', e=>{
    const b=e.target.closest('[data-vact]'); if(!b) return;
    if(b.dataset.vact==='cancel') closeVenueForm();
    else if(b.dataset.vact==='submit') submitVenueForm();
  });
  formEl.addEventListener('keydown', e=>{
    if(e.key==='Enter' && e.target.matches('input')){ e.preventDefault(); submitVenueForm(); }
    else if(e.key==='Escape'){ e.stopPropagation(); closeVenueForm(); }
  });
  paintVenueAddr();
}
const vfEl = () => (_vctx && _vctx.formEl && _vctx.formEl.isConnected) ? _vctx.formEl : null;
const vfEditable = () => !!(_vctx && _vctx.editable && _vctx.ev===editing && vfEl());
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

/* ---- the inline form ---- */
function vfFieldHTML(key, label, value, attrs){
  return `<div class="fld vf-${key}"><label for="vf_${key}">${label}</label><input id="vf_${key}" value="${esc(value||'')}" autocomplete="off" ${attrs||''}><span class="hint err" data-err="${key}"></span></div>`;
}
function venueFormHTML(mode, v){
  const add=mode==='add';
  const types=`<option value="">Choose…</option>` + VENUE_TYPES.map(t=>`<option value="${esc(t.id)}" ${t.id===v.typeId?'selected':''}>${esc(t.name)}</option>`).join('');
  return `<fieldset class="vform-fs"><legend class="vform-h">${add?'Add a venue':'Venue address'}</legend>`
    + `<div class="vform-grid">`
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
    + `<span class="hint err" data-err="form" role="alert"></span><span class="hint" data-vf-slow></span>`
    + `<div class="vform-acts"><button type="button" class="btn xs primary" data-vact="submit">${add?'Add venue':'Save address'}</button><button type="button" class="btn xs" data-vact="cancel">Cancel</button></div>`
    + `</fieldset>`;
}
function showVenueForm(mode, venueId, v){
  const el=vfEl(); if(!el) return null;
  _vf={ mode, venueId, ev:editing, busy:false };
  paintInner(el, venueFormHTML(mode, v));
  el.scrollIntoView({ block:'nearest', behavior:'smooth' });
  const first=el.querySelector(mode==='add' ? (v.name ? '#vf_street' : '#vf_name') : '#vf_street');
  if(first) first.focus({ preventScroll:true });
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
function closeVenueForm(){
  if(_vf && _vf.busy) return;
  _vf=null;
  const el=vfEl(); if(el) paintInner(el, '');
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
}
// Busy: the whole form is disabled in place (no repaint, so nothing typed is lost).
function vfBusy(on, label){
  const el=vfEl(); if(!el) return;
  const fs=el.querySelector('fieldset'), btn=el.querySelector('[data-vact="submit"]'), slow=el.querySelector('[data-vf-slow]');
  if(fs) fs.disabled=on;
  if(btn){ if(on){ btn.dataset.label=btn.textContent; btn.textContent=label; } else if(btn.dataset.label) btn.textContent=btn.dataset.label; }
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
// The form this write came from is still the one showing (the panel wasn't rebuilt meanwhile).
const vfOnScreen = f => { const el=vfEl(); return _vf===f && !!(el && el.querySelector('fieldset')); };
// The one way a venue write starts (the button's click and Enter in a field both land
// here). _vfSubmitting is set before anything else runs and cleared only when that
// submit has finished, so no second request can start meanwhile.
let _vfSubmitting=false;
async function submitVenueForm(){
  if(_vfSubmitting || !_vf || _vf.busy || !vfEditable()) return;
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
    _vaddr.set(v.id, { status:'ok', v:Object.assign({ id:v.id, name, type:typeName, address:VenueAddress.compose(addr) }, addr) });
    f.busy=false;
    if(_vf===f) closeVenueForm();
    const box=_vctx && _vctx.box;
    const picked = !!(box && box.isConnected && box.pickVenue && editing===f.ev && box.pickVenue(v.id));   // the picker's onChange: address default, address line, autosave
    toast(picked ? 'Venue added' : 'Venue added. Choose it under Where.');   // the lead moved to another tab or event meanwhile
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
    try{ await venueApplied(r && r.requestId); }
    catch(_){ const e=new Error('Coda didn’t confirm the address yet. Try Save address again in a minute.'); throw e; }
    _vaddr.set(id, { status:'ok', v:Object.assign({}, ent && ent.v, addr, { address:VenueAddress.compose(addr) }) });
    if(rec.id){ rec.hasAddress=VenueAddress.hasAddress(addr); setVenues(VENUES); cacheSet('venues', VENUES); }
    f.busy=false;
    if(_vf===f) closeVenueForm();
    paintVenueAddr();
    if(editing) _pushChecks.delete(editing.id);   // the Worker's last "needs X" may be about this address
    renderStatusPanel();                          // readiness re-runs against the new hasAddress
  }catch(err){
    f.busy=false;
    if(!vfOnScreen(f)){ if(_vf===f) _vf=null; toast(err.message || 'The address wasn’t saved','err'); return; }
    vfBusy(false);
    vfErrors(err.errors, err.message || 'The address wasn’t saved');
  }
}
