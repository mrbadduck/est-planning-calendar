/* tab-attendees.js — the Attendees tab: the lead-only live roster (Eventbrite orders + gather claimants), copy/email actions.
   Owns: renderAttendees, wireAttendees, copyText
   Reads: state (state.js); DB (data.js)
   Writes: nothing
   Loaded after: tabs-listing-planning.js (file-map order; no load-time dependency) */

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
