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
