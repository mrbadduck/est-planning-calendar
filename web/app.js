// The layer toggles live in two places — the ⚙ pop-over (#layers) and the phone ☰
// menu (#menuLayers) — and both always show the same on/off state.
const LAYER_BOXES = ['layers','menuLayers'];
function syncLayerToggles(){
  for(const id of LAYER_BOXES){
    const box=document.getElementById(id); if(!box) continue;
    box.querySelectorAll('.lyr').forEach(el=>{ const on=!!state.layers[el.dataset.layer]; el.dataset.on=on; el.setAttribute('aria-pressed', String(on)); });
  }
}
function renderLayers(){
  // Same layers as last time (every refresh calls this)? Just sync on/off in place,
  // so a toggle focused from the keyboard keeps its focus.
  const sig=REF_LAYERS.map(r=>[r.id,r.name,r.color].join('\u0001')).join('\u0002');
  for(const id of LAYER_BOXES){
    const box=document.getElementById(id); if(!box || box.dataset.sig===sig) continue;
    box.dataset.sig=sig;
    // remove any previously injected ref toggles
    box.querySelectorAll('[data-ref-toggle]').forEach(n=>n.remove());
    for(const r of REF_LAYERS){
      const el=document.createElement('button');
      el.type='button'; el.className='lyr';
      el.dataset.refToggle='1'; el.dataset.layer=r.id;
      el.innerHTML=`<span class="swatch-ref" style="background:${cssColor(r.color,'var(--faint)')}"></span><span class="name">${esc(r.name)}</span>`;
      box.appendChild(el);
    }
  }
  syncLayerToggles();
}











/* ---- Attendees: live roster (Eventbrite orders ∪ gather claimants) --------
   Read-only for leads. Emails ARE shown here — plan is lead-only; gather's
   member projection never carries an address. Segments are a client-side filter
   (RosterLib); Copy / Email act on the checked rows of the current segment.
   Selection is by row key, and emails are resolved from the loaded rows. */
function renderAttendees(ev){
  if(!ev.id) return `<div class="roster-wrap"><div class="soon-teaser"><div class="soon-h">Attendees</div><div class="hint">Save the event first.</div></div></div>`;
  return `<div class="roster-wrap" id="f_roster">
      <div class="roster-head"><div class="roster-sum hint" data-sum>Loading…</div><button type="button" class="btn sm ghost" data-act="roster-refresh" title="Pull the latest from Eventbrite">↻ Refresh</button></div>
      <div class="roster-segs" data-segs></div>
      <div class="roster-body" data-body>${SLOTS_LOADING_HTML}</div>
      <div class="roster-foot" hidden>
        <span class="roster-selcount" data-selcount>0 selected</span>
        <span class="push"></span>
        <button type="button" class="btn sm" data-act="roster-copy" disabled>Copy emails</button>
        <a class="btn sm primary disabled" data-act="roster-mail" href="#" aria-disabled="true">Email</a>
      </div>
    </div>`;
}
async function wireAttendees(panel, ev){
  const wrap=panel.querySelector('#f_roster'); if(!wrap) return;
  const body=wrap.querySelector('[data-body]'); if(!body) return;   // save-first teaser
  const segsEl=wrap.querySelector('[data-segs]'), sum=wrap.querySelector('[data-sum]');
  const segFade=wireScrollFade(segsEl);   // edge-fade hint when the chips overflow horizontally
  const copyBtn=wrap.querySelector('[data-act="roster-copy"]'), mailBtn=wrap.querySelector('[data-act="roster-mail"]');
  const foot=wrap.querySelector('.roster-foot'), selCount=wrap.querySelector('[data-selcount]');
  // select-all now lives in the (re-rendered) table header — re-query it per paint.
  const L=window.RosterLib;
  let data=null, segs=[], seg='all', selected=new Set();
  const visible=()=>data?L.applySegment(data.rows, segs, seg):[];
  const chosen=()=>visible().filter(r=>selected.has(r.key));
  const plural=(n,w)=>`${n} ${w}${n===1?'':'s'}`;
  const paintFoot=()=>{
    const rows=chosen(), emails=L.emailsOf(rows), missing=rows.length-emails.length;
    foot.hidden = rows.length===0;                 // footer only appears once something is selected
    selCount.textContent=`${rows.length} selected${missing>0?` · ${missing} without email`:''}`;
    copyBtn.disabled=!emails.length;
    const href=emails.length?L.mailtoHref(emails, ev.title||''):null;
    mailBtn.classList.toggle('disabled', !href); mailBtn.setAttribute('aria-disabled', String(!href));
    mailBtn.href=href||'#';
    mailBtn.title=(emails.length && !href)?'Too many addresses for a mail link — use Copy emails instead':'';
    const vis=visible(), selAll=wrap.querySelector('[data-selall]');   // header checkbox is re-created each paintRows
    if(selAll){
      selAll.checked=vis.length>0 && vis.every(r=>selected.has(r.key));
      selAll.indeterminate=!selAll.checked && vis.some(r=>selected.has(r.key));
    }
  };
  const paintSegs=()=>{
    segsEl.innerHTML=segs.map(s=>{ const n=data.rows.filter(s.test).length; return `<button type="button" class="roster-seg${s.id===seg?' on':''}" data-seg="${esc(s.id)}" aria-pressed="${s.id===seg}">${esc(s.label)} <span class="n">${n}</span></button>`; }).join('');
    segFade();   // chip widths changed → recompute the edge fade
  };
  // Registered + matched is the default state and gets no badge (the segment
  // chips carry the counts); only the exceptions are flagged inline by the name.
  const statusBadge=r=> r.kind==='order'
    ? (r.matched ? '' : ` <span class="badge b-draft" title="No EST person matches this email yet">Not in People</span>`)
    : ` <span class="badge b-past" title="Signed up in gather but hasn't registered on Eventbrite">Not registered</span>`;
  const paintRows=()=>{
    const rows=visible();
    if(!rows.length){
      const msg = data.rows.length ? 'No one in this segment.'
        : (data.ebLinked ? 'No registrations yet.' : 'Registrants appear here once the event is published to Eventbrite. Sign-ups from gather show as soon as they land.');
      body.innerHTML=`<div class="hint roster-empty">${msg}</div>`; paintFoot(); return;
    }
    body.innerHTML=`<table class="roster"><thead><tr><th class="roster-selall-cell"><input type="checkbox" data-selall aria-label="Select all in this segment"></th><th>Name</th><th>Tickets</th><th>Sign-ups</th></tr></thead><tbody>${rows.map(r=>`
      <tr data-key="${esc(r.key)}">
        <td><input type="checkbox" data-sel ${selected.has(r.key)?'checked':''} aria-label="Select ${esc(r.name||r.email||'row')}"></td>
        <td class="roster-who"><div class="roster-name">${esc(r.name||'(no name)')}${r.member?` <span class="badge b-member" title="Active member">Member</span>`:''}${statusBadge(r)}</div><div class="roster-email">${r.email?esc(r.email):'<span class="hint">no email</span>'}</div></td>
        <td class="roster-tix">${r.tickets.length?r.tickets.map(t=>`<span class="roster-tik">${t.qty} × ${esc(t.class)}</span>`).join(''):'<span class="hint">—</span>'}</td>
        <td class="roster-claims">${r.claims.length?r.claims.map(c=>`<span class="roster-claim">${esc(c.label)}${c.contribution?` <span class="hint">· ${esc(c.contribution)}</span>`:''}</span>`).join(''):'<span class="hint">—</span>'}</td>
      </tr>`).join('')}</tbody></table>`;
    paintFoot();
  };
  const paintSum=()=>{ const s=data.summary; sum.textContent=`${plural(s.orders,'order')} · ${plural(s.tickets,'ticket')} · ${s.claimants} signed up · ${plural(s.members,'member')}${data.fetchedAt?` · updated ${fmtAgo(data.fetchedAt)}`:''}`; };
  const load=async(fresh)=>{
    try{
      data=await DB.roster(ev.id, fresh);
      if(data.configured===false){ body.innerHTML=`<div class="hint roster-empty">Eventbrite isn't configured on the proxy, so registrations can't be shown.</div>`; sum.textContent=''; return; }
      segs=L.segmentsFor(data.rows); if(!segs.some(s=>s.id===seg)) seg='all';
      selected=new Set([...selected].filter(k=>data.rows.some(r=>r.key===k)));   // drop selections that vanished
      paintSum(); paintSegs(); paintRows();
    }catch(e){
      sum.textContent='';
      if(e.status===403){ body.innerHTML=`<div class="hint roster-empty">Sign in as a program lead or council member to see attendees.</div>`; return; }
      body.innerHTML=`<div class="roster-err"><span>${esc(e.message||'Could not load attendees')}</span><button type="button" class="btn xs" data-act="roster-retry">Retry</button></div>`;
    }
  };
  wrap.addEventListener('click', async e=>{
    const sb=e.target.closest('[data-seg]'); if(sb){ seg=sb.dataset.seg; selected.clear(); paintSegs(); paintRows(); return; }
    // A click anywhere in a body row toggles its checkbox (except on the checkbox
    // itself — native — or a link). Dispatch change so the existing handler runs.
    const row=e.target.closest('tbody tr[data-key]');
    if(row){
      if(e.target.closest('[data-sel]') || e.target.closest('a')) return;
      const cb=row.querySelector('[data-sel]');
      if(cb){ cb.checked=!cb.checked; cb.dispatchEvent(new Event('change',{bubbles:true})); }
      return;
    }
    const a=e.target.closest('[data-act]'); if(!a) return;
    const act=a.dataset.act;
    if(act==='roster-refresh'||act==='roster-retry'){ body.innerHTML=SLOTS_LOADING_HTML; await load(true); return; }
    if(act==='roster-copy'){
      const emails=L.emailsOf(chosen()); const text=emails.join(', ');
      if(await copyText(text)){ toast(`Copied ${plural(emails.length,'email')}`); wrap.querySelector('.roster-copybox')?.remove(); return; }
      // Clipboard blocked (plain http, permissions, embedded browsers): hand the
      // list over inline so it can still be selected + copied by hand.
      let box=wrap.querySelector('.roster-copybox');
      if(!box){ box=document.createElement('div'); box.className='roster-copybox'; wrap.insertBefore(box, wrap.querySelector('.roster-foot')); }
      box.innerHTML=`<div class="hint">Couldn't reach the clipboard — select and copy:</div><textarea readonly rows="3"></textarea>`;
      const ta=box.querySelector('textarea'); ta.value=text; ta.focus(); ta.select();
      return;
    }
    if(act==='roster-mail' && a.classList.contains('disabled')){ e.preventDefault(); }
  });
  wrap.addEventListener('change', e=>{
    if(e.target.matches('[data-selall]')){ const vis=visible(); vis.forEach(r=> e.target.checked ? selected.add(r.key) : selected.delete(r.key)); paintRows(); return; }
    if(e.target.matches('[data-sel]')){ const key=e.target.closest('tr').dataset.key; if(e.target.checked) selected.add(key); else selected.delete(key); paintFoot(); }
  });
  // A deep-linked open can land BEFORE Firebase has yielded the token (page
  // load): don't fire a doomed unauthenticated request — wait for identity to
  // resolve, then load. Signed-out for real -> the notice, no request.
  const authBusy=()=>!state.authResolved || state.authPending;
  if(authBusy()){
    body.innerHTML=SLOTS_LOADING_HTML; sum.textContent='Signing in…';
    const onId=()=>{ document.removeEventListener('est:identity', onId); if(document.body.contains(wrap)) load(false); };
    document.addEventListener('est:identity', onId);
    return;
  }
  if(!state.idToken){ sum.textContent=''; body.innerHTML=`<div class="hint roster-empty">Sign in as a program lead or council member to see attendees.</div>`; return; }
  await load(false);
}
// Clipboard write with a legacy fallback (execCommand on a temp textarea) for
// contexts where navigator.clipboard is unavailable or denied. Returns success.
async function copyText(text){
  try{ if(navigator.clipboard && window.isSecureContext){ await navigator.clipboard.writeText(text); return true; } }catch(_){}
  try{
    const ta=document.createElement('textarea'); ta.value=text; ta.setAttribute('readonly',''); ta.style.cssText='position:fixed;top:0;left:0;opacity:0;pointer-events:none';
    document.body.appendChild(ta); ta.select(); ta.setSelectionRange(0, text.length);
    const ok=document.execCommand('copy'); ta.remove(); return !!ok;
  }catch(_){ return false; }
}
function fmtAgo(iso){
  const s=Math.max(0,(Date.now()-Date.parse(iso))/1000);
  if(!Number.isFinite(s)) return '';
  if(s<60) return 'just now';
  const m=Math.round(s/60); if(m<60) return `${m}m ago`;
  return `${Math.round(m/60)}h ago`;
}

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

