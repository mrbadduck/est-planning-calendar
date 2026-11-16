/* preview.js — the Preview listing overlay and its Esc-closes-only-the-preview keydown listener.
   Owns: openPreview, closePreview
   Reads: state (state.js); editing (editor-tabs.js); _ctx (editor.js)
   Writes: nothing (owns _pvGen)
   Loaded after: field-markers.js (the Esc listener must precede requestClose's, registered in editor-close.js) */

/* ---- listing preview (the card's Preview listing; board E2, R26) -------------
   An overlay above the editor — the editor stays open underneath, unsaved state
   and all. On Eventbrite: Eventbrite's own data via the Worker. Before that: the
   form's own values (ListingPreview.fromForm, same model shape). Both render
   through previewBodyHTML: every text is escaped, and the description HTML goes
   through ListingHtml.sanitize (an allowlist) — local text is escaped first. */
let _pvGen=0;
function previewWhen(m){
  const s=String(m.startLocal||''), e=String(m.endLocal||'');
  const d=s.slice(0,10); if(!/^\d{4}-\d{2}-\d{2}$/.test(d)) return { day:'', full:'' };
  const [y,mo,da]=d.split('-').map(Number), dt=new Date(y,mo-1,da);
  const t12 = hm => { const [h,mi]=hm.split(':').map(Number); return isNaN(h) ? '' : `${h%12||12}:${pad(mi||0)}`; };
  const ap = hm => Number(hm.split(':')[0])<12 ? 'AM' : 'PM';
  const st=s.slice(11,16), en=e.slice(11,16);
  let tz=''; try{ tz = m.timezone ? (new Intl.DateTimeFormat('en-US',{timeZone:m.timezone, timeZoneName:'short'}).formatToParts(dt).find(p=>p.type==='timeZoneName')||{}).value||'' : ''; }catch(_){}
  let times='';
  if(st) times = en ? (ap(st)===ap(en) ? `${t12(st)} – ${t12(en)} ${ap(en)}` : `${t12(st)} ${ap(st)} – ${t12(en)} ${ap(en)}`) : `${t12(st)} ${ap(st)}`;
  return {
    day: dt.toLocaleDateString('en-US',{weekday:'long', month:'long', day:'numeric'}),
    full: dt.toLocaleDateString('en-US',{weekday:'short', month:'short', day:'numeric', year:'numeric'}) + (times ? ` · ${times}${tz?' '+tz:''}` : ''),
  };
}
function previewBodyHTML(m){
  const w=previewWhen(m), draft = m.status!=='live';
  const loc = m.location || {};
  const locHTML = loc.online ? '<span>Online event</span>'
    : `${loc.name?`<span>${esc(loc.name)}</span>`:''}${loc.displayAddress?`<span>${esc(loc.displayAddress)}</span>`:''}${loc.note?`<span class="pv-note">${esc(loc.note)}</span>`:''}`;
  const logo = /^https:\/\//i.test(String(m.logoUrl||'')) ? `<img class="pv-banner" src="${esc(m.logoUrl)}" alt="">` : `<div class="pv-banner pv-nobanner">${m.lag?'The event image isn’t shown here':m.local?'The event image is added on Eventbrite':'No event image on Eventbrite'}</div>`;
  const tickets = (m.tickets||[]).map(t=>`<div class="pv-ticket"><div><b>${esc(t.name||'Ticket')}</b><span>${t.free?'Free':'Paid'}${t.quantityTotal!=null?` · ${esc(t.quantityTotal)} available`:''}</span></div><span class="pv-reserve">${draft?'Reserve a spot (opens when published)':'Reserve a spot'}</span></div>`).join('');
  const desc = ListingHtml.sanitize(m.descriptionHtml||'');
  return `<div class="pv-card">${logo}<div class="pv-main">
      ${w.day?`<span class="pv-day">${esc(w.day)}</span>`:''}
      <h1 class="pv-name">${esc(m.name||'Untitled')}</h1>
      ${m.summary?`<p class="pv-summary">${esc(m.summary)}</p>`:''}
      <div class="pv-facts"><div><b>Date and time</b><span>${esc(w.full||'—')}</span></div><div><b>Location</b>${locHTML||'<span>—</span>'}</div></div>
      <div class="pv-about"><b>About this event</b><div class="pv-desc">${desc||'<p class="hint">No description yet.</p>'}</div></div>
      ${tickets}
      <span class="pv-org">Organized by East Side Tribe</span>
    </div></div>
    <p class="pv-why">${m.lag
      ? "Built from this event's fields as they are right now, not from Eventbrite's copy."
      : m.local
      ? "Built from this event's fields as they are right now. It isn't on Eventbrite yet, so nobody else can see it."
      : "Shown in the plan app's own layout using Eventbrite's data, because Eventbrite only shows draft pages to people logged in to its organizer account."}</p>`;
}
// The preview built from the open form (before the event is on Eventbrite).
// The preview built from the open form. `lag`: the event is on Eventbrite, but
// this is not Eventbrite's copy (the Worker can't see it yet, or the viewer can't
// read it), so nothing may say "isn't on Eventbrite yet".
function localPreviewModel(lag){
  const f=Object.assign({}, editing||{}, readForm());
  const m=ListingPreview.fromForm(f, { timezone:'America/Chicago', venue: formVenueRecord() });
  if(lag) m.lag=true;
  return m;
}
// The overlay's header by what the body shows: 'local' (not on Eventbrite yet),
// 'linked' (Eventbrite's copy), 'catching-up' (on Eventbrite, the Worker can't see
// it yet) or 'form' (on Eventbrite, a read-only viewer: built from the fields).
function pvHeadHTML(kind, ev){
  const draft = ev.publishStatus!=='Published';
  const t = (title, sub, tag) => `<div class="pv-headtxt"><b id="pvTitle">${esc(title)}</b><span>${esc(sub)}</span></div>${tag||''}`;
  const WILL = 'Preview: how your listing will look on Eventbrite';
  if(kind==='local') return t(WILL, 'Built from the fields on Details. Nothing is on Eventbrite yet.', `<span class="ftag pre lg">Not on Eventbrite yet</span>`);
  if(kind==='catching-up') return t(WILL, "Eventbrite is still catching up, so this is built from the fields on Details. Open it again in a minute to see Eventbrite's copy.");
  if(kind==='form') return t(WILL, 'Built from the fields on Details.');
  return t('Preview: your Eventbrite listing',
    draft ? 'This is what Eventbrite has for your private draft, fetched just now. Nobody else can see it yet.' : 'This is what Eventbrite has for your listing, fetched just now.',
    `<span class="ftag ${draft?'chg':'ok'} lg">${draft?'Private draft':'Public'}</span>`);
}
function openPreview(){
  const ev=editing; if(!ev || !ev.id || !_ctx) return;
  closePreview();
  const gen=++_pvGen;
  const linked=!!ev.eventbriteId, canRead=!!(_ctx.role && _ctx.role.canEdit);
  const kind = !linked ? 'local' : canRead ? 'linked' : 'form';
  const m=editorFooterModel(ev, _ctx);
  const canPublish = kind==='linked' && !!(m.primary && m.primary.act==='publish-eb' && m.primary.enabled);
  const wrap=document.createElement('div');
  wrap.className='pv-scrim'; wrap.id='pvScrim';
  wrap.innerHTML=`<div class="pv-modal" role="dialog" aria-modal="true" aria-labelledby="pvTitle">
    <div class="pv-head" id="pvHead">${pvHeadHTML(kind, ev)}</div>
    <div class="pv-body" id="pvBody">${kind!=='linked' ? previewBodyHTML(localPreviewModel(kind==='form')) : `<div class="ndoc-loading"><span class="ndoc-spin"></span> Fetching the listing from Eventbrite…</div>`}</div>
    <div class="pv-foot"><span class="pv-footmsg">${kind==='linked' ? `Something wrong? Close this and edit the fields; they'll show "Not on Eventbrite yet" until you update.` : 'Something wrong? Close this and edit the fields on Details.'}</span>
      <button type="button" class="btn fbtn sec" data-pv="close">Close</button>
      ${canPublish?`<button type="button" class="btn fbtn go" data-pv="publish">Publish</button>`:''}</div>
  </div>`;
  document.body.appendChild(wrap);
  wrap.addEventListener('click', e=>{
    if(e.target===wrap){ closePreview(); return; }
    const b=e.target.closest('[data-pv]'); if(!b) return;
    if(b.dataset.pv==='close') closePreview();
    else if(b.dataset.pv==='publish'){ closePreview(); footerAct('publish-eb'); }
  });
  wrap.querySelector('[data-pv="close"]').focus();
  if(kind!=='linked') return;
  DB.ebPreview(ev.id).then(model=>{
    if(gen!==_pvGen) return;   // closed, or reopened since
    const body=document.getElementById('pvBody'); if(!body) return;
    if(model){ body.innerHTML = previewBodyHTML(model); return; }
    // The Worker can't see the Eventbrite id yet (Coda lag after Add to
    // Eventbrite): say so, show the form's version, and offer no Publish.
    const head=document.getElementById('pvHead'); if(head) head.innerHTML = pvHeadHTML('catching-up', ev);
    const pb=wrap.querySelector('[data-pv="publish"]'); if(pb) pb.remove();
    const msg=wrap.querySelector('.pv-footmsg'); if(msg) msg.textContent='Something wrong? Close this and edit the fields on Details.';
    body.innerHTML = previewBodyHTML(localPreviewModel(true));
  }).catch(err=>{
    if(gen!==_pvGen) return;
    if(err && err.status===401){ closePreview(); sessionExpired(); return; }
    const body=document.getElementById('pvBody');
    if(body) body.innerHTML=`<div class="ndoc-warn">Couldn't load the listing from Eventbrite. Close this and try again in a moment.</div>`;
  });
}
function closePreview(){
  _pvGen++;
  const w=document.getElementById('pvScrim'); if(!w) return false;
  hideTip(); w.remove();
  const sec=document.querySelector('#listingCard [data-pv-open]'); if(sec) sec.focus();
  return true;
}
// Esc closes the preview (and only the preview) before it reaches the editor.
document.addEventListener('keydown', e=>{
  if(e.key!=='Escape' || !document.getElementById('pvScrim')) return;
  e.preventDefault(); e.stopImmediatePropagation(); closePreview();
}, true);
