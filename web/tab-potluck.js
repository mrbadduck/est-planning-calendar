/* tab-potluck.js — the Potluck & Volunteers tab: the gather slot builder and its claims.
   Owns: SLOTS_LOADING_HTML, SLOTS_SLOW_MSG, renderSlots, wireSlots
   Reads: state (state.js); DB, reference lists (data.js)
   Writes: nothing
   Loaded after: tab-attendees.js (file-map order; no load-time dependency) */

/* ---- Volunteers & potluck: the gather slot builder ------------------------
   Leads author sign-up slots (Potluck dishes / Volunteer roles) on a SAVED event
   and manage the sign-ups (claims) on each slot; members fill them in the gather
   app. Slots persist to EST Slots SRC / claims to EST Claims SRC via the
   lead-gated /slots + /claims routes. Grouped by kind, each group with its own
   ghost "next row" add form. Needs a Coda row id. */
// Real loading state: spinner + message. Slot reads go straight to Coda (kept
// fresh for claims, no KV) so they can be genuinely slow — after 5s of honest
// waiting the message reassures rather than looking hung.
const SLOTS_LOADING_HTML = `<div class="slots-loading"><span class="ndoc-spin"></span><span data-loadmsg>Loading sign-up slots…</span></div>`;
const SLOTS_SLOW_MSG = 'Still on it — our database is answering slowly today. Hang tight, nothing is broken…';
function renderSlots(ev, canEdit){
  if(!ev.id) return `<div class="slots-wrap"><div class="soon-teaser"><div class="soon-h">Volunteers & potluck</div><div class="hint">Save the event first, then add sign-up slots here.</div></div></div>`;
  return `<div class="slots-wrap" id="f_slots">
      <p class="hint">Add potluck dishes or volunteer roles, and manage who's signed up. These go live to members in <b>gather</b> once the event is published — once approved, leads &amp; council can already preview them there.</p>
      <div class="slots-list" aria-live="polite">${SLOTS_LOADING_HTML}</div>
      ${canEdit ? `<datalist id="slotPeopleDL"></datalist>` : `<p class="hint">Only program leads can edit slots.</p>`}
    </div>`;
}
async function wireSlots(panel, ev, canEdit){
  const wrap=panel.querySelector('#f_slots'); if(!wrap) return;
  const list=wrap.querySelector('.slots-list'); if(!list) return;   // save-first teaser has no list
  const dl=wrap.querySelector('#slotPeopleDL');
  if(dl) dl.innerHTML=PEOPLE_LIST.map(p=>`<option value="${esc(p.name)}">`).join('');
  let slots=[];
  // Optimistic overlay (mirrors the planning _recent stack): every mutation paints
  // immediately, and a delayed reconcile pulls server truth. Coda reads are
  // eventually consistent, so a refetch right after a write often misses the new
  // row — `recent` keeps just-changed slots (including their claims) alive until
  // the server catches up.
  const recent=new Map();                                            // slotId -> {until, slot|deleted}
  const remember=(id,rec)=>recent.set(id, Object.assign({until:Date.now()+8000}, rec));
  const merge=(server)=>{
    const now=Date.now();
    for(const [id,rec] of [...recent]) if(rec.until<=now) recent.delete(id);
    const out=server.filter(s=>{ const r=recent.get(s.id); return !(r&&r.deleted); })   // hide just-deleted
                    .map(s=>{ const r=recent.get(s.id); return (r&&r.slot)?r.slot:s; });// keep just-edited
    for(const [id,rec] of recent) if(rec.slot && !server.some(s=>s.id===id)) out.push(rec.slot); // keep just-created
    return out;
  };
  const KINDS=['Potluck','Volunteer'];
  const openClaims=new Set();     // slot ids with the add-sign-up form open
  const editingClaims=new Set();  // claim ids currently in edit mode

  const claimFormHTML=(s,c)=>`
      <form class="claim-row claim-form" data-slot="${esc(s.id)}"${c?` data-claim="${esc(c.id)}"`:''} autocomplete="off">
        ${c?`<span class="claim-who">${esc(c.name||'Someone')}</span>`
           :`<input class="claim-person" list="slotPeopleDL" placeholder="Who?" required autocomplete="off">`}
        <input class="claim-detail" type="text" placeholder="${s.kind==='Volunteer'?'Note':'What are they bringing?'} (optional)" value="${c?esc(c.contribution||''):''}" maxlength="120">
        <input class="claim-qtyin" type="number" min="1" max="20" value="${c?(c.qty||1):1}" title="Quantity" aria-label="Quantity">
        <button class="btn sm primary" type="submit">${c?'Save':'Add'}</button>
        <button type="button" class="iconbtn" data-cancelclaim title="Cancel" aria-label="Cancel">×</button>
      </form>`;
  const claimRowHTML=(s,c)=>{
    if(editingClaims.has(c.id)) return claimFormHTML(s,c);
    return `<div class="claim-row" data-claim="${esc(c.id)}">
        <span class="claim-who">${esc(c.name||'Someone')}</span>
        ${c.contribution?`<span class="claim-what">— ${esc(c.contribution)}</span>`:''}
        ${(c.qty||1)>1?`<span class="claim-qty">×${c.qty}</span>`:''}
        ${canEdit?`<span class="claim-ctl">
          <button type="button" class="iconbtn" data-editclaim title="Edit sign-up" aria-label="Edit sign-up">✎</button>
          <button type="button" class="iconbtn del" data-delclaim title="Remove sign-up" aria-label="Remove sign-up">×</button>
        </span>`:''}
      </div>`;
  };
  const slotHTML=(s,i,groupLen)=>{
    const claims=s.claims||[];
    const filled=claims.reduce((n,c)=>n+(c.qty||1),0);
    return `<div class="slot-item" data-id="${esc(s.id)}">
        <div class="slot-head">
          <span class="slot-name">${esc(s.label||'')}</span>
          <span class="slot-need">${s.neededQty==null?`${filled} · no limit`:`${filled} of ${s.neededQty}`}</span>
          ${canEdit?`<span class="slot-ctl">
            <button type="button" class="iconbtn" data-move="-1" ${i===0?'disabled':''} title="Move up" aria-label="Move up">↑</button>
            <button type="button" class="iconbtn" data-move="1" ${i===groupLen-1?'disabled':''} title="Move down" aria-label="Move down">↓</button>
            <button type="button" class="iconbtn del" data-del title="Remove slot" aria-label="Remove slot">×</button>
          </span>`:''}
        </div>
        <div class="slot-claims">
          ${claims.map(c=>claimRowHTML(s,c)).join('')}
          ${canEdit?(openClaims.has(s.id)?claimFormHTML(s,null):`<button type="button" class="claim-addbtn" data-addclaim>+ Add sign-up</button>`):(claims.length?'':`<div class="hint" style="margin:0">No sign-ups yet.</div>`)}
        </div>
      </div>`;
  };
  // Group headings are always present; each group carries its own ghost add row
  // styled as "the next row" in the list.
  const ghostHTML=(k)=>`
      <form class="slot-item slot-ghost" data-add="${esc(k)}" autocomplete="off">
        <input class="slot-label" type="text" placeholder="${k==='Volunteer'?'Add a role or shift…':'Add a dish or item…'}" maxlength="80" required>
        <input class="slot-qty" type="number" min="1" max="99" placeholder="∞" title="How many needed — leave blank for no limit" aria-label="How many needed (blank = no limit)">
        <button class="btn sm primary" type="submit">Add</button>
      </form>`;
  const groupSlots=(k)=>slots.filter(s=>(s.kind||KINDS[0])===k);
  const paint=()=>{
    const extra=[...new Set(slots.map(s=>s.kind).filter(k=>k && !KINDS.includes(k)))];
    list.innerHTML=[...KINDS, ...extra].map(k=>{
      const gs=groupSlots(k);
      return `<div class="slot-group" data-kind="${esc(k)}">
          <div class="slot-group-h ${k==='Volunteer'?'vol':'pot'}">${esc(k)}</div>
          ${gs.map((s,i)=>slotHTML(s,i,gs.length)).join('')}
          ${canEdit && KINDS.includes(k) ? ghostHTML(k) : (gs.length?'':`<div class="hint" style="margin:0">None yet.</div>`)}
        </div>`;
    }).join('');
  };
  const sortPaint=()=>{ slots.sort((a,b)=>(a.sortOrder||0)-(b.sortOrder||0)); paint(); };
  const load=async(gentle)=>{
    let slowT;
    if(!gentle && !slots.length){                    // initial load: spinner now, friendly note if it drags past 5s
      list.innerHTML=SLOTS_LOADING_HTML;
      slowT=setTimeout(()=>{ const m=list.querySelector('[data-loadmsg]'); if(m) m.textContent=SLOTS_SLOW_MSG; }, 5000);
    }
    try{ slots=merge(await DB.listSlots(ev.id)); }
    catch(err){ clearTimeout(slowT); if(!gentle && !slots.length) list.innerHTML=`<div class="hint err">Couldn't load slots: ${esc(err.message||'')}</div>`; return; }
    finally{ clearTimeout(slowT); }
    // a background reconcile must never clobber a form the lead is typing in
    if(gentle && list.contains(document.activeElement) && /^(INPUT|TEXTAREA)$/.test(document.activeElement.tagName)){ reconcile(); return; }
    sortPaint();
  };
  let _reconT;
  const reconcile=()=>{ clearTimeout(_reconT); _reconT=setTimeout(()=>load(true), 2500); };   // let Coda index, then pull server truth

  async function onAddSlot(form){
    const kind=form.dataset.add;
    const labEl=form.querySelector('.slot-label'), qtyEl=form.querySelector('.slot-qty');
    const label=labEl.value.trim(); if(!label) return;
    const rawQty=(qtyEl.value||'').trim();                        // blank = no limit (unlimited)
    const neededQty=rawQty===''?null:Math.max(1, Math.min(99, parseInt(rawQty,10)||1));
    const sortOrder=(slots.length?Math.max(...slots.map(s=>s.sortOrder||0)):0)+1;
    const btn=form.querySelector('button[type=submit]'); btn.disabled=true;
    try{
      const r=await DB.createSlot({event:ev.id, kind, label, neededQty, sortOrder});
      const s={id:(r&&r.id)||`tmp-${Date.now()}`, event:ev.id, kind, label, neededQty, sortOrder, claims:[]};
      slots.push(s); remember(s.id,{slot:s}); sortPaint();          // show it now; server read lags
      const nf=list.querySelector(`form[data-add="${kind}"] .slot-label`); if(nf) nf.focus();
      reconcile();
    }
    catch(err){ toast(err.message||'Could not add slot','err'); btn.disabled=false; }
  }
  async function onClaimForm(form){
    const slotId=form.dataset.slot, claimId=form.dataset.claim||null;
    const s=slots.find(x=>x.id===slotId); if(!s) return;
    const detail=(form.querySelector('.claim-detail').value||'').trim();
    const qty=Math.max(1, Math.min(20, parseInt(form.querySelector('.claim-qtyin').value,10)||1));
    const btn=form.querySelector('button[type=submit]'); btn.disabled=true;
    try{
      if(claimId){
        await DB.updateClaim(claimId, {qty, contributionDetail:detail});
        const c=(s.claims||[]).find(x=>x.id===claimId); if(c){ c.qty=qty; c.contribution=detail; }
        editingClaims.delete(claimId);
      }else{
        const nameIn=form.querySelector('.claim-person'); const nm=(nameIn.value||'').trim();
        const pid=peopleIdByName[nm];
        if(!pid){ toast('Pick a person from the list','err'); btn.disabled=false; nameIn.focus(); return; }
        const r=await DB.createClaim({slot:slotId, member:pid, qty, contributionDetail:detail});
        (s.claims=s.claims||[]).push({id:(r&&r.id)||`tmp-${Date.now()}`, member:pid, name:nm, contribution:detail, qty});
        openClaims.delete(slotId);
      }
      remember(s.id,{slot:s}); paint(); reconcile();
    }
    catch(err){ toast(err.message||'Could not save sign-up','err'); btn.disabled=false; }
  }

  if(canEdit){
    list.addEventListener('submit', e=>{
      e.preventDefault();
      const f=e.target;
      if(f.matches('form[data-add]')) onAddSlot(f);
      else if(f.matches('form.claim-form')) onClaimForm(f);
    });
    list.addEventListener('click', async e=>{
      const row=e.target.closest('.slot-item'); if(!row || row.matches('.slot-ghost')) return;
      const id=row.dataset.id;
      const s=slots.find(x=>x.id===id);
      if(e.target.closest('[data-addclaim]')){
        openClaims.add(id); paint();
        const inp=list.querySelector(`form.claim-form[data-slot="${id}"] .claim-person`); if(inp) inp.focus();
        return;
      }
      if(e.target.closest('[data-cancelclaim]')){
        const f=e.target.closest('form.claim-form');
        if(f && f.dataset.claim) editingClaims.delete(f.dataset.claim); else openClaims.delete(id);
        paint(); return;
      }
      if(e.target.closest('[data-editclaim]')){
        const cid=e.target.closest('[data-claim]').dataset.claim;
        editingClaims.add(cid); paint(); return;
      }
      if(e.target.closest('[data-delclaim]')){
        const cid=e.target.closest('[data-claim]').dataset.claim;
        if(!s || !s.claims) return;
        const gone=s.claims.find(c=>c.id===cid); if(!gone) return;
        s.claims=s.claims.filter(c=>c.id!==cid); remember(s.id,{slot:s}); paint();   // drop it now
        try{ await DB.removeClaim(cid); reconcile(); }
        catch(err){ s.claims.push(gone); paint(); toast(err.message||'Could not remove sign-up','err'); }
        return;
      }
      if(e.target.closest('[data-del]')){
        const gone=slots.find(x=>x.id===id); if(!gone) return;
        slots=slots.filter(x=>x.id!==id); remember(id,{deleted:true}); paint();   // drop it now
        try{ await DB.removeSlot(id); reconcile(); }
        catch(err){ recent.delete(id); slots.push(gone); sortPaint(); toast(err.message||'Could not remove','err'); }
        return;
      }
      const mv=e.target.closest('[data-move]');
      if(mv && s){
        // reorder within the slot's own kind group
        const dir=parseInt(mv.dataset.move,10);
        const gs=groupSlots(s.kind||KINDS[0]);
        const i=gs.findIndex(x=>x.id===id), j=i+dir;
        if(i<0||j<0||j>=gs.length) return;
        const a=gs[i], b=gs[j], ao=a.sortOrder||0, bo=b.sortOrder||0;
        a.sortOrder=bo; b.sortOrder=ao; remember(a.id,{slot:a}); remember(b.id,{slot:b}); sortPaint();   // swap now
        try{ await Promise.all([DB.updateSlot(a.id,{sortOrder:bo}), DB.updateSlot(b.id,{sortOrder:ao})]); reconcile(); }
        catch(err){ a.sortOrder=ao; b.sortOrder=bo; recent.delete(a.id); recent.delete(b.id); sortPaint(); toast(err.message||'Could not reorder','err'); }
      }
    });
  }
  load();
}