function feedbackBoardHTML(context){
  const signedIn = !!(state.identity && state.identity.matched);
  return `<div class="fbboard" data-ctx="${context}">
    ${signedIn ? `<div class="fbform"><textarea class="fbtext" rows="2" placeholder="Suggest an idea…"></textarea><button type="button" class="btn sm primary" data-act="fb-submit">Submit</button></div>` : `<div class="hint">Sign in to add or +1 ideas.</div>`}
    <div class="fblist" aria-live="polite"><div class="hint">Loading ideas…</div></div>
  </div>`;
}
// Ideas of every status show (New included) so newly-submitted, un-triaged ideas
// are visible + differentiable from ones the council has Planned/Shipped.
const _fbStatusLabel = s => ({New:'New',Planned:'Planned',Shipped:'Shipped',Declined:'Declined'}[s]||'New');
function fbItemHTML(it){
  const canVote = !!(state.identity && state.identity.matched);
  const st = it.status||'New';
  return `<div class="fbitem"><button type="button" class="fbvote${it.votedByMe?' on':''}" data-vote="${esc(it.id)}" ${canVote?'':'disabled'} aria-label="Upvote">▲ ${it.votes||0}</button>`
    + `<span class="fbidea">${esc(it.idea)}</span><span class="fbstatus fbst-${st.toLowerCase()}">${esc(_fbStatusLabel(st))}</span></div>`;
}
async function wireFeedback(root, context){
  const board=root.querySelector('.fbboard'); if(!board) return;
  const list=board.querySelector('.fblist');
  let items=[];
  const paint=()=>{ list.innerHTML = items.length ? items.map(fbItemHTML).join('') : `<div class="hint">No ideas yet — be the first.</div>`; };
  const reload=async()=>{ items=await DB.listFeedback(context); paint(); };
  await reload();
  board.addEventListener('click', async e=>{
    const sb=e.target.closest('[data-act="fb-submit"]');
    if(sb){
      const ta=board.querySelector('.fbtext'); const val=(ta.value||'').trim();
      if(!val){ toast('Write an idea first','err'); return; }
      try{
        await DB.submitFeedback(val, context); ta.value='';
        // Optimistic: show it immediately (Coda's read-after-write lag can hide it
        // from an instant re-fetch). Reconcile shortly after.
        items.unshift({ id:'_tmp'+Date.now(), idea:val, context, votes:0, votedByMe:false, status:'New', submittedByName:(state.identity&&state.identity.name)||'' });
        paint(); toast('Idea submitted','ok');
        setTimeout(reload, 2500);
      }catch(err){ toast(err.message||'Submit failed','err'); }
      return;
    }
    const vb=e.target.closest('[data-vote]');
    if(vb){
      const id=vb.dataset.vote; if(id.startsWith('_tmp')){ toast('Just a sec — saving…','busy'); return; }
      try{ const r=await DB.voteFeedback(id); const it=items.find(x=>x.id===id); if(it){ it.votes=r.votes; it.votedByMe=r.votedByMe; paint(); } }
      catch(err){ if(err.status===401&&typeof sessionExpired==='function') sessionExpired(); else toast(err.message||'Vote failed','err'); }
    }
  });
}


/* ---- optimistic writes: reflect the change instantly, reconcile after ------ */
let _toastEl=null, _toastT=null;
function toast(msg, kind){
  if(!_toastEl){ _toastEl=document.createElement('div'); _toastEl.className='toast'; document.body.appendChild(_toastEl); }
  _toastEl.textContent=msg; _toastEl.className='toast show'+(kind?' '+kind:'');
  clearTimeout(_toastT);
  if(kind!=='busy') _toastT=setTimeout(()=>{ if(_toastEl) _toastEl.className='toast'; }, 2200);
}
function hideToast(){ clearTimeout(_toastT); if(_toastEl) _toastEl.className='toast'; }
/* ---- tooltips: any element with data-tip gets one shared bubble, shown at once
   on hover or keyboard focus (title= is slow and never shows for keyboards).
   Fixed-position so a modal can't clip it; touch gets none (there's no hover). */
const _tip=document.createElement('div'); _tip.className='tip'; _tip.setAttribute('role','tooltip'); _tip.hidden=true;
document.body.appendChild(_tip);
let _tipFor=null;
let _tipMuted=null;   // the element just clicked — no bubble again until the pointer leaves it
function showTip(el){
  const text=el.dataset.tip; if(!text) return;
  _tipFor=el; _tip.textContent=text; _tip.hidden=false;
  const r=el.getBoundingClientRect(), w=_tip.offsetWidth, h=_tip.offsetHeight, vw=document.documentElement.clientWidth;   // (not innerWidth: that includes a scrollbar)
  const left=Math.max(6, Math.min(r.left + r.width/2 - w/2, vw - w - 6));
  const top=(r.bottom + 6 + h > innerHeight - 6) ? r.top - h - 6 : r.bottom + 6;   // flip above near the bottom edge
  _tip.style.left=left+'px'; _tip.style.top=top+'px';
}
function hideTip(){ _tipFor=null; _tip.hidden=true; }
document.addEventListener('pointerover', e=>{
  if(e.pointerType==='touch') return;
  if(_tipFor && !_tipFor.isConnected) hideTip();   // its element was re-rendered away
  const el=e.target.closest('[data-tip]');
  if(el && el===_tipMuted) return;
  _tipMuted=null;
  if(el){ if(el!==_tipFor) showTip(el); } else if(_tipFor) hideTip();
});
document.addEventListener('pointerout', e=>{ if(!e.relatedTarget) hideTip(); });   // left the window
document.addEventListener('focusin', e=>{ const el=e.target.closest('[data-tip]'); if(el && el.matches(':focus-visible')) showTip(el); });
document.addEventListener('focusout', hideTip);
document.addEventListener('pointerdown', e=>{ _tipMuted=e.target.closest('[data-tip]'); hideTip(); });
document.addEventListener('scroll', hideTip, true);
document.addEventListener('keydown', e=>{ if(e.key==='Escape') hideTip(); });
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
const _busyLabel=new Map();   // event id → what its footer button says meanwhile ("Cancelling…"; default "Saving…")
const _authRetry=new Set();   // event ids whose save hit an expired session — sent again after sign-in
const sameVal=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const formCells = f => eventToCodaCells(f).filter(c => c.column!=='Status');
// Honest saves (D3): "Saved" means Coda has APPLIED a write, not just accepted it
// (202). applied() polls the Worker's /mutation route via CodaApplied.waitApplied.
// The queue's write awaits it, so saveQueue.status(id)==='saving' covers the apply
// time of edits; _applying counts only applies started outside the queue (create,
// transitions). pendingFor(id) is the one answer the pill and footer read.
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
// A bare debounce timer doesn't count: the footer's primary must not turn into
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
  // The pill shows only a failed save (R21): saving shows in the footer's primary
  // ("Saving…" / "Still saving…"), and when nothing is saving, it's saved.
  const el=document.getElementById('saveStatus');
  if(el){
    el.className='savestat '+s;
    el.textContent = s==='error' ? 'Save failed — retry' : '';
  }
  renderEditorFooter();                        // the footer's primary slot follows pendingFor too
}
/* ---- footer wizard (spec 5.5; D1 stable containers, D6 pure model) ----------
   ListingRules.footerModel decides everything; this only paints it. Called on open,
   on a tab switch and whenever the save pill repaints, so the primary slot follows
   pendingFor: "Saving…" (disabled) until every queued edit is applied. */
