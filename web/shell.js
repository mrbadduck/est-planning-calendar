/* shell.js — the app shell: layer toggles, month/quarter click delegation, day picker, sticky offsets, view switch, nav, ⚙ and ☰ menus.
   Owns: renderLayers, layoutSticky, PHONE_MQ, curView, rerender, applyView, updateNavLabel, ovfMenu, phoneMenu, wirePhoneMenu
   Reads: state, prefs (state.js); REF_LAYERS (data.js)
   Writes: state, prefs (state.js); editing (editor-tabs.js; the day picker)
   Loaded after: editor-close.js (statement order: its listeners register before help.js's; the ⚙/☰ menu functions sit here though they came from the auth region) */

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