const KEBAB_ICON = `<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="12" cy="5" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="12" cy="19" r="1.8"/></svg>`;
const SPIN_ICON = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-6.2-8.6"/></svg>`;
let _menuOpen=false;
function editorFooterModel(ev, ctx){
  const R=ListingRules, st=_ebStatus.get(ev.id), wc=_pushChecks.get(ev.id);
  const local=R.readiness(ev, { venue: venueRecord(ev), todayISO: todayStr });
  const input={
    stage: R.stageOf(ev),          // live: publish status can change while the editor is open
    past: ctx.past,
    role: ctx.role,
    checks: mergePushChecks(local, wc),
    pending: pendingFor(ev.id) || _pushing.has(ev.id),   // a push under way holds the primary at Saving…
    sending: _sending.has(ev.id),                        // …then Sending to Eventbrite… during the Worker call
    busy: _busy.has(ev.id) ? (_busyLabel.get(ev.id) || true) : null,   // a transition/cancel/delete in flight
    slow: _slow.has(ev.id),                              // past CodaApplied's slow mark: "Still saving…"
    unpushed: R.unpushedFields(ev, ev.pushed || null),
    pushed: ev.pushed || null,     // null: pushed before the snapshot existed — offer the update (not compared)
    ebEditedElsewhere: ebConflict(ev.id),
    registrants: st && st.sold!=null ? Number(st.sold) : null,   // null until the live status loads
    capacity: ebCapacity(ev),
    proposedBy: null,              // the row doesn't record who proposed it (Edited by changes on every edit)
    justChanged: _justChanged.get(ev.id) || null,
  };
  const m=R.footerModel(input);
  // The Worker's "needs X" (a 409) shows as links and field tags until the next
  // edit, but doesn't lock the button: after a stale read the same click can
  // succeed, and there may be nothing left to edit.
  if(wc && m.primary && m.primary.act){
    const ml=R.footerModel(Object.assign({}, input, { checks: local }));
    if(ml.primary && ml.primary.act===m.primary.act) m.primary.enabled=ml.primary.enabled;
  }
  return m;
}
function footerStepsHTML(m){
  const cur=m.steps.findIndex(s=>s.state==='current');
  let steps='';
  if(cur>=0){
    const last=m.steps.length-1;
    const dots=m.steps.map((s,i)=>{
      const ln = i ? `<span class="ln${s.state!=='todo'?' d':''}"></span>` : '';
      const tone = s.state==='current' && i===last ? ' g' : '';
      return `${ln}<span class="dot ${s.state}${tone}"></span><span class="${s.state==='current'?'cur'+tone:''}">${esc(s.label)}</span>`;
    }).join('');
    steps = `<div class="fsteps" aria-label="Step ${cur+1} of ${m.steps.length}: ${esc(m.steps[cur].label)}">${dots}</div>`
      + `<div class="fsteps-ph" aria-hidden="true">Step ${cur+1} of ${m.steps.length} · ${esc(m.steps[cur].label)}</div>`;
  }
  return steps;
}
function footerMsgHTML(m){
  const links = m.links.length ? `<span class="fsub flinks">${m.links.map(l=>
    l.field ? `<a href="#" data-focus-field="${esc(l.field)}">${esc(l.label)}</a>` : esc(l.label)).join(' · ')}</span>` : '';
  return `${m.title?`<b class="ftitle">${esc(m.title)}</b>`:''}${links}${m.sub?`<span class="fsub">${esc(m.sub)}</span>`:''}`;
}
function footerActsHTML(m, onDetails){
  // Off Details only an in-flight button shows (Saving…, Deleting…): the pill no
  // longer says Saving, so this is every tab's saving signal.
  if(!onDetails){
    const p=m.primary;
    if(!(p && !p.act && !p.enabled && p.tone!=='quiet')) return '';
    m = { primary: p };
  }
  let h='';
  if(m.secondary) h += `<button type="button" class="btn fbtn sec" data-act="${esc(m.secondary.act)}"${m.busy?' disabled':''}>${esc(m.secondary.label)}</button>`;
  const p=m.primary;
  // The model's quiet "✓ Saved" isn't shown (R21): when nothing is saving, it's saved.
  if(p && p.tone!=='quiet'){
    // In flight ("Saving…", "Sending to Eventbrite…"): aria-disabled, not disabled, so
    // its tip still shows on hover; it has no data-act, so a click does nothing.
    const wait = !p.act && !p.enabled;
    const off = wait ? ' aria-disabled="true"' : p.enabled ? '' : ' disabled';
    const tip = p.tip ? ` data-tip="${esc(p.tip)}"` : '';
    h += `<button type="button" class="btn fbtn ${p.tone==='go'?'go':'primary'}${wait?' wait':''}"${p.act?` data-act="${esc(p.act)}"`:''}${off}${tip}>${wait?SPIN_ICON:''}${esc(p.label)}</button>`;
  }
  return h;
}
// The ⋮ menu has its own container (#edMenu): primary repaints never touch it, and it
// is rebuilt (closed) only when its items change. Open/close just flips attributes.
function footerMenuHTML(menu, busy){
  if(!menu.length) return '';
  // While a step is under way (busy), ⋮ is disabled: nothing else may start meanwhile.
  return `<button type="button" class="kb" data-act="menu" aria-label="More actions" data-tip="More actions" aria-haspopup="menu" aria-expanded="false"${busy?' disabled':''}>${KEBAB_ICON}</button>`
    + `<div class="kmenu" role="menu" aria-label="More actions" hidden>${menu.map(it=>
      `<button type="button" class="mi${it.tone==='danger'?' danger':''}" role="menuitem" tabindex="-1" data-act="${esc(it.act)}"><b>${esc(it.label)}</b>${it.sub?`<span>${esc(it.sub)}</span>`:''}</button>`).join('')}</div>`;
}
// Write a container's inner HTML only when it changed (the last write is cached on the
// element): the pill repaints often, and a rewrite would drop focus.
function paintInner(el, html){ if(el._html!==html){ el.innerHTML=html; el._html=html; return true; } return false; }
function renderEditorFooter(){
  const msgEl=document.getElementById('edFoot'), actEl=document.getElementById('edActs'), menuEl=document.getElementById('edMenu');
  if(!msgEl || !actEl || !menuEl || !_ctx || !editing || _ctx.ev!==editing) return;
  const m=editorFooterModel(editing, _ctx), onDetails = activeSection==='details';
  const stepsEl=document.getElementById('edSteps'); if(stepsEl) paintInner(stepsEl, onDetails ? footerStepsHTML(m) : '');
  // Other tabs: one line on what the tab is for, plus ⋮ (R28).
  const foot = (SECTIONS.find(x=>x.id===activeSection)||{}).foot;
  paintInner(msgEl, onDetails ? footerMsgHTML(m) : foot ? `<span class="fsub ftabdesc">${esc(foot)}</span>` : '');
  const bEl=document.getElementById('mBadges'); if(bEl) paintInner(bEl, badgesHTML(editing));   // the badge follows the same stage
  paintInner(actEl, footerActsHTML(m, onDetails));
  if(paintInner(menuEl, footerMenuHTML(m.menu, m.busy))) _menuOpen=false;   // items changed: it's a new (closed) menu
  paintFieldMarks();   // field markers/tags follow the same event state as the footer
}
function kebabMenu(open, focusFirst){
  const wrap=document.getElementById('edMenu'), btn=wrap && wrap.querySelector('.kb'), menu=wrap && wrap.querySelector('.kmenu');
  if(!btn || !menu){ _menuOpen=false; return; }
  _menuOpen=!!open;
  menu.hidden=!open; btn.setAttribute('aria-expanded', String(!!open)); btn.classList.toggle('on', !!open);
  if(open){ hideTip(); if(focusFirst){ const f=menu.querySelector('[role="menuitem"]'); if(f) f.focus(); } }
}
// Footer links name a field that blocks the next step: bring it into view and focus it.
const FOCUS_FIELD_EL = { title:'f_title', description:'f_desc', programs:'f_progs', leads:'f_leads', date:'f_date', start:'f_start', end:'f_end',
  venue:'f_venue_box', capacity:'f_capacity', publicSummary:'f_pubsummary', publicDescription:'f_pubdesc', addressVisibility:'f_addrvis' };
// The tab each field lives on (anything not listed is on Details).
const FIELD_SECTION = { description:'planning', programs:'planning', leads:'planning' };
function focusField(field){
  const sec=FIELD_SECTION[field] || 'details';
  if(sec!==activeSection){ const b=document.querySelector(`#wrail [data-sect="${sec}"]`); if(b) b.click(); }   // the rail's own switch: autosave, render, footer, URL
  let el=document.getElementById(FOCUS_FIELD_EL[field]||'');
  if(!el && (field==='date' || field==='start' || field==='end')) el=document.getElementById('f_when');   // not an exact date yet
  if(!el) return;
  el.scrollIntoView({ block:'center', behavior:'smooth' });
  const target = el.matches('input,select,textarea,button') ? el : el.querySelector('input:not([disabled]),select,textarea,button:not([disabled])');
  if(target) target.focus({ preventScroll:true });
}
function paintSaveStatus(){
  if(!editing || !editing.id) return;
  const id=editing.id, q=saveQueue.status(id);
  const saving = q==='saving' || (_applying.get(id)||0) > 0;
  setSaveStatus(saving ? (_slow.has(id) ? 'slow' : 'saving') : (q==='error' || _unconfirmed.has(id)) ? 'error' : _autosaveT ? 'dirty' : 'clean');
}
function scheduleAutosave(){
  if(!_form || _form.ev!==editing) return;     // create modal / read-only: nothing to auto-save into
  // Every focusout lands here, including the one from clicking a footer button: only
  // a real change marks the form dirty, so a bare blur never repaints the footer
  // under the click (which would swallow it).
  if(!SaveQueue.changedCells(_form.base, formCells(readForm())).length) return;
  clearTimeout(_autosaveT); _autosaveT=setTimeout(autosaveEditor, 800);
  setSaveStatus('dirty');                      // pill: Unsaved changes (the footer's primary stays put)
}
// Queue whatever the open form changed since it was last queued. Synchronous, so
// close() can call it on the way out — the queue writes it after the editor is gone.
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
// Lifecycle transition (Propose/Approve/Reopen): the event's queued field edits
// land first, then the new Status goes out on its own, then the editor is rebuilt
// so locked/footer/publish reflect the new state. Works on the event it started
// with — `editing` may close or change while it waits. Cancel is separate (it
// tears down Eventbrite).
async function transitionTo(status){
  const ev=editing;
  if(!ev || !ev.id || _busy.has(ev.id)) return;
  if(status==='approved' && isPastEvent(ev) && !confirm('This event’s date has passed. Once it’s approved, its details lock and it can’t be cancelled or deleted. Approve anyway?')) return;
  autosaveEditor();                            // queue any field edit still in the form
  _busy.add(ev.id); guardUnload();
  const prev=ev.status;
  ev.status=status;
  ev.editedBy=(state.identity && state.identity.name) || ev.editedBy;
  applyLocal(ev); rerender(); renderEditorFooter();   // in flight: the footer's button says Saving… (R21), no toast
  let fieldsFailed=false;
  try{
    await saveQueue.settle(ev.id).catch(err=>{ fieldsFailed=true; throw err; });
    await afterCreate(ev.id);
    const w=await DB.update(ev.id, [{column:'Status', value:cap(status)}]);
    await applied(w && w.requestId, ev.id);     // Approve → Add to Eventbrite must see the new Status in Coda
    markRecent(ev.id, {e:ev}); scheduleReconcile(); clearEbBlock(ev.id);
    toast(status==='approved'?'Approved':(status==='draft'?'Reopened':'Proposed'),'ok');
  }catch(err){
    ev.status=prev; applyLocal(ev); rerender();
    if(err && err.status===401) sessionExpired();
    else {
      const unconfirmed = !fieldsFailed && err && err.message==='save not confirmed';   // accepted, but Coda never said it applied
      toast(fieldsFailed ? 'Your changes didn’t save, so the status wasn’t changed — try again' : unconfirmed ? 'Coda didn’t confirm the change. Check again in a minute.' : 'Update failed — reverted','err');
      console.warn('transition failed:', err);
      if(unconfirmed) scheduleReconcile();
    }
  }finally{
    _busy.delete(ev.id); guardUnload();
    if(editing===ev) openEditor(ev, activeSection);   // (openEditor first queues anything typed meanwhile)
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
  ev.status='cancelled'; applyLocal(ev); rerender(); renderEditorFooter();   // in flight: the footer's button, no toast
  try{
    await saveQueue.settle(ev.id).catch(()=>{});   // queued edits land first; one that fails is reported, not a reason to stop
    const res=await DB.cancelEventbrite(ev.id);
    if(res && res.publishStatus) ev.publishStatus=res.publishStatus;
    trackWorkerWrite(ev, res && res.requestId); scheduleReconcile(); clearEbBlock(ev.id);
    // The event is locked now, so a field edit that failed has nowhere to be retried.
    if(saveQueue.status(ev.id)==='error') dropFailedEdits(ev.id, 'Event cancelled, but your last change to it didn’t save');
    else toast('Event cancelled','ok');
  }catch(err){
    Object.assign(ev, prev); applyLocal(ev); rerender();
    if(err && err.status===401) sessionExpired();
    else if(err && err.status===409 && err.needsEventbriteCancel){ hideToast(); showEbBlock(ev, err); }   // people registered: nothing changed
    else toast((err&&err.message)||'Cancel failed','err');
  }finally{
    _busy.delete(ev.id); _busyLabel.delete(ev.id); guardUnload();
    if(editing===ev) openEditor(ev, activeSection);
  }
}
async function deleteEditor(){
  const ev=editing;
  if(!ev || !ev.id){ close(); return; }
  if(_busy.has(ev.id)) return;
  if(!confirm('Delete this event? This can\'t be undone.' + (ev.eventbriteId ? ' Its private Eventbrite draft is deleted too.' : ''))) return;
  const id=ev.id;
  _busy.add(id); _busyLabel.set(id, 'Deleting…');
  _form=null; _unsaved.delete(id); _authRetry.delete(id); guardUnload();   // its unsaved edits go with it — close() has nothing to queue or retry
  const drained=saveQueue.discard(id);
  // The editor stays open (inert) while the delete runs: its footer button says
  // Deleting… (R21) instead of a busy toast. It closes once the row is gone.
  const panel=document.getElementById('wpanel'); if(panel) panel.inert=true;
  applyLocal({id}, true); rerender(); renderEditorFooter();
  try{
    await drained;                             // …and a write already in flight finishes before the delete
    await afterCreate(id);                     // a just-created row: let its insert apply first
    await DB.remove(id);
    _unconfirmed.delete(id);
    markRecent(id, { deleted:true });
    if(editing===ev) close();
    toast('Deleted','ok'); scheduleReconcile();
  }catch(err){
    applyLocal(ev); rerender();
    if(err && err.status===401) sessionExpired();
    else { toast((err && (err.status===409 || err.status===502) && err.message) || 'Delete failed — restored','err'); console.warn('delete failed:', err); }   // the Worker's reason (cancel first / Eventbrite refused); the row is kept
  }finally{
    _busy.delete(id); _busyLabel.delete(id); guardUnload();
    if(editing===ev) openEditor(ev, activeSection);   // failed (success closed it): back to a live editor — its form was let go
  }
}

// Unpublish (back to private): the listing goes back to a private Eventbrite draft
// and gather hides it. Refused (409 needsEventbriteCancel) once anyone registered.
async function unpublishEvent(){
  const ev=editing;
  if(!ev || !ev.id || !ev.eventbriteId || _busy.has(ev.id)) return;
  if(!confirm('Make this listing private again? It disappears from Eventbrite and gather until you publish it again.')) return;
  const id=ev.id;
  _busy.add(id); _busyLabel.set(id, 'Unpublishing…'); guardUnload(); renderEditorFooter();   // in flight: the footer's button (R21)
  try{
    const res=await DB.unpublishEventbrite(id);
    ev.publishStatus=(res && res.publishStatus) || 'Draft';
    clearEbBlock(id);
    applyLocal(ev); rerender();
    trackWorkerWrite(ev, res && res.requestId); scheduleReconcile();
    toast('Unpublished. It’s a private draft on Eventbrite again','ok');
    refreshEbStatus(ev);
  }catch(err){
    if(err && err.status===401) sessionExpired();
    else if(err && err.status===409 && err.needsEventbriteCancel){ hideToast(); showEbBlock(ev, err); }
    else { toast((err && err.message) || 'Couldn’t unpublish. Try again.','err'); scheduleReconcile(); }   // (e.g. it was cancelled on Eventbrite)
  }finally{
    _busy.delete(id); _busyLabel.delete(id); guardUnload();
    if(editing===ev) renderEditorFooter();     // footer + card only (D1)
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
function paintEbBlock(){
  const bar=document.getElementById('edBlock'); if(!bar) return;
  const b=_ebBlock, ev=editing;
  if(!b || !ev || ev.id!==b.id){ bar.hidden=true; bar.innerHTML=''; return; }
  const url=/^https?:\/\//i.test(ev.eventbriteUrl || '') ? ev.eventbriteUrl : '';
  const n=b.registrants;
  bar.innerHTML=`<span class="edguard-msg">${esc(b.error)}</span>`
    + (url ? `<a class="btn fbtn sec" href="${esc(url)}" target="_blank" rel="noopener">Open in Eventbrite ↗</a>` : '')
    + (n > 0 ? `<button type="button" class="btn fbtn sec" data-block="email">Email the ${n} registrant${n===1?'':'s'}</button>` : '');
  bar.hidden=false;
}

/* ---- Eventbrite push: Add to Eventbrite / Update draft / Publish / Update listing
   (spec 5.3–5.6, D8). The Worker builds the listing from what Coda has, so every
   edit must be applied first; it re-checks readiness and answers 409 {error,
   checks} or 409 {conflict} (Eventbrite edited since our last push). On success
   it returns the snapshot it stored (`pushed`, R15), which the app adopts as-is.
   Nothing from the live status is ever put into the form or written (D4). */
const PUSH_ACTS = {
  'add-eb':         { draftOnly:true,  ok:'Added to Eventbrite as a private draft' },
  'update-eb':      { draftOnly:true,  ok:'Eventbrite draft updated' },
  'publish-eb':     { draftOnly:false, ok:'Published. Registration is open' },
  'update-listing': { draftOnly:false, ok:'Eventbrite listing updated' },
};
const EB_CONFLICT_NOTICE = ListingRules.EB_CONFLICT_NOTICE;   // one text for the card and the footer
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
// (a publish-step answer leaves the add checks alone), so the footer links and
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
  if(editing && editing.id===id) renderEditorFooter();   // footer + card; another open event ignores it
}
function dismissChangeNotice(){
  if(!editing) return;
  _justChanged.delete(editing.id); renderEditorFooter();
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
    if(editing===ev) renderEditorFooter();
  }
}
// Wait until nothing for this event is queued, in flight or unapplied. Resolves
// false when an edit failed or a create was never confirmed (nothing to wait for).
async function settledForPush(id){
  const deadline=Date.now()+150000;            // waitApplied gives up at 120 s
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
  if(!m.primary || m.primary.act!==act || !m.primary.enabled) return;   // only the action the footer offers right now
  const id=ev.id, force=_conflictShown.has(id);
  _busy.add(id); _pushing.add(id); guardUnload();
  if(editing===ev) renderEditorFooter();
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
    _sending.add(id); if(editing===ev) renderEditorFooter();   // the footer's button says Sending to Eventbrite… (R21), no busy toast
    let res;
    try{ res=await DB.publishEventbrite(id, spec.draftOnly, force); }
    catch(err){
      _sending.delete(id);
      if(err && err.status===401){ sessionExpired(); return; }
      // The Worker may have created the event (or written the row) before failing:
      // adopt its id so nothing re-creates it, and wait for that write to apply.
      if(err && err.eventbriteId && !ev.eventbriteId){ ev.eventbriteId=err.eventbriteId; applyLocal(ev); rerender(); }
      if(err && (err.requestId || err.eventbriteId)) trackWorkerWrite(ev, err.requestId);
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
    if(res.eventbriteId) ev.eventbriteId=String(res.eventbriteId);
    if(res.url) ev.eventbriteUrl=res.url;
    ev.publishStatus = res.publishStatus || (spec.draftOnly ? 'Draft' : 'Published');
    ev.lastPublishError='';
    if(res.pushed && typeof res.pushed==='object') ev.pushed=res.pushed;   // R15: the Worker's own snapshot
    _pushChecks.delete(id); _ebConflict.delete(id); _conflictShown.delete(id); clearEbBlock(id);
    const st=_ebStatus.get(id); if(st) st.editedSincePush=false;
    applyLocal(ev); rerender();
    trackWorkerWrite(ev, res.requestId); scheduleReconcile();
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
    if(editing===ev) renderEditorFooter();     // footer + card only (D1); the form keeps focus and values
  }
}

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

document.getElementById('months').addEventListener('click',e=>{
  const gchip=e.target.closest('.gchip'); if(gchip){ const ev=state.events.find(x=>x.id===gchip.dataset.id); if(ev) openEditor(ev); return; }
  const gadd=e.target.closest('[data-newidea]'); if(gadd){ openNewEventForm(newIdeaInMonth(gadd.dataset.newidea)); return; }
  const chip=e.target.closest('.chip');
  if(chip){
    if(chip.dataset.noop) return;
    if(chip.dataset.expand){
      const ds=chip.dataset.expand; const list=state.events.filter(x=>x.date===ds && ((x.source==='planning'&&state.layers.planning)||(x.source==='ref'&&state.layers[x.refLayer]))).sort(sortEv);
      openDayPicker(ds,list); return;
    }
    const ev=state.events.find(x=>x.id===chip.dataset.id);
    if(ev) openEditor(ev);
    return;
  }
  const add=e.target.closest('[data-add-date]'); if(add) openNewEventForm(newEventOn(add.dataset.addDate));   // only the + adds — the rest of the day does nothing
});

document.getElementById('quarter').addEventListener('click',e=>{
  const chip=e.target.closest('.qchip');
  if(chip){ const ev=state.events.find(x=>x.id===chip.dataset.id); if(ev) openEditor(ev); return; }
  const z=e.target.closest('.zone-add'); if(z) openNewEventForm(newEventOn(z.dataset.add));   // only the + adds
});

function newEventOn(date){
  return {id:null,source:'planning',program:'',programs:[],title:'',leads:[],date,start:'18:30',end:'20:00',allDay:false,location:'',status:'draft',description:'',scheduling:'exact',rangeStart:'',rangeEnd:'',targetMonth:'',createdBy:state.currentUser,editedBy:state.currentUser,eventbriteUrl:'',gcalId:''};
}
function newIdeaInMonth(mkey){
  return {id:null,source:'planning',program:'oth',title:'',leads:[],date:'',start:'',end:'',allDay:false,location:'',status:'draft',description:'',scheduling:'month',rangeStart:'',rangeEnd:'',targetMonth:mkey,createdBy:state.currentUser,editedBy:state.currentUser,eventbriteUrl:'',gcalId:''};
}

/* tiny day picker when a cell overflows */
function openDayPicker(ds,list){
  if(leaveGuard(()=>openDayPicker(ds,list))) return;
  leaveForm();
  editing={id:'__picker__'};
  document.getElementById('mStripe').style.setProperty('--c','var(--accent)');
  document.getElementById('mTitle').textContent=fmtDate(ds);
  document.getElementById('mBadges').innerHTML=''; clearHeadMeta(); document.getElementById('mActions').innerHTML=`<span class="badge b-ref">${list.length} events</span>`;
  document.getElementById('mBody').innerHTML=`<div class="fld full"><div class="chips" id="dp">${list.map(chipHTML).join('')}</div></div>`;
  document.getElementById('mFoot').innerHTML=`<button class="btn primary" data-act="newhere">+ New on this day</button><span class="push"></span><button class="btn" data-act="close">Close</button>`;
  document.getElementById('dp').addEventListener('click',ev=>{ const c=ev.target.closest('.chip'); if(!c) return; const item=state.events.find(x=>x.id===c.dataset.id); if(item) openEditor(item); });
  document.getElementById('mFoot').querySelector('[data-act="newhere"]').addEventListener('click',()=>openNewEventForm(newEventOn(ds)));
  show();
}

/* keep sticky offsets correct as the (multi-row) header height changes */
function layoutSticky(){
  const bar=document.querySelector('.bar'), wh=document.getElementById('weekhead');
  if(bar) document.documentElement.style.setProperty('--bar-h', bar.offsetHeight+'px');
  if(wh && wh.offsetHeight) document.documentElement.style.setProperty('--wh-h', wh.offsetHeight+'px');
}
window.addEventListener('resize', layoutSticky);

/* view switch */
// Phones (≤600px — the same breakpoint as the stylesheet) get the list only: the
// grids don't fit, and the one-row header has no view switch.
const PHONE_MQ = window.matchMedia('(max-width:600px)');
function curView(){ return PHONE_MQ.matches ? 'list' : state.view; }
function rerender(){ const v=curView(); if(v==='overview') renderOverview(); else if(v==='list') renderList(); else renderMonths(); }
function applyView(){
  const v=curView();
  document.getElementById('yearView').style.display = v==='year' ? '' : 'none';
  document.getElementById('quarter').classList.toggle('on', v==='overview');
  document.getElementById('listView').classList.toggle('on', v==='list');
  rerender(); updateNavLabel(); layoutSticky();
}
PHONE_MQ.addEventListener('change', ()=>{ phoneMenu(false); applyView(); });   // rotated, or a window resized across 600px
document.getElementById('viewSeg').addEventListener('click',e=>{
  const b=e.target.closest('button'); if(!b) return;
  state.view=b.dataset.view; prefs.view=state.view; savePrefs();
  [...b.parentElement.children].forEach(x=>x.setAttribute('aria-pressed', x===b));
  applyView();
});

/* feedback / ideas modal */
function openFeedback(){
  if(leaveGuard(()=>openFeedback())) return;
  leaveForm();   // (reachable by keyboard while an event is open — its edits must not be lost or misfiled)
  editing={id:'__feedback__'};
  document.getElementById('modal').classList.remove('ws'); document.getElementById('mBody').classList.remove('ws');
  document.getElementById('mStripe').style.setProperty('--c','var(--accent)');
  document.getElementById('mTitle').textContent='Feedback & ideas';
  document.getElementById('mBadges').innerHTML=''; clearHeadMeta(); document.getElementById('mActions').innerHTML=''; document.getElementById('mFoot').innerHTML=`<span class="push"></span><button class="btn" data-act="close">Close</button>`;
  const body=document.getElementById('mBody'); body.innerHTML=`<div class="fld full"><div class="hint">Suggest anything, or +1 an idea. For section-specific ideas, open an event and visit that section.</div>${feedbackBoardHTML('General')}</div>`;
  wireFeedback(body,'General'); show();
}
document.getElementById('feedbackBtn').addEventListener('click', openFeedback);

/* close the account + overflow menus on outside click / Esc */
document.addEventListener('click', e=>{
  if(!e.target.closest('.acct')) acctMenu(false);
  if(!e.target.closest('#ovfPanel') && !e.target.closest('#ovfBtn')) ovfMenu(false);
  if(!e.target.closest('.msel')) document.querySelectorAll('.msel-menu').forEach(m=>{ m.hidden=true; const b=m.parentElement.querySelector('.msel-btn'); if(b) b.setAttribute('aria-expanded','false'); });
});
document.addEventListener('keydown', e=>{
  if(e.key!=='Escape') return;
  acctMenu(false);
  const p=document.getElementById('ovfPanel');
  if(p && !p.hidden){ const back=p.contains(document.activeElement); ovfMenu(false); if(back) document.getElementById('ovfBtn').focus(); }
  if(!document.getElementById('menuPanel').hidden){ phoneMenu(false); document.getElementById('menuBtn').focus(); }
});

/* layer toggles (⚙ pop-over and ☰ menu) */
for(const id of LAYER_BOXES) document.getElementById(id).addEventListener('click',e=>{
  const lab=e.target.closest('.lyr'); if(!lab) return;
  const layer=lab.dataset.layer;               // 'planning' or a reference layer id
  state.layers[layer]=!state.layers[layer];
  prefs.layers[layer]=state.layers[layer]; savePrefs();
  syncLayerToggles();
  rerender();
});

/* nav — both views span a program year */
function navStep(dir){ state.startYear+=dir; rerender(); updateNavLabel(); }
function updateNavLabel(){
  const el=document.getElementById('yrLabel');
  el.textContent=`'${String(state.startYear).slice(2)}–'${String(state.startYear+1).slice(2)}`;   // compact: '26–'27
  el.title=`Program year ${state.startYear}–${state.startYear+1}`;
  const my=document.getElementById('menuYr'); my.textContent=el.textContent; my.title=el.title;
}
document.getElementById('prevYr').addEventListener('click',()=>navStep(-1));
document.getElementById('nextYr').addEventListener('click',()=>navStep(1));
function addEvent(){ openNewEventForm(newEventOn(inProgramYear(todayStr)?todayStr:firstOfProgramYear())); }
document.getElementById('addBtn').addEventListener('click', addEvent);
document.getElementById('fabAdd').addEventListener('click', addEvent);
function firstOfProgramYear(){ return ymd(state.startYear,8,1); }
function inProgramYear(ds){ return ds>=ymd(state.startYear,8,1) && ds<=ymd(state.startYear+1,7,31); }

/* ---- Firebase sign-in (identity + role gating via the Worker /me) -------- */
// Token lifecycle is owned by Firebase (auth-firebase.js). We keep the latest
// ID token in memory for the Authorization header; Firebase persists the session
// and streams refreshed tokens via estAuth.init's onToken callback.
function jwtClaims(t){ try{ return JSON.parse(atob(String(t).split('.')[1].replace(/-/g,'+').replace(/_/g,'/'))); }catch(_){ return {}; } }
function initials(name){ return (String(name||'?').trim().split(/\s+/).map(w=>w[0]).slice(0,2).join('')||'?').toUpperCase(); }
function roleLabel(id){ return id.canApprove ? 'Tribal Council' : (id.canWrite ? 'Program Lead' : (id.matched ? 'Member' : 'Not a recognized lead')); }
function renderAuth(){
  const el = document.getElementById('authSlot'), menu = document.getElementById('menuAcct'); if(!el) return;
  const id = state.identity;
  if(id && id.signedIn){
    const claims = jwtClaims(state.idToken);
    const name = id.name || claims.name || claims.email || 'Account';
    const pic = claims.picture || '';
    el.innerHTML = `<div class="acct">
        <button class="avatar" id="avatarBtn" aria-haspopup="menu" aria-expanded="false" title="${esc(name)}">${pic ? `<img src="${esc(pic)}" alt="" referrerpolicy="no-referrer">` : esc(initials(name))}</button>
        <div class="acct-menu" id="acctMenu" role="menu" hidden>
          <div class="acct-who"><b>${esc(name)}</b><span class="role">${esc(roleLabel(id))}</span></div>
          ${id.canApprove?`<button class="btn ghost" id="refreshPeople" role="menuitem" title="Pull People + roles fresh from Coda now (after granting someone a role)">Refresh roles &amp; people</button>`:''}
          <button class="btn ghost" id="signOut" role="menuitem">Sign out</button>
        </div>
      </div>`;
    el.querySelector('#avatarBtn').addEventListener('click', e=>{ e.stopPropagation(); acctMenu(); });
    el.querySelector('#signOut').addEventListener('click', signOut);
    const rp=el.querySelector('#refreshPeople');
    if(rp) rp.addEventListener('click', ()=>refreshRoles(rp));
    // the phone ☰ menu shows the same account, flat (no avatar pop-up)
    menu.innerHTML = `<div class="menu-acct">
        <span class="avatar" aria-hidden="true">${pic ? `<img src="${esc(pic)}" alt="" referrerpolicy="no-referrer">` : esc(initials(name))}</span>
        <div class="acct-who"><b>${esc(name)}</b><span class="role">${esc(roleLabel(id))}</span></div>
      </div>
      <div class="menu-acct-acts">
        ${id.canApprove?`<button class="btn sm" id="menuRefreshPeople" type="button">Refresh roles &amp; people</button>`:''}
        <button class="btn sm" id="menuSignOut" type="button">Sign out</button>
      </div>`;
    menu.querySelector('#menuSignOut').addEventListener('click', ()=>{ phoneMenu(false); signOut(); });
    const mrp=menu.querySelector('#menuRefreshPeople');
    if(mrp) mrp.addEventListener('click', ()=>refreshRoles(mrp));
  } else if(state.authPending){
    // Gap between returning from Google and /me resolving — show progress.
    el.innerHTML = menu.innerHTML = `<span class="signingin"><span class="ndoc-spin"></span> Signing in…</span>`;
  } else {
    el.innerHTML = menu.innerHTML = '';   // signed out: the full-screen gate is the sign-in surface
  }
  updateGate();
}
async function refreshRoles(btn){
  btn.disabled=true; const prev=btn.textContent; btn.textContent='Refreshing…';
  try{ const j=await DB.refreshPeople(); toast(`Roles refreshed (${j.people} people)`,'ok'); loadPeople(); }
  catch(err){ toast(err.message||'Refresh failed','err'); }
  finally{ btn.disabled=false; btn.textContent=prev; acctMenu(false); }
}
// The app surface is members-only: a full-screen gate covers it until Firebase
// yields a signed-in identity (any verified account — roles still gate writes).
function updateGate(){
  const g=document.getElementById('authGate'); if(!g) return;
  const signedIn = !!(state.identity && state.identity.signedIn);
  g.hidden = signedIn;
  const busy = !state.authResolved || state.authPending;
  const card=document.getElementById('gateCard'), b=document.getElementById('gateBusy');
  if(card) card.hidden = busy;
  if(b) b.hidden = !busy;
}
const SUPPORT_EMAIL='eastsidetribenashville@gmail.com';
const LINK_SENDER='eastsidetribenashville@gmail.com';
function wireGate(){
  const gg=document.getElementById('gateGoogle');
  if(gg) gg.addEventListener('click', async ()=>{
    try{ await window.estAuth.signInWithGoogle(); }
    catch(err){ toast(/popup/i.test(String(err&&err.code||''))?'Pop-up blocked — allow pop-ups or use the email link':'Google sign-in didn’t work — try the email link','err'); }
  });
  const f=document.getElementById('gateEmailForm');
  if(f) f.addEventListener('submit', async e=>{
    e.preventDefault();
    const email=document.getElementById('gateEmailInput').value.trim(); if(!email) return;
    const btn=f.querySelector('button[type=submit]'); if(btn) btn.disabled=true;
    try{
      await window.estAuth.sendEmailLink(email);
      // persistent, spam-aware confirmation (mirrors gather)
      const sent=document.getElementById('gateSent'), form=document.getElementById('gateForm');
      sent.innerHTML=`<div class="signin-sent">
          <div class="sent-emoji">✉️</div><b>Check your email</b>
          <p>We sent a sign-in link to <b>${esc(email)}</b>. Open it on this device to finish.</p>
          <p class="sent-spam">Don’t see it within a minute? Check your <b>spam / junk</b> folder — it comes from <b>${esc(LINK_SENDER)}</b>.</p>
          <button type="button" class="btn ghost" id="gateAgain">Use a different email</button>
          <p class="contact-line">Still stuck? <a href="mailto:${SUPPORT_EMAIL}">Email us</a></p>
        </div>`;
      form.hidden=true; sent.hidden=false;
      document.getElementById('gateAgain').addEventListener('click', ()=>{ sent.hidden=true; form.hidden=false; if(btn) btn.disabled=false; });
    }
    catch(err){
      const quota=/quota/i.test(`${err&&err.code||''} ${err&&err.message||''}`);
      toast(quota?'Email links are temporarily at capacity — use “Continue with Google” instead.':'Could not send the link — check the address, or email us','err');
      if(btn) btn.disabled=false;
    }
  });
}
function acctMenu(open){
  const m=document.getElementById('acctMenu'), b=document.getElementById('avatarBtn'); if(!m||!b) return;
  const willOpen = open!==undefined ? open : m.hidden;
  m.hidden = !willOpen; b.setAttribute('aria-expanded', String(willOpen));
}

/* ---- calendar settings (⚙): the layer toggles, in a pop-over above phone width ---- */
function ovfMenu(open){
  const p=document.getElementById('ovfPanel'), b=document.getElementById('ovfBtn'); if(!p||!b) return;
  const willOpen = open!==undefined ? open : p.hidden;
  p.hidden=!willOpen; b.setAttribute('aria-expanded', String(willOpen));
}

/* ---- phone menu (☰ #menuBtn → #menuPanel): account, Help, Feedback, program year, layers ---- */
function phoneMenu(open){
  const p=document.getElementById('menuPanel'), b=document.getElementById('menuBtn');
  const willOpen = open!==undefined ? open : p.hidden;
  if(willOpen===!p.hidden) return;
  p.hidden=!willOpen; document.getElementById('menuScrim').hidden=!willOpen;
  b.setAttribute('aria-expanded', String(willOpen));
  document.body.classList.toggle('menu-open', willOpen);   // the page behind doesn't scroll
  if(willOpen) p.focus({ preventScroll:true });
}
function wirePhoneMenu(){
  const back=()=>{ phoneMenu(false); document.getElementById('menuBtn').focus({ preventScroll:true }); };
  document.getElementById('menuBtn').addEventListener('click', ()=>phoneMenu());
  document.getElementById('menuClose').addEventListener('click', back);
  document.getElementById('menuScrim').addEventListener('click', back);
  // Help and Feedback replace the menu (focus returns to ☰ when they close); year and layers keep it open
  document.getElementById('menuHelp').addEventListener('click', ()=>{ phoneMenu(false); openHelp('', document.getElementById('menuBtn')); });
  document.getElementById('menuFeedback').addEventListener('click', ()=>{ phoneMenu(false); openFeedback(); });
  document.querySelector('.menu-year').addEventListener('click', e=>{ const b=e.target.closest('[data-yr]'); if(b) navStep(Number(b.dataset.yr)); });
}
async function fetchMe(){
  if(!PROXY_BASE || !state.idToken){ state.identity=null; state.authPending=false; renderAuth(); return; }
  try{
    const r = await fetch(`${PROXY_BASE}/me`, { headers:{ 'Authorization':`Bearer ${state.idToken}` } });
    if(r.ok){ state.identity = await r.json(); }
    else { state.identity = null; if(r.status===401){ state.idToken=null; } } // token rejected -> drop it; Firebase re-yields on next refresh
  }catch(_){ state.identity=null; }               // transient network error: keep the token, try again later
  state.authPending=false;
  renderAuth(); applyView();
  refreshEditorRole();
  document.dispatchEvent(new CustomEvent('est:identity'));   // panels opened before sign-in resolved (deep links) re-fetch on this
}
// An editor opened before the role loaded (a ?event= deep link) was built read-only.
// When the role arrives and grants more than that editor was built with, rebuild it
// in place: openEditor first queues any edit in an open form (leaveForm), so nothing
// typed is lost. Losing a permission (sign-out, a /me blip) doesn't rebuild: the
// Worker refuses the writes, and a network blip mustn't yank the form mid-edit.
function refreshEditorRole(){
  if(!editing || !_ctx || _ctx.ev!==editing || !editing.id || _busy.has(editing.id)) return;
  if(!document.getElementById('modal').classList.contains('ws')) return;   // not the workspace (e.g. still loading)
  const now=editorCtx(editing).role, was=_ctx.role;
  if((now.canEdit && !was.canEdit) || (now.canApprove && !was.canApprove)) openEditor(editing, activeSection);
}
// Called by estAuth whenever Firebase yields a (refreshed) ID token.
async function onFirebaseToken(token){ state.idToken = token || null; state.authResolved = true; state.authPending = !!token; renderAuth(); await fetchMe(); }
function onFirebaseSignedOut(){ state.idToken=null; state.identity=null; state.authResolved=true; state.authPending=false; renderAuth(); applyView(); }
function sessionExpired(){ toast('Session expired — please sign in again','err'); onFirebaseSignedOut(); }
async function signOut(){ try{ await window.estAuth.signOut(); }catch(_){} }   // onFirebaseSignedOut clears state

function initAuth(){
  wireGate(); updateGate();
  const start = () => {
    window.estAuth.init({ onToken: onFirebaseToken, onSignedOut: onFirebaseSignedOut });
    window.estAuth.completeEmailLinkIfPresent().catch(()=>{ toast('That sign-in link didn’t work — it may have expired. Request a fresh one.','err'); });   // finish a magic-link return, if any
  };
  if(window.estAuth) start();
  else window.addEventListener('estauth:ready', start, { once:true });   // module may load after app.js
}

let _refreshing = false;
async function refresh(){
  if(_refreshing) return;                    // don't stack overlapping polls/clicks
  _refreshing = true;
  try { await loadEvents(); applyView(); layoutSticky(); } finally { _refreshing = false; }
}
async function init(){
  buildWeekHead(); renderLayers(); updateNavLabel(); initAuth();
  document.querySelectorAll('#viewSeg button').forEach(b=>b.setAttribute('aria-pressed', String(b.dataset.view===state.view)));   // the saved view
  { const hp=new URL(location.href).searchParams.get('help'); if(hp!==null) openHelp(hp); }   // ?help=<id> opens that guide (works signed out)
  document.getElementById('ovfBtn').addEventListener('click', e=>{ e.stopPropagation(); ovfMenu(); });
  wirePhoneMenu();
  layoutSticky();
  // Wire refresh/focus/poll up front so they work immediately (never dead while loading).
  const rb = document.getElementById('refreshBtn'); if(rb) rb.addEventListener('click', refresh);
  document.addEventListener('visibilitychange', () => { if(!document.hidden){ refresh(); } }); // refetch on tab focus
  setInterval(() => { if(!document.hidden){ refresh(); } }, 60000);    // light 60s poll while visible

  // Kick off ref loads — each hydrates its maps synchronously from cache, then
  // refreshes in the background. They are NOT awaited: the calendar paints without
  // them, events whose relations can't be mapped yet stay `_lossy` (mapRelations)
  // and re-map as each list lands (onRefsLoaded), and an editor opened meanwhile
  // waits for them (openEditor) — for at most 10s, then shows them read-only.
  const refLoads = [loadPrograms(), loadVenues(), loadPeople()];
  Promise.race([Promise.allSettled(refLoads), new Promise(r=>setTimeout(r, 10000))]).then(settleRefs);
  // Instant paint from the last cached events (maps are hydrated above).
  const cachedRows = cacheGet('rows-raw');
  const cachedRefs = cacheGet('references');
  if(cachedRefs && cachedRefs.layers){ rebuildRefs(cachedRefs.layers); renderLayers(); }
  if(cachedRows && cachedRows.length){ state.events = [...cachedRows.map(planningRowToEvent), ...((cachedRefs&&cachedRefs.events)||[])]; applyView(); layoutSticky(); }
  loadNews().then(paintHelpDot, ()=>{});   // What's new dot on the header ? — doesn't wait on the (slower) rows load
  // Fresh events (renders as soon as /rows returns).
  await refresh();
  openFromUrl();                 // deep-link: ?event=<id>&section=<id> opens that event
  setTimeout(()=>{
    const t=new Date();
    const v=curView();
    if(v==='overview'){ const el=document.querySelector(`.qcol[data-mk="${monthKey(t.getFullYear(),t.getMonth())}"]`); if(el) el.scrollIntoView({block:'center'}); }
    else if(v==='list'){ const el=document.querySelector('.lday.lnow'); if(el) el.scrollIntoView({block:'start'}); }   // scroll-margin clears the sticky header + month name
    else { const el=document.querySelector('.cell.today'); if(el) el.scrollIntoView({block:'center'}); }
  },60);
}

/* =========================================================================
   HELP — the Help drawer. Guides live in web/help/guide.md and What's new in
   web/help/whats-new.md; HelpLib (web/help/help-lib.js) parses + renders them.
   Entry points: the header ?, the editor/create-form ?, the status badge, the
   sign-in gate link, ?help=<id>, and a once-per-device Welcome. App code names
   a guide ONLY via openHelp('<id>'), help:'<id>' or data-help="<id>" — the
   forms scripts/check-help.mjs verifies. Design:
   docs/superpowers/specs/2026-09-29-in-app-help-design.md
   ========================================================================= */
const HELP_WELCOMED_KEY='est-help-welcomed';   // set once the Welcome has auto-opened on this device
const HELP_SEEN_KEY='est-help-seen';           // newest What's-new date this device has seen
const HELP_RETURNING=!!cacheGet('rows-raw');   // used the app before? (read before init() refreshes the row cache).
                                               // A first visit that signs in by emailed link counts as returning — /rows is cached while signed out — so that user just keeps the What's new dot.
const help={ guides:null, news:null, view:'index', id:'', query:'', opener:null };
let _helpP=null, _newsP=null;

// localStorage for help state: undefined = storage unavailable (so never nag), null = unset.
function helpGet(k){ try{ return localStorage.getItem(k); }catch(_){ return undefined; } }
function helpSet(k,v){ try{ localStorage.setItem(k,v); return true; }catch(_){ return false; } }

async function fetchHelpFile(name){
  const r=await fetch(`help/${name}`, { cache:'no-cache' });   // revalidate: a deploy shows up on the next page load
  if(!r.ok) throw new Error(`help/${name}: ${r.status}`);
  return r.text();
}
function loadNews(){
  if(!_newsP) _newsP=fetchHelpFile('whats-new.md')
    .then(md=>{ help.news=HelpLib.parseWhatsNew(md).entries; return help.news; })
    .catch(err=>{ _newsP=null; throw err; });
  return _newsP;
}
function loadHelp(){
  if(!_helpP) _helpP=Promise.all([fetchHelpFile('guide.md'), loadNews().catch(()=>null)])
    .then(([md])=>{ help.guides=HelpLib.parseGuide(md).guides; })
    .catch(err=>{ _helpP=null; throw err; });
  return _helpP;
}

function latestNews(){ return (help.news && help.news[0] && help.news[0].date) || ''; }
function newsUnseen(){ const latest=latestNews(), seen=helpGet(HELP_SEEN_KEY); return !!latest && seen!==undefined && (!seen || latest>seen); }
function markNewsSeen(){ const latest=latestNews(); if(latest) helpSet(HELP_SEEN_KEY, latest); paintHelpDot(); }
function paintHelpDot(){
  const b=document.getElementById('helpBtn'); if(!b) return;
  const unseen=newsUnseen();
  b.classList.toggle('has-news', unseen);
  b.setAttribute('aria-label', unseen ? 'Help (new updates)' : 'Help');
  const mb=document.getElementById('menuBtn');   // phones: the dot rides on ☰ and on the menu's Help
  mb.classList.toggle('has-news', unseen); mb.setAttribute('aria-label', unseen ? 'Menu (new in Help)' : 'Menu');
  document.querySelector('#menuHelp .help-dot').hidden=!unseen;
}

function setHelpUrl(id){
  const u=new URL(location.href);
  if(id) u.searchParams.set('help', id);
  else if(u.searchParams.has('help')) u.searchParams.delete('help');
  else return;
  history.replaceState(null,'',u);
}
// The header ? and the editor's aria-modal track the drawer (the editor stays usable beside it).
function setHelpExpanded(open){
  const b=document.getElementById('helpBtn'); if(b) b.setAttribute('aria-expanded', String(open));
  const m=document.getElementById('modal'); if(m) m.setAttribute('aria-modal', open ? 'false' : 'true');
}

// {{legend}} in guide.md: the calendar key, drawn with the calendar's own chip
// classes and the live program list — so it can't drift from what's on screen.
function legendEmbedHTML(){
  const progs=PROGRAMS.filter(p=>p.id!=='oth' && p.active!==false);
  const hue=cssColor(progs[0] && progs[0].color, 'var(--accent)');
  const row=(cls,label,note)=>`<div class="help-legend-row"><div class="chip ${cls}" style="--c:${hue}"><span class="t">${label}</span></div><span>${note}</span></div>`;
  const ref=REF_LAYERS[0];
  return `<div class="help-legend">
      ${row('draft','Draft','Being planned')}
      ${row('proposed','Proposed','Waiting for Tribal Council')}
      ${row('approved','Approved','Confirmed by Tribal Council')}
      ${row('cancelled','Cancelled','Not happening')}
      <div class="help-legend-row"><div class="chip ref" style="--c:${cssColor(ref && ref.color, 'var(--faint)')}"><span class="t">${esc(ref?ref.name:'Holiday')}</span></div><span>Reference calendar (read-only)</span></div>
    </div>
    <div class="help-swatches">${progs.map(p=>`<span><span class="help-swatch" style="background:${cssColor(p.color, 'var(--faint)')}"></span>${esc(p.name)}</span>`).join('')}</div>`;
}
function helpEmbed(name){ return name==='legend' ? legendEmbedHTML() : ''; }

function helpResultsHTML(){
  const q=help.query.trim();
  const item=g=>`<li><a href="#" data-help-link="${esc(g.id)}">${esc(g.title)}</a>${q?` <span class="help-grp">${esc(g.group)}</span>`:''}</li>`;
  if(q){
    const hits=HelpLib.searchGuides(help.guides, q);
    return hits.length ? `<ul class="help-list">${hits.map(item).join('')}</ul>`
      : `<p class="help-empty">No guides match — try other words, or <a href="mailto:${SUPPORT_EMAIL}">email us</a>.</p>`;
  }
  const groups=[...new Set(help.guides.map(g=>g.group))];
  return groups.map(gr=>`<div class="help-grouph">${esc(gr)}</div><ul class="help-list">${help.guides.filter(g=>g.group===gr).map(item).join('')}</ul>`).join('')
    + `<ul class="help-list help-news"><li><a href="#" data-help-link="whats-new">What's new</a>${newsUnseen()?'<span class="help-dot" title="New since your last look"></span>':''}</li></ul>`;
}

async function renderHelp(){
  const d=document.getElementById('helpDrawer'), body=document.getElementById('helpBody'), title=document.getElementById('helpTitle'), back=document.getElementById('helpBack');
  if(!help.guides){
    title.textContent='Help'; back.hidden=true;
    body.innerHTML=`<p class="help-empty"><span class="ndoc-spin"></span> Loading help…</p>`;
    try{ await loadHelp(); }
    catch(_){
      body.innerHTML=`<p class="help-empty">Help couldn't load. Check your connection and try again.</p><button type="button" class="btn sm" data-help-retry>Retry</button>`;
      return;
    }
    if(d.hidden) return;   // closed while loading: don't re-add ?help= or mark What's new seen
  }
  if(help.view==='guide' && help.id==='whats-new' && !help.news){   // What's new failed earlier: try again now
    title.textContent="What's new"; back.hidden=false;
    body.innerHTML=`<p class="help-empty"><span class="ndoc-spin"></span> Loading…</p>`;
    try{ await loadNews(); }
    catch(_){
      if(d.hidden || help.id!=='whats-new') return;   // closed, or the user moved on while it retried
      body.innerHTML=`<p class="help-empty">What's new couldn't load. Check your connection and try again.</p><button type="button" class="btn sm" data-help-retry>Retry</button>`;
      return;
    }
    if(d.hidden || help.id!=='whats-new') return;
  }
  const guide=(help.view==='guide' && help.id!=='whats-new') ? help.guides.find(g=>g.id===help.id) : null;
  if(help.view==='guide' && help.id==='whats-new'){
    title.textContent="What's new";
    body.innerHTML=`<article class="help-article">${HelpLib.renderWhatsNew(help.news)}</article>`;
    markNewsSeen();
  } else if(guide){
    title.textContent=guide.title;
    body.innerHTML=`<article class="help-article">${HelpLib.renderGuide(guide.body, { embed:helpEmbed })}</article>`;
  } else {                                       // the index — also the fallback for an unknown id
    help.view='index'; help.id='';
    title.textContent='Help';
    body.innerHTML=`<input class="help-search" id="helpSearch" type="search" placeholder="Search help" aria-label="Search help" value="${esc(help.query)}"><div id="helpResults">${helpResultsHTML()}</div>`;
  }
  back.hidden = help.view==='index';
  setHelpUrl(help.view==='index' ? '' : help.id);
  body.scrollTop=0;
}
function openHelp(id, opener){
  const d=document.getElementById('helpDrawer'); if(!d) return;
  if(d.hidden || opener) help.opener=opener||document.activeElement;   // an explicit opener (editor ?, status badge) takes over even when already open
  help.view=id?'guide':'index'; help.id=id||'';
  d.hidden=false; document.body.classList.add('help-open'); setHelpExpanded(true);
  layoutSticky();   // the header narrows (or widens), so its height can change
  renderHelp();
  d.focus({ preventScroll:true });
}
function closeHelp(){
  const d=document.getElementById('helpDrawer'); if(!d || d.hidden) return;
  const ae=document.activeElement, hadFocus=!ae || ae===document.body || d.contains(ae);
  d.hidden=true; document.body.classList.remove('help-open'); setHelpExpanded(false); setHelpUrl(''); hideTip();
  layoutSticky();
  let o=help.opener; help.opener=null;
  if(!hadFocus) return;                                                     // the user moved on (e.g. into the editor)
  const scrim=document.getElementById('scrim');
  if(scrim.classList.contains('open') && !(o && scrim.contains(o))) o=document.getElementById('mClose');   // the opener is behind the modal
  if(o && o.isConnected && o.getClientRects().length) o.focus({ preventScroll:true });                    // skip hidden openers
}
// Navigate inside the drawer and keep keyboard focus in it (the clicked link is re-rendered away).
function showHelp(view, id){ help.view=view; help.id=id; renderHelp(); document.getElementById('helpDrawer').focus({ preventScroll:true }); }

document.getElementById('helpClose').addEventListener('click', closeHelp);
document.getElementById('helpBack').addEventListener('click', ()=>showHelp('index',''));
document.getElementById('helpDrawer').addEventListener('click', e=>{
  const l=e.target.closest('[data-help-link]');
  if(l){ e.preventDefault(); showHelp('guide', l.dataset.helpLink); return; }
  if(e.target.closest('[data-help-retry]')) showHelp(help.view, help.id);
});
document.getElementById('helpBody').addEventListener('input', e=>{
  if(e.target.id!=='helpSearch') return;
  help.query=e.target.value;
  const r=document.getElementById('helpResults'); if(r) r.innerHTML=helpResultsHTML();
});
// Any [data-help="<id>"] opens that guide ("" = the index); the header ? toggles.
document.addEventListener('click', e=>{
  const t=e.target.closest('[data-help]'); if(!t) return;
  e.preventDefault();
  const d=document.getElementById('helpDrawer');
  if(t.id==='helpBtn' && d && !d.hidden){ closeHelp(); return; }
  openHelp(t.dataset.help, t);
});
// Esc peels the drawer first: the capture phase runs before the modal's Esc-to-close.
document.addEventListener('keydown', e=>{
  if(e.key!=='Escape') return;
  const d=document.getElementById('helpDrawer');
  if(d && !d.hidden){ e.preventDefault(); e.stopImmediatePropagation(); closeHelp(); }
}, true);
// Welcome: auto-opens once per device, the first time a signed-in identity resolves.
let _welcomeChecked=false;
function maybeWelcome(){
  if(_welcomeChecked || !(state.identity && state.identity.signedIn)) return;
  _welcomeChecked=true;   // first signed-in identity of this page load only — est:identity re-fires on every token refresh
  const p=new URL(location.href).searchParams;
  if(p.has('event') || p.has('help')){ if(!document.getElementById('helpDrawer').hidden) helpSet(HELP_WELCOMED_KEY,'1'); return; }   // arrived via a shared link — don't cover it (reading a guide already counts as welcomed)
  if(!document.getElementById('helpDrawer').hidden){ helpSet(HELP_WELCOMED_KEY,'1'); return; }   // already reading help (e.g. from the sign-in screen)
  if(document.getElementById('scrim').classList.contains('open')) return;   // something is already open
  if(helpGet(HELP_WELCOMED_KEY)!==null) return;                             // welcomed before, or storage unavailable
  if(!helpSet(HELP_WELCOMED_KEY,'1')) return;
  if(!HELP_RETURNING) loadNews().then(markNewsSeen, ()=>{});                // brand-new here: nothing is "new" to them
  openHelp('welcome');
}
document.addEventListener('est:identity', maybeWelcome);

init();
