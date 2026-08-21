/* =========================================================================
   DATA LAYER  —  the only part that changes when we go live on Coda.
   Everything below `DataSource` treats events in one normalized shape:
     { id, source, program, title, leads:[], date:'YYYY-MM-DD',
       start, end, allDay, location, status, description,
       createdBy, editedBy, readOnly, eventbriteUrl, gcalId }
   The single data source is CodaSource: it fetches Coda list-rows through the
   Worker proxy and maps them with planningRowToEvent / eventToCodaCells.
   ========================================================================= */

let PROGRAMS = [
  {id:'kab', name:'Kabbalat Shabbat',      color:'var(--p-kab)'},
  {id:'din', name:'Shabbat dinner',        color:'var(--p-din)'},
  {id:'tot', name:'East Side Tribelings',  color:'var(--p-tot)'}, // tot Shabbat
  {id:'lit', name:'Littles playdate',      color:'var(--p-lit)'},
  {id:'wan', name:'Wandering Scholars',    color:'var(--p-wan)'},
  {id:'lch', name:"L'chaim Time",          color:'var(--p-lch)'},
  {id:'sho', name:'Shoresh',               color:'var(--p-sho)'},
  {id:'oth', name:'Other / one-off',       color:'var(--p-oth)'},
];
let PROG = Object.fromEntries(PROGRAMS.map(p=>[p.id,p]));
const STATUSES = ['idea','draft','confirmed','approved'];
/* reference layers — muted context, read-only */
const REF_LAYERS = [
  {id:'us',   name:'US holidays',            color:'var(--r-us)',   on:true},
  {id:'jew',  name:'Jewish holidays',        color:'var(--r-jew)',  on:true},
  {id:'part', name:'Partner orgs (sample)',  color:'var(--r-part)', on:false},
  {id:'shab', name:'Shabbat',                color:'var(--r-shab)', on:false},
];
const REF = Object.fromEntries(REF_LAYERS.map(r=>[r.id,r]));

let progIdByName = Object.fromEntries(PROGRAMS.map(p=>[p.name,p.id]));
/* live programs: replace the built-in palette with the real EST Programs SRC set */
function genColor(i,n){ return `hsl(${Math.round(i*360/Math.max(n,1))}, 50%, 55%)`; }
function rebuildPrograms(list){
  PROGRAMS = list.concat([{id:'oth', name:'Other', color:'#888'}]);
  PROG = Object.fromEntries(PROGRAMS.map(p=>[p.id,p]));
  progIdByName = Object.fromEntries(PROGRAMS.map(p=>[p.name,p.id]));
}
// Safe palette lookups: on live data the program id may not be in the current
// PROG map (e.g. a new event's default, or an id from before the live palette
// loaded). Fall back to 'Other', then a literal, so rendering never throws.
function progColor(id){ return (PROG[id] || PROG.oth || {color:'var(--p-oth)'}).color; }

/* Reference data is slow to fetch (/ref/people is 1128 rows → many seconds) but
   changes rarely, so cache it in localStorage: hydrate synchronously on load for
   an instant paint, then refresh in the background. cacheGet is sync so callers
   can rely on the maps being populated immediately. */
function cacheGet(k){ try{ return JSON.parse(localStorage.getItem('est-cache-'+k) || 'null'); }catch(_){ return null; } }
function cacheSet(k,v){ try{ localStorage.setItem('est-cache-'+k, JSON.stringify(v)); }catch(_){} }

async function loadPrograms(){
  const c = cacheGet('programs'); if(c && c.length) rebuildPrograms(c);   // instant from cache
  if(!PROXY_BASE) return;
  try{
    const r = await fetch(`${PROXY_BASE}/ref/programs`);
    if(!r.ok) return;
    const items = (await r.json()).items || [];
    const list = items.filter(x=>x && x.name).map((x,i,a)=>({ id:x.id, name:x.name, active:!!(x.values && x.values['Active']===true), color:genColor(i,a.length), currentLeadNames:_asList((x.values&&x.values['Current Leads'])||[]) }));
    if(list.length){ rebuildPrograms(list); cacheSet('programs', list); }
  }catch(_){}
}

/* live people (Leads chip list + Volunteers typeahead) — /ref/people is a slim
   {id,name,lead} projection; `lead` = write-authorized leadership. */
let PEOPLE_LIST = [];     // all people {id,name,lead}
let LEADS_LIST = [];      // write-authorized subset (the Leads chip list)
let peopleById = {};      // id -> name
let peopleIdByName = {};  // name -> id (pre-select existing relations by name)
function rebuildPeople(list){
  PEOPLE_LIST = list;
  LEADS_LIST = list.filter(p=>p.lead);
  peopleById = Object.fromEntries(list.map(p=>[p.id,p.name]));
  peopleIdByName = Object.fromEntries(list.map(p=>[p.name,p.id]));
}
async function loadPeople(){
  const c = cacheGet('people'); if(c && c.length) rebuildPeople(c);       // instant from cache
  if(!PROXY_BASE) return;
  try{
    const r = await fetch(`${PROXY_BASE}/ref/people`); if(!r.ok) return;
    const items = ((await r.json()).items || []).map(x=>({ id:x.id, name:x.name, lead:!!x.lead }));
    if(items.length){ rebuildPeople(items); cacheSet('people', items); }
  }catch(_){}
}

/* live venues + venue types for the cascade (small tables — full rows) */
let VENUES = [];          // {id,name,type,closed}
let VENUE_TYPES = [];     // {id,name}
let venueIdByName = {}, venueTypeIdByName = {};
function setVenues(list){ VENUES=list; venueIdByName=Object.fromEntries(VENUES.map(v=>[v.name,v.id])); }
function setVenueTypes(list){ VENUE_TYPES=list; venueTypeIdByName=Object.fromEntries(VENUE_TYPES.map(t=>[t.name,t.id])); }
async function loadVenues(){
  const cv=cacheGet('venues'), ct=cacheGet('venue-types');               // instant from cache
  if(cv && cv.length) setVenues(cv);
  if(ct && ct.length) setVenueTypes(ct);
  if(!PROXY_BASE) return;
  try{
    const [rv, rt] = await Promise.all([ fetch(`${PROXY_BASE}/ref/venues`), fetch(`${PROXY_BASE}/ref/venue-types`) ]);
    if(rv && rv.ok){
      const items = (await rv.json()).items || [];
      const list = items.filter(x=>x && x.name).map(x=>({ id:x.id, name:x.name,
        type:(x.values && x.values['Venue Type']) || '', closed:!!(x.values && x.values['Closed/Unavailable?']===true) }));
      if(list.length){ setVenues(list); cacheSet('venues', list); }
    }
    if(rt && rt.ok){
      const items = (await rt.json()).items || [];
      const list = items.filter(x=>x && x.name).map(x=>({ id:x.id, name:x.name }));
      if(list.length){ setVenueTypes(list); cacheSet('venue-types', list); }
    }
  }catch(_){}
}

/* Multi-select typeahead (Leads, Volunteers) — maintains removable .ta-chip[data-id]
   nodes that readForm() collects. opts: {selected:[ids], pool:()=>[{id,name}]}.
   Exposes container.addPerson(id) for external appends (program → leads). */
function initTypeahead(container, opts){
  opts = opts || {};
  const input = container.querySelector('.ta-input');
  const menu  = container.querySelector('.ta-menu');
  const disabled = input.disabled;
  const pool = opts.pool || (() => PEOPLE_LIST);           // candidate list [{id,name}]
  const nameOf = id => peopleById[id] || id;
  let matches = [], active = -1;
  const has = id => [...container.querySelectorAll('.ta-chip')].some(c=>c.dataset.id===id);
  const addChip = (id, name) => {
    if(!id || has(id)) return;
    const chip = document.createElement('span');
    chip.className = 'ta-chip'; chip.dataset.id = id;
    chip.innerHTML = esc(name) + (disabled ? '' : ' <button type="button" aria-label="Remove" tabindex="-1">×</button>');
    if(!disabled) chip.querySelector('button').addEventListener('click', ()=>chip.remove());
    container.insertBefore(chip, input);
  };
  container.addPerson = id => addChip(id, nameOf(id));      // external append (program → leads)
  const closeMenu = () => { menu.hidden = true; active = -1; };
  const paint = () => [...menu.querySelectorAll('.ta-opt')].forEach((el,i)=>el.classList.toggle('active', i===active));
  const openMenu = q => {
    if(!q){ closeMenu(); return; }
    matches = pool().filter(p=>!has(p.id) && p.name.toLowerCase().includes(q)).slice(0,8);
    menu.innerHTML = matches.length
      ? matches.map((p,i)=>`<div class="ta-opt${i===0?' active':''}" data-id="${p.id}">${esc(p.name)}</div>`).join('')
      : '<div class="ta-empty">No match</div>';
    active = matches.length ? 0 : -1; menu.hidden = false;
  };
  const pick = p => { if(!p) return; addChip(p.id, p.name); input.value=''; closeMenu(); input.focus(); };
  (opts.selected || []).forEach(id => addChip(id, nameOf(id)));
  if(disabled) return;
  input.addEventListener('input', ()=>openMenu(input.value.trim().toLowerCase()));
  input.addEventListener('focus', ()=>{ const q=input.value.trim().toLowerCase(); if(q) openMenu(q); });
  input.addEventListener('blur', ()=>setTimeout(closeMenu, 150));
  input.addEventListener('keydown', e=>{
    if(menu.hidden) return;
    if(e.key==='ArrowDown'){ e.preventDefault(); active=Math.min(active+1, matches.length-1); paint(); }
    else if(e.key==='ArrowUp'){ e.preventDefault(); active=Math.max(active-1, 0); paint(); }
    else if(e.key==='Enter'){ e.preventDefault(); pick(matches[active]); }
    else if(e.key==='Escape'){ closeMenu(); }
  });
  menu.addEventListener('mousedown', e=>{ const o=e.target.closest('.ta-opt'); if(!o) return; e.preventDefault(); pick(pool().find(p=>p.id===o.dataset.id)); });
  container.addEventListener('click', e=>{ if(e.target===container) input.focus(); });
}

/* Single-select Venue picker: typeahead over venues (alphabetized, filtered by the
   Venue Type select, closed hidden). No match → "＋ New venue" which drops the text
   into other-mode (an editable field with a clear ✕ that returns to select mode).
   State lives on container.dataset.venueId / the visible other input. */
function initVenuePicker(container, ev){
  const input = container.querySelector('.ta-input');
  const menu  = container.querySelector('.ta-menu');
  const otherWrap = container.querySelector('.venue-other-wrap');
  const otherInput = container.querySelector('.venue-other');
  const disabled = input.disabled;
  const selTypeId = () => { const b=document.querySelector('#f_vtype_seg button[aria-pressed="true"]'); return b?b.dataset.vtype:''; };
  const typeName = () => (VENUE_TYPES.find(x=>x.id===selTypeId())||{}).name;
  const pool = () => { const tn=typeName(); return VENUES.filter(v=>!v.closed && (!tn || v.type===tn)).slice().sort((a,b)=>a.name.localeCompare(b.name)); };
  let active = -1;
  const clearPill = () => [...container.querySelectorAll('.ta-chip')].forEach(c=>c.remove());
  function showSelect(){ container.dataset.venueId=''; clearPill(); otherWrap.hidden=true; otherInput.value=''; input.hidden=false; input.value=''; menu.hidden=true; if(!disabled) input.focus(); }
  function selectVenue(v){
    container.dataset.venueId=v.id; clearPill(); otherWrap.hidden=true; input.hidden=true; menu.hidden=true;
    const tid=venueTypeIdByName[v.type], seg=document.getElementById('f_vtype_seg');   // sync the type switcher to the venue
    if(seg && tid) [...seg.children].forEach(b=>b.setAttribute('aria-pressed', String(b.dataset.vtype===tid)));
    const chip=document.createElement('span'); chip.className='ta-chip venue-pick';
    chip.innerHTML=esc(v.name)+(disabled?'':' <button type="button" aria-label="Clear" tabindex="-1">×</button>');
    if(!disabled) chip.querySelector('button').addEventListener('click', showSelect);
    container.insertBefore(chip, input);
  }
  function enterOther(text){ container.dataset.venueId=''; clearPill(); input.hidden=true; menu.hidden=true; otherWrap.hidden=false; otherInput.value=text; if(!disabled) otherInput.focus(); }
  const closeMenu=()=>{ menu.hidden=true; active=-1; };
  const paint=()=>[...menu.querySelectorAll('.ta-opt')].forEach((el,i)=>el.classList.toggle('active', i===active));
  function openMenu(q){
    if(!q){ closeMenu(); return; }
    const ms = pool().filter(v=>v.name.toLowerCase().includes(q)).slice(0,8);
    let html = ms.map((v,i)=>`<div class="ta-opt${i===0?' active':''}" data-id="${v.id}">${esc(v.name)}</div>`).join('');
    html += `<div class="ta-opt ta-new${ms.length?'':' active'}" data-new="1">＋ New venue: "${esc(input.value.trim())}"</div>`;
    menu.innerHTML=html; active = 0; menu.hidden=false; paint();
  }
  // initial state
  if(ev.venue && VENUES.some(v=>v.id===ev.venue)) selectVenue(VENUES.find(v=>v.id===ev.venue));
  else if(ev.venueOther) enterOther(ev.venueOther);
  else showSelect();
  if(disabled){ if(!container.dataset.venueId && otherWrap.hidden){ /* empty: leave disabled input */ } return; }
  if(otherInput) container.querySelector('.venue-clear').addEventListener('click', showSelect);
  input.addEventListener('input', ()=>openMenu(input.value.trim().toLowerCase()));
  input.addEventListener('focus', ()=>{ const q=input.value.trim().toLowerCase(); if(q) openMenu(q); });
  input.addEventListener('blur', ()=>setTimeout(closeMenu, 150));
  input.addEventListener('keydown', e=>{
    if(menu.hidden) return;
    const opts=[...menu.querySelectorAll('.ta-opt')];
    if(e.key==='ArrowDown'){ e.preventDefault(); active=Math.min(active+1, opts.length-1); paint(); }
    else if(e.key==='ArrowUp'){ e.preventDefault(); active=Math.max(active-1, 0); paint(); }
    else if(e.key==='Enter'){ e.preventDefault(); if(opts[active]) opts[active].dispatchEvent(new MouseEvent('mousedown',{bubbles:true})); }
    else if(e.key==='Escape'){ closeMenu(); }
  });
  menu.addEventListener('mousedown', e=>{ const o=e.target.closest('.ta-opt'); if(!o) return; e.preventDefault();
    if(o.dataset.new){ enterOther(input.value.trim()); } else { const v=VENUES.find(x=>x.id===o.dataset.id); if(v) selectVenue(v); }
  });
}
/* Write cells for EST Planning Events SRC. Relations (Program(s)/Leads/Volunteers/
   Venue/Venue Type) are written as target-table row ids; single lookups take a
   one-id array (or [] to clear). Attribution is injected by the Worker. Month
   scheduling stores Date=1st. */
function eventToCodaCells(e){
  const sched = (e.scheduling||'exact').toLowerCase();
  const dateVal = sched==='month' ? (e.targetMonth ? `${e.targetMonth}-01` : '')
                : sched==='exact' ? (e.date||'') : '';
  return [
    {column:'Title',           value:e.title||''},
    {column:'Program(s)',      value:(e.programs||[]).filter(id=>id&&id!=='oth')},
    {column:'Leads',           value:(e.leads||[]).filter(Boolean)},
    {column:'Volunteers',      value:(e.volunteers||[]).filter(Boolean)},
    {column:'Status',          value:cap(e.status||'idea')},
    {column:'Scheduling',      value:cap(sched)},
    {column:'Date',            value:dateVal},
    {column:'Start',           value:e.start||''},
    {column:'End',             value:e.end||''},
    {column:'All day',         value:!!e.allDay},
    {column:'Venue Type',      value:e.venueType ? [e.venueType] : []},
    {column:'Venue',           value:e.venue ? [e.venue] : []},
    {column:'Venue (other)',   value:e.venueOther||''},
    {column:'Event Description',value:e.description||''},
    {column:'Window start',    value:e.rangeStart||''},
    {column:'Window end',      value:e.rangeEnd||''},
  ];
}

/* ---- reference events (mock; live = Hebcal + Coda-synced gcals) ---- */
function refEv(layer,title,date){ return {id:layer+'-'+date+'-'+title.slice(0,4),source:'ref',refLayer:layer,program:'oth',title,date,allDay:true,readOnly:true,status:'ref',leads:[]}; }
const MOCK_REFS = [
  // US federal (accurate)
  refEv('us','Labor Day','2026-09-07'), refEv('us','Indigenous Peoples’ Day','2026-10-12'),
  refEv('us','Veterans Day','2026-11-11'), refEv('us','Thanksgiving','2026-11-26'),
  refEv('us','Christmas','2026-12-25'), refEv('us','New Year’s Day','2027-01-01'),
  refEv('us','MLK Day','2027-01-18'), refEv('us','Presidents’ Day','2027-02-15'),
  refEv('us','Memorial Day','2027-05-31'), refEv('us','Juneteenth','2027-06-19'),
  refEv('us','Independence Day','2027-07-04'),
  // Jewish (fall accurate for 5787; spring = sample)
  refEv('jew','Erev Rosh Hashanah','2026-09-11'), refEv('jew','Rosh Hashanah','2026-09-12'),
  refEv('jew','Yom Kippur','2026-09-21'), refEv('jew','Sukkot begins','2026-09-26'),
  refEv('jew','Simchat Torah','2026-10-04'), refEv('jew','Hanukkah (1st candle)','2026-12-04'),
  refEv('jew','Tu BiShvat','2027-01-23'), refEv('jew','Purim (sample)','2027-03-23'),
  refEv('jew','Passover I (sample)','2027-04-22'), refEv('jew','Shavuot (sample)','2027-06-01'),
  // partner (sample)
  refEv('part','Partner: Interfaith potluck','2026-10-25'),
  refEv('part','Partner: JCC family day','2026-11-22'),
  refEv('part','Partner: MLK service','2027-01-18'),
];

/* ---- CodaSource (live, via the proxy) — the only data source ------------
   READS `EST Planning Events SRC` through the Worker proxy and maps its columns
   to our normalized event shape (see planningRowToEvent). The proxy holds the
   doc-scoped token server-side and gates writes on Google sign-in + role.
   References (holidays/partners) stay on the built-in overlays until Hebcal
   wiring (later). */
const PROXY_BASE = 'https://est-planning-proxy.eastsidetribe.workers.dev';
                         // ← deployed Worker. CORS allows the deploy origin plus
                         //   http://localhost:8080 for local dev (see wrangler.toml).

/* EST Planning Events SRC row (Coda simpleWithArrays + useColumnNames) -> event.
   Relation cells (Program(s)/Leads/Venue/…by) arrive as arrays of display strings;
   Date/Window come back as ISO datetimes (slice to YYYY-MM-DD); Start/End are a
   native time column, serialized as a 1899-placeholder ISO (see _toHM); Month
   scheduling lives in Date=1st -> targetMonth. Read-only until Plan 2b. */
const _nameOf = x => typeof x === 'string' ? x : (x && x.name) || '';
const _asList = v => (v == null || v === '') ? [] : (Array.isArray(v) ? v : [v]).map(_nameOf).filter(Boolean);
const _toHM = s => { const m = String(s || '').match(/(?:T|^)(\d{2}:\d{2})/); return m ? m[1] : ''; };
// Relation cells arrive as display-name strings; map them back to target-table
// row ids via the loaded reference lists (same pattern as Program(s)). Requires
// loadPeople/loadVenues to have run before loadEvents (init() awaits both).
const _idsOf = (v, byName) => _asList(v).map(n => byName[n]).filter(Boolean);
function planningRowToEvent(r){
  const v = r.values || {};
  const progs = _asList(v['Program(s)']);               // all programs (names)
  const venueName = _asList(v['Venue'])[0] || '';
  const venueOther = v['Venue (other)'] || '';
  const sched = String(v['Scheduling'] || 'Exact').toLowerCase();
  const rawDate = String(v['Date'] || '').slice(0,10);
  return {
    id: r.id, source:'planning',
    program: progIdByName[progs[0]] || 'oth',           // primary program drives the color
    programs: progs.map(p => progIdByName[p] || 'oth'),  // full list (crossover UI: Plan 2b)
    title: v['Title'] || '',
    leads: _idsOf(v['Leads'], peopleIdByName),           // person row ids
    volunteers: _idsOf(v['Volunteers'], peopleIdByName), // person row ids
    leadNames: _asList(v['Leads']), volunteerNames: _asList(v['Volunteers']), // raw names — editor fallback if people not loaded yet
    date: sched === 'month' ? '' : rawDate,              // Month renders as an undated month idea
    start: _toHM(v['Start']), end: _toHM(v['End']), allDay: !!v['All day'],
    venueType: venueTypeIdByName[_asList(v['Venue Type'])[0]] || '',
    venue: venueIdByName[venueName] || '',
    venueOther,
    location: venueName || venueOther,                   // display fallback
    status: String(v['Status'] || 'idea').toLowerCase(),
    description: v['Event Description'] || '',
    planningNotes: v['Planning Notes'] || '',
    // proxy injects notesDocUrl resolved by the stable column id (rename-proof);
    // Notes Doc is a Coda link column, so the value may be a string or {url,name}.
    notesDocUrl: (typeof r.notesDocUrl === 'string' ? r.notesDocUrl : (r.notesDocUrl && (r.notesDocUrl.url || r.notesDocUrl.name))) || '',
    createdBy: _asList(v['Created by'])[0] || '', editedBy: _asList(v['Edited by'])[0] || '',
    eventbriteUrl:'', gcalId:'', readOnly:true,          // writes come in Plan 2b
    scheduling: sched,
    rangeStart: String(v['Window start'] || '').slice(0,10),
    rangeEnd: String(v['Window end'] || '').slice(0,10),
    targetMonth: sched === 'month' ? rawDate.slice(0,7) : ''
  };
}
const READONLY_MSG = 'This calendar is read-only in Phase 1 — editing goes live in Phase 2 (Google sign-in + lead allowlist).';
const CodaSource = {
  base: PROXY_BASE,
  async listPlanning(){
    const r = await fetch(`${this.base}/rows`, { headers:{ 'Accept':'application/json' } });
    if(!r.ok) throw new Error(`proxy ${r.status}: ${await r.text()}`);
    const j = await r.json();
    const items = j.items || [];
    cacheSet('rows-raw', items);                       // instant repaint on next reload
    return items.map(planningRowToEvent);
  },
  async listReferences(){ return MOCK_REFS.slice(); },
  _wh(){ return { 'Content-Type':'application/json', 'Authorization':`Bearer ${state.idToken||''}` }; },
  async _fail(r){ let t=await r.text(); try{ t=JSON.parse(t).error||t; }catch(_){} const e=new Error(`save failed (${r.status})${t?': '+t:''}`); e.status=r.status; throw e; },
  async create(e){ const r=await fetch(`${this.base}/rows`,{method:'POST',headers:this._wh(),body:JSON.stringify({rows:[{cells:eventToCodaCells(e)}]})}); if(!r.ok) await this._fail(r); try{ const j=await r.json(); const id=j&&j.addedRowIds&&j.addedRowIds[0]; if(id) e.id=id; }catch(_){} return e; },
  async update(e){ const r=await fetch(`${this.base}/rows/${encodeURIComponent(e.id)}`,{method:'PUT',headers:this._wh(),body:JSON.stringify({row:{cells:eventToCodaCells(e)}})}); if(!r.ok) await this._fail(r); return e; },
  async remove(id){ const r=await fetch(`${this.base}/rows/${encodeURIComponent(id)}`,{method:'DELETE',headers:this._wh()}); if(!r.ok) await this._fail(r); },
  async createNotesDoc(rowId){ const r=await fetch(`${this.base}/notes-doc`,{method:'POST',headers:this._wh(),body:JSON.stringify({rowId})}); if(!r.ok) await this._fail(r); return true; },
};

// The live proxy is the only data source. Reads are unauthenticated (CORS-gated,
// localhost allowed); writes require Google sign-in + role. Runs the same locally
// and deployed. See docs/deployment.md → "Local development".
const DB = CodaSource;

/* =========================================================================
   STATE + RENDER
   ========================================================================= */
const state = {
  startYear: 2026,           // program year = Sep(startYear) .. Aug(startYear+1)
  view: 'overview',          // 'overview' (default) | 'year' (Calendar)
  role: 'vp',                // legacy; superseded by identity from /me
  currentUser: 'Eric',
  idToken: null,
  identity: null,            // { signedIn, matched, name, canWrite, canApprove }
  layers: { planning:true, us:true, jew:true, part:false, shab:false },
  events: [],
};

const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const WD = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
const pad=n=>String(n).padStart(2,'0');
const ymd=(y,m,d)=>`${y}-${pad(m+1)}-${pad(d)}`;
const todayStr=(()=>{const t=new Date();return ymd(t.getFullYear(),t.getMonth(),t.getDate());})();

// Recently-saved planning events, kept for a few seconds so a re-fetch that hits
// Coda *before* it has indexed the write can't revert an optimistic change.
// Map id -> { e (optimistic event) | deleted:true, until }.
const _recent = new Map();
function markRecent(id, rec){ _recent.set(id, Object.assign({ until: Date.now() + 8000 }, rec)); }
async function loadEvents(){
  const [p,r] = await Promise.all([DB.listPlanning(), DB.listReferences()]);
  let planning = p;
  if(_recent.size){
    const now = Date.now();
    for(const [id,rec] of [..._recent]) if(rec.until <= now) _recent.delete(id);
    planning = p.filter(ev => { const rec=_recent.get(ev.id); return !(rec && rec.deleted); })   // hide just-deleted
                .map(ev => { const rec=_recent.get(ev.id); return (rec && rec.e) ? rec.e : ev; }); // keep just-edited
    for(const [id,rec] of _recent) if(rec.e && !p.some(x=>x.id===id)) planning.push(rec.e);        // keep just-created
  }
  state.events = [...planning, ...r];
}

function eventsByDate(){
  const map={};
  for(const e of state.events){
    if(e.source==='planning'){ if(!state.layers.planning) continue; if(isRough(e)||!e.date) continue; }
    else { if(!state.layers[e.refLayer]) continue; }
    (map[e.date]=map[e.date]||[]).push(e);
  }
  return map;
}

/* ---- rough / undated scheduling helpers ---- */
function monthKey(y,m){ return `${y}-${pad(m+1)}`; }
function isRough(e){ return e.source==='planning' && e.scheduling && e.scheduling!=='exact'; }
function roughMonthKey(e){
  if(e.scheduling==='month') return e.targetMonth||'';
  if(e.scheduling==='range' && e.rangeStart && e.rangeEnd){
    const a=new Date(e.rangeStart), b=new Date(e.rangeEnd), mid=new Date((a.getTime()+b.getTime())/2);
    return monthKey(mid.getFullYear(), mid.getMonth());
  }
  return e.rangeStart ? e.rangeStart.slice(0,7) : '';
}
function roughByMonth(){
  const m={};
  if(!state.layers.planning) return m;
  for(const e of state.events){ if(!isRough(e)) continue; const k=roughMonthKey(e); if(!k) continue; (m[k]=m[k]||[]).push(e); }
  return m;
}
function isWeekend(dow){ return dow===5 || dow===6 || dow===0; } // Fri–Sun

/* program-year list of {y,m} from Sep..Aug */
function monthsOfYear(){
  const out=[];
  for(let i=0;i<12;i++){ const m=(8+i)%12; const y=state.startYear + (8+i>=12?1:0); out.push({y,m}); }
  return out;
}

function buildWeekHead(){
  const wh=document.getElementById('weekhead');
  wh.innerHTML='<div class="corner">Ideas</div>'+WD.map((d,i)=>`<div class="wd ${i===0||i===6?'we':''}">${d}</div>`).join('');
}

function progNames(e){ return (e.programs&&e.programs.length?e.programs:[e.program]).map(id=>(PROG[id]||{}).name).filter(Boolean); }
function xMark(e){ return (e.programs&&e.programs.length>1) ? ` <span style="font-size:9px;font-weight:700;opacity:.65" title="${esc(progNames(e).join(' + '))}">+${e.programs.length-1}</span>` : ''; }
function chipHTML(e){
  if(e.source==='ref'){
    const c=REF[e.refLayer].color;
    return `<div class="chip ref" style="--c:${c}" data-id="${e.id}" data-ref="1" title="${esc(e.title)}"><span class="t">${esc(e.title)}</span></div>`;
  }
  const c=progColor(e.program);
  const t = (!e.allDay && e.start) ? `<span class="time">${e.start}</span>` : '';
  const lock = e.status==='approved' ? '<span class="lock">🔒</span>' : '';
  return `<div class="chip ${e.status}" style="--c:${c}" data-id="${e.id}" title="${esc(e.title)} — ${cap(e.status)}">${t}<span class="t">${esc(e.title)}</span>${xMark(e)}${lock}</div>`;
}

function weekRowOf(startWd, day){ return Math.floor((startWd + day - 1) / 7); }
function anchorRow(e, mk, startWd){
  // whole-month idea -> top row (just under header); range -> week of its start day (if in month)
  if(e.scheduling==='range' && e.rangeStart && e.rangeStart.slice(0,7)===mk){
    return weekRowOf(startWd, Number(e.rangeStart.slice(8,10)));
  }
  return 0;
}
function gchipHTML(e, mk){
  const c=progColor(e.program);
  let tag='month';
  if(e.scheduling==='range'){
    const s=e.rangeStart, en=e.rangeEnd;
    const sd = s ? Number(s.slice(8,10)) : '';
    const ed = (en && en.slice(0,7)===mk) ? Number(en.slice(8,10)) : (en?Number(en.slice(8,10)):'');
    tag = ed ? `${sd}–${ed}` : `${sd}+`;
  }
  return `<div class="gchip ${e.status}" style="--c:${c}" data-id="${e.id}" title="${esc(e.title)} — ${cap(e.status)} · date TBD"><span class="gt">${esc(e.title)}</span>${xMark(e)}<span class="gr">${tag}</span></div>`;
}

function renderMonths(){
  const wrap=document.getElementById('months');
  const byDate=eventsByDate();
  const roughMap=roughByMonth();
  const shabOn=state.layers.shab;
  let html='';
  for(const {y,m} of monthsOfYear()){
    const mk=monthKey(y,m);
    const startWd=new Date(y,m,1).getDay();
    const daysIn=new Date(y,m+1,0).getDate();
    const prevDays=new Date(y,m,0).getDate();
    const rows=Math.ceil((startWd+daysIn)/7);
    // anchor each rough idea to the week row its rough timeframe starts in
    const byWeek={};
    for(const e of (roughMap[mk]||[])){ const r=Math.min(anchorRow(e,mk,startWd), rows-1); (byWeek[r]=byWeek[r]||[]).push(e); }

    let body='';
    for(let w=0; w<rows; w++){
      const ideas=(byWeek[w]||[]);
      const ghint = w===0 ? `<span class="ghint">date TBD</span>` : '';
      body += `<div class="gcell" data-newidea="${mk}">${ghint}<span class="gadd">＋</span>${ideas.map(e=>gchipHTML(e,mk)).join('')}</div>`;
      for(let k=0;k<7;k++){
        const dayNum=w*7+k-startWd+1;
        let cy=y,cm=m,dn=dayNum,other=false;
        if(dayNum<1){ other=true; cm=m-1; cy=m===0?y-1:y; dn=prevDays+dayNum; if(cm<0){cm=11;} }
        else if(dayNum>daysIn){ other=true; cm=m+1; cy=m===11?y+1:y; dn=dayNum-daysIn; if(cm>11){cm=0;} }
        const ds=ymd(cy,cm,dn);
        const isToday=ds===todayStr;
        const evs=(byDate[ds]||[]).slice().sort(sortEv);
        const shabMark=(shabOn && k===5 && !other) ? `<div class="chip ref" style="--c:var(--r-shab)" data-noop="1"><span class="t">Shabbat</span></div>` : '';
        body += `<div class="cell ${other?'other':''} ${k===0||k===6?'we':''} ${isToday?'today':''}" data-date="${ds}" ${other?'data-other="1"':''}>
          <span class="add-hint">+</span>
          <span class="dnum">${dn}</span>
          <div class="chips">${shabMark}${evs.map(chipHTML).join('')}</div>
        </div>`;
      }
    }
    html+=`<div class="month">
      <div class="myear-head">${MONTHS[m]}<span class="yy">${y}</span></div>
      <div class="mgrid">${body}</div>
    </div>`;
  }
  wrap.innerHTML=html;
}

/* =========================================================================
   OVERVIEW (ZOOMED-OUT) VIEW — whole year, months as cards (3 per row),
   weeks as rows bucketed weeknight (Mon–Thu) | weekend (Fri–Sun);
   undated ideas sit in a card footer
   ========================================================================= */
function qchipHTML(e){
  if(e.source==='ref') return `<div class="qchip ref" style="--c:${REF[e.refLayer].color}" data-id="${e.id}" title="${esc(e.title)}">${esc(e.title)}</div>`;
  const c=progColor(e.program);
  return `<div class="qchip ${e.status}" style="--c:${c}" data-id="${e.id}" title="${esc(e.title)} — ${cap(e.status)}">${esc(e.title)}${xMark(e)}</div>`;
}
function weekAddDate(y,m,dayNums,zone){
  const want = zone==='wknd' ? d=>isWeekend(new Date(y,m,d).getDay()) : d=>!isWeekend(new Date(y,m,d).getDay());
  const hit=dayNums.find(want); return ymd(y,m,hit||dayNums[0]);
}
function renderOverview(){
  const cont=document.getElementById('quarter');
  const byDate=eventsByDate();
  const roughMap=roughByMonth();
  const cmp=(a,b)=>(a.date||'').localeCompare(b.date||'') || (a.source===b.source?0:(a.source==='planning'?-1:1)) || ((a.start||'').localeCompare(b.start||''));
  let cols='';
  for(const {y,m} of monthsOfYear()){
    const mk=monthKey(y,m);
    const first=new Date(y,m,1), startWd=first.getDay(), daysIn=new Date(y,m+1,0).getDate();
    let weeks='';
    const rows=Math.ceil((startWd+daysIn)/7);
    for(let w=0; w<rows; w++){
      const dayNums=[];
      for(let k=0;k<7;k++){ const dn=w*7+k-startWd+1; if(dn>=1&&dn<=daysIn) dayNums.push(dn); }
      if(!dayNums.length) continue;
      const wkn=[], wknd=[];
      for(const dn of dayNums){
        const ds=ymd(y,m,dn), dow=new Date(y,m,dn).getDay();
        for(const e of (byDate[ds]||[])){ (isWeekend(dow)?wknd:wkn).push(e); }
      }
      wkn.sort(cmp); wknd.sort(cmp);
      const lbl = dayNums[0]===dayNums[dayNums.length-1] ? `${dayNums[0]}` : `${dayNums[0]}–${dayNums[dayNums.length-1]}`;
      weeks += `<div class="qweek">
        <div class="qwk">${lbl}</div>
        <div class="qzone wkn" data-add="${weekAddDate(y,m,dayNums,'wkn')}">${wkn.map(qchipHTML).join('')||'<span class="zlbl">·</span>'}</div>
        <div class="qzone wknd" data-add="${weekAddDate(y,m,dayNums,'wknd')}">${wknd.map(qchipHTML).join('')||'<span class="zlbl">·</span>'}</div>
      </div>`;
    }
    const rough=(roughMap[mk]||[]);
    const ftr = rough.length ? `<div class="qtbd"><span class="lbl">date TBD</span>${rough.map(e=>{
      const r = e.scheduling==='range' ? ` <span style="opacity:.6;font-size:9px">(${e.rangeStart.slice(8,10)}–${e.rangeEnd.slice(8,10)})</span>` : '';
      return `<div class="qchip ${e.status}" style="--c:${(PROG[e.program]||{}).color}" data-id="${e.id}" title="${esc(e.title)}">${esc(e.title)}${xMark(e)}${r}</div>`;
    }).join('')}</div>` : '';
    cols += `<div class="qcol" data-mk="${mk}"><div class="qhead"><span>${MONTHS[m]}</span><span class="qy">${y}</span></div><div>${weeks}</div>${ftr}</div>`;
  }
  cont.innerHTML=`<div class="qgrid">${cols}</div>
    <div class="legend" style="margin-top:14px"><span class="k" style="color:var(--faint)">Each week splits into <b style="color:var(--muted)">weeknight</b> (Mon–Thu) and <b style="color:var(--muted)">weekend</b> (Fri–Sun). Undated ideas sit in each month's footer. Click a lane to add.</span></div>`;
}

function sortEv(a,b){
  if(a.source!==b.source) return a.source==='planning'?-1:1;      // plans above refs
  const at=a.allDay?'':(a.start||''), bt=b.allDay?'':(b.start||'');
  return at.localeCompare(bt);
}

function renderLayers(){
  const box=document.getElementById('layers');
  // remove any previously injected ref toggles
  box.querySelectorAll('[data-ref-toggle]').forEach(n=>n.remove());
  for(const r of REF_LAYERS){
    const on=state.layers[r.id];
    const el=document.createElement('label');
    el.className='lyr'; el.dataset.on=on; el.dataset.refToggle='1'; el.dataset.layer=r.id;
    el.innerHTML=`<span class="swatch-ref" style="background:${r.color}"></span><span class="name">${r.name}</span>`;
    box.appendChild(el);
  }
}

function legendHTML(){
  return `
    <div class="fld full"><label>Status</label>
      <div class="infogrid">
        <span class="k"><span class="sw i"></span>Idea</span>
        <span class="k"><span class="sw d"></span>Draft</span>
        <span class="k"><span class="sw c"></span>Confirmed</span>
        <span class="k"><span class="sw a"></span>Approved 🔒</span>
      </div>
      <div style="font-size:11px;color:var(--muted);margin-top:5px">Dashed = tentative · solid = locked in · filled = approved.</div>
    </div>
    <div class="fld full"><label>Programs</label>
      <div class="infogrid">
        ${PROGRAMS.filter(p=>p.id!=='oth').map(p=>`<span class="k"><span class="sw" style="background:${p.color}"></span>${p.name}</span>`).join('')}
      </div>
    </div>
    <div class="fld full"><label>Undated ideas</label>
      <div style="font-size:11.5px;color:var(--muted)">Ideas without a firm day sit in the left gutter (Calendar) or the month footer (Overview), anchored to their rough week or month.</div>
    </div>
    <div class="fld full" style="border-top:1px dashed var(--hair);padding-top:10px">
      <div style="font-size:11px;color:var(--faint)"><b style="color:var(--muted)">Mock preview.</b> Edits are in-memory and reset on reload; programs &amp; leads are real, holidays illustrative. The live version reads planning rows from the Coda <b>Mission Control</b> table and pulls holidays from Hebcal.</div>
    </div>`;
}
function openInfo(){
  editing={id:'__info__'};
  document.getElementById('mStripe').style.setProperty('--c','var(--accent)');
  document.getElementById('mTitle').textContent='Legend & key';
  document.getElementById('mActions').innerHTML='';
  document.getElementById('mBody').innerHTML=legendHTML();
  document.getElementById('mFoot').innerHTML=`<span class="push"></span><button class="btn" data-act="close">Close</button>`;
  show();
}

/* =========================================================================
   MODAL
   ========================================================================= */
let editing=null; // event being edited, or null
let whenType='exact';

// Times only exist for an Exact date that isn't All-day. Range/Month are all-day.
function whenFieldsHTML(type,ev,dis){
  if(type==='range') return `<div class="timerow">
      <div class="fld"><label>Window start</label><input id="f_rstart" type="date" value="${ev.rangeStart||ev.date||''}" ${dis}></div>
      <div class="fld"><label>Window end</label><input id="f_rend" type="date" value="${ev.rangeEnd||''}" ${dis}></div>
    </div>
    <div class="whenhint">All-day range — floats in the gutter until it gets a firm day.</div>`;
  if(type==='month') return `<div class="fld"><label>Target month</label><input id="f_month" type="month" value="${ev.targetMonth||(ev.date?ev.date.slice(0,7):'')}" ${dis}></div>
    <div class="whenhint">Whole-month idea — shows in the gutter.</div>`;
  const allDay = !!ev.allDay;
  return `<div class="daterow">
      <div class="fld"><label>Date</label><input id="f_date" type="date" value="${ev.date||''}" ${dis}></div>
      <label class="allday-inline"><input id="f_allday" type="checkbox" ${allDay?'checked':''} ${dis}> All day</label>
    </div>` +
    (allDay ? '' : `<div class="timerow">
      <div class="fld"><label>Start time</label><input id="f_start" type="time" value="${ev.start||''}" ${dis}></div>
      <div class="fld"><label>End time</label><input id="f_end" type="time" value="${ev.end||''}" ${dis}></div>
    </div>`);
}
function collectWhen(){
  const g=id=>document.getElementById(id), o={};
  if(g('f_date')) o.date=g('f_date').value;
  if(g('f_rstart')) o.rangeStart=g('f_rstart').value;
  if(g('f_rend')) o.rangeEnd=g('f_rend').value;
  if(g('f_month')) o.targetMonth=g('f_month').value;
  if(g('f_start')) o.start=g('f_start').value;
  if(g('f_end')) o.end=g('f_end').value;
  if(g('f_allday')) o.allDay=g('f_allday').checked;
  return o;
}

/* ---- Google Doc notes panel ----------------------------------------------
   A Google Doc holds internal planning notes; Coda provisions it and stores the
   URL in the `Notes Doc` column (-> ev.notesDocUrl). We embed a read-only
   /preview iframe (renders only for a viewer signed into Google with access)
   and link out to /edit for real editing. An empty state offers a "Create notes
   doc" button that pushes the Coda button via the proxy; we then poll until the
   URL lands and swap in the read-only /preview embed. */
const _gdocId = u => { const m=String(u||'').match(/\/document\/d\/([A-Za-z0-9_-]+)/); return m?m[1]:''; };
const gdocPreviewUrl = u => { const id=_gdocId(u); return id?`https://docs.google.com/document/d/${id}/preview`:''; };
const gdocEditUrl    = u => { const id=_gdocId(u); return id?`https://docs.google.com/document/d/${id}/edit`:(u||''); };
function notesDocEmbedHTML(url){
  const pv=gdocPreviewUrl(url);
  if(!pv) return `<div class="ndoc-warn">That doesn't look like a Google Doc link.</div>`;
  return `<iframe class="ndoc-frame" src="${esc(pv)}" title="Planning notes (Google Doc)" loading="lazy"></iframe>
    <div class="ndoc-bar">
      <a class="btn sm primary" href="${esc(gdocEditUrl(url))}" target="_blank" rel="noopener">Edit in Google Docs ↗</a>
      <span class="hint">Preview needs you signed into Google with access to the doc.</span>
    </div>`;
}
let _ndocGen = 0;   // bumped when the editor closes / a new create starts — cancels stale notes-doc polls
const NDOC_CREATE_HTML = `<div class="ndoc-empty">
  <button type="button" class="btn sm primary" data-act="ndoc-create">Create notes doc</button>
  <span class="hint">Generates a Google Doc from the planning template.</span>
</div>`;
function notesDocPanelHTML(ev, canEdit){
  let inner;
  if(ev.notesDocUrl)          inner = notesDocEmbedHTML(ev.notesDocUrl);
  else if(canEdit && ev.id)   inner = NDOC_CREATE_HTML;
  else if(canEdit && !ev.id)  inner = `<div class="ndoc-empty"><span class="hint">Save the event first, then add a notes doc.</span></div>`;
  else                        inner = `<div class="ndoc-empty"><span class="hint">No notes doc yet.</span></div>`;
  return `<div class="fld full"><label>Notes doc <span class="hint">(Google Docs)</span></label>
    <div class="ndoc" id="f_ndoc">${inner}</div></div>`;
}
// Poll the server rows (bypassing the _recent optimistic overlay via listPlanning)
// until the Copy file button has written the URL into the Notes Doc column, then
// swap the panel to the embed. ~3s cadence, ~40-tick (~3 min) ceiling — the
// pack-action URL write-back can lag ~50s in Coda's list-rows API.
async function pollForNotesDoc(rowId, tries, gen){
  const el = () => document.getElementById('f_ndoc');
  if(tries >= 40){
    const e=el(); if(e && (!editing || editing.id===rowId))
      e.innerHTML=`<div class="ndoc-warn">Still setting up — this can take a minute. Reopen the event to check.</div>`;
    return;
  }
  await new Promise(r=>setTimeout(r, 3000));
  if(gen !== _ndocGen) return;                 // editor closed or a newer create started — stop
  let ev=null;
  try{ const rows=await DB.listPlanning(); ev=rows.find(x=>x.id===rowId); }catch(_){}
  if(ev && ev.notesDocUrl){
    if(editing && editing.id===rowId) editing.notesDocUrl=ev.notesDocUrl;
    const item=state.events.find(x=>x.id===rowId); if(item) item.notesDocUrl=ev.notesDocUrl;
    const e=el(); if(e && (!editing || editing.id===rowId)) e.innerHTML=notesDocEmbedHTML(ev.notesDocUrl);
    toast('Notes doc ready','ok');
    return;
  }
  pollForNotesDoc(rowId, tries+1, gen);
}

// Push the row's notes-doc button, retrying past Coda's read-after-write lag: a
// just-created row 404s from the buttons API for ~20-30s until Coda settles it.
// Returns 'ok' | 'failed' | 'cancelled'. Runs under the spinner; the gen token
// cancels it if the editor closes or a newer create starts.
async function pushNotesDocButton(rowId, gen){
  const deadline = performance.now() + 60000;   // Coda row-settle lag observed 25-45s; budget past it
  for(;;){
    if(gen !== _ndocGen) return 'cancelled';
    try{ await DB.createNotesDoc(rowId); return 'ok'; }
    catch(err){
      if(err && err.status===404 && performance.now() < deadline){ await new Promise(r=>setTimeout(r, 4000)); continue; }
      console.warn('notes-doc push failed:', err && err.status, err && err.message);
      return 'failed';
    }
  }
}

function openEditor(ev){
  editing = ev;
  const isRef = ev.source==='ref';
  const canEdit = !isRef && !!(state.identity && state.identity.canWrite);
  const canApprove = !isRef && !!(state.identity && state.identity.canApprove);
  const locked = (!isRef) && ev.status==='approved' && !canApprove;
  const c = isRef ? REF[ev.refLayer].color : progColor(ev.program);
  document.getElementById('mStripe').style.setProperty('--c',c);
  document.getElementById('mTitle').textContent = ev.id ? (isRef?'Reference event':'Edit event') : 'New event';
  const actions=document.getElementById('mActions');
  const body=document.getElementById('mBody');
  if(isRef){
    actions.innerHTML = `<span class="badge b-ref">${esc(REF[ev.refLayer].name)}</span>`;
    body.innerHTML = `
      <div class="fld full"><label>Title</label><input value="${esc(ev.title)}" disabled></div>
      <div class="fld"><label>Date</label><input value="${fmtDate(ev.date)}" disabled></div>
      <div class="fld"><label>Calendar</label><input value="${REF[ev.refLayer].name}" disabled></div>
      <div class="locknote">Read-only reference calendar. Toggle it off in the top strip to hide this layer.</div>`;
    document.getElementById('mFoot').innerHTML=`<span class="push"></span><button class="btn" data-act="close">Close</button>`;
    show(); return;
  }

  const dis = (!canEdit || locked) ? 'disabled' : '';
  const sched = ev.scheduling || 'exact';

  // header (top-right): status control + approve / reopen
  let head = (canEdit && !locked)
    ? `<select id="f_status" class="statussel" aria-label="Status">${STATUSES.filter(s=>s!=='approved').map(s=>`<option value="${s}" ${s===ev.status?'selected':''}>${cap(s)}</option>`).join('')}${ev.status==='approved'?'<option value="approved" selected>Approved</option>':''}</select>`
    : `<span class="badge b-${ev.status}">${cap(ev.status)}</span>`;
  if(canApprove) head += (ev.status==='approved')
    ? `<button class="btn sm" data-act="reopen">Reopen</button>`
    : `<button class="btn primary sm" data-act="approve">Approve${ev.id?'':' & save'}</button>`;
  actions.innerHTML = head;

  body.innerHTML = `
    <div class="fld full"><label>Title</label><input id="f_title" value="${esc(ev.title)}" ${dis} placeholder="e.g. Kabbalat Shabbat"></div>
    <div class="fld full"><label>Description <span class="hint">(public promo)</span></label><textarea id="f_desc" ${dis} placeholder="What's the plan?">${esc(ev.description||'')}</textarea></div>
    <div class="fld full"><label>Program(s)</label><div class="leadchips" id="f_progs">${PROGRAMS.filter(p=>p.id!=='oth' && (p.active!==false || (ev.programs&&ev.programs.includes(p.id)))).map(p=>`<button type="button" class="leadchip" data-p="${p.id}" aria-pressed="${(ev.programs&&ev.programs.length?ev.programs:[ev.program]).includes(p.id)}" ${dis}>${esc(p.name)}</button>`).join('')}</div></div>
    <div class="fld full"><label>Leads <span class="hint">(program leads auto-added)</span></label><div class="typeahead${dis?' dis':''}" id="f_leads"><input class="ta-input" type="text" placeholder="Search leads…" autocomplete="off" ${dis}><div class="ta-menu" hidden></div></div></div>
    <div class="fld full"><label>When</label>
      <div class="whenseg" id="f_when">
        <button type="button" data-when="exact" aria-pressed="${sched==='exact'}" ${dis}>Exact date</button>
        <button type="button" data-when="range" aria-pressed="${sched==='range'}" ${dis}>Date range</button>
        <button type="button" data-when="month" aria-pressed="${sched==='month'}" ${dis}>Whole month</button>
      </div>
    </div>
    <div class="fld full" id="whenFields"></div>
    <div class="fld full"><label>Where</label>
      <div class="whenseg typeseg" id="f_vtype_seg">
        <button type="button" data-vtype="" aria-pressed="${!ev.venueType}" ${dis}>Any</button>
        ${VENUE_TYPES.map(t=>`<button type="button" data-vtype="${t.id}" aria-pressed="${t.id===ev.venueType}" ${dis}>${esc(t.name)}</button>`).join('')}
      </div>
    </div>
    <div class="fld full"><div class="typeahead venuepick${dis?' dis':''}" id="f_venue_box"><input class="ta-input" type="text" placeholder="Search venues…" autocomplete="off" ${dis}><div class="ta-menu" hidden></div><div class="venue-other-wrap" hidden><input class="venue-other" type="text" placeholder="New venue name" ${dis}><button type="button" class="venue-clear" aria-label="Clear venue">×</button></div></div></div>
    <div class="fld full"><label>Volunteers <span class="hint">(any member)</span></label><div class="typeahead${dis?' dis':''}" id="f_vols"><input class="ta-input" type="text" placeholder="Search people…" autocomplete="off" ${dis}><div class="ta-menu" hidden></div></div></div>
    ${notesDocPanelHTML(ev, canEdit && !locked)}
    ${ev.planningNotes ? `<div class="fld full"><label>Planning notes <span class="hint">(legacy)</span></label><div class="legacynotes">${esc(ev.planningNotes)}</div></div>` : ''}
    ${(!canEdit)?`<div class="locknote">Sign in as a program lead to edit.</div>`:``}
    ${locked?`<div class="locknote">🔒 Approved &amp; locked. Detailed edits (ticketing, banner, promotion) happen in Coda. <a href="#" data-act="coda">Open in Mission Control ↗</a></div>`:''}
    ${ev.id?`<div class="meta"><span>Created by ${esc(ev.createdBy||'—')}</span><span>Last edited by ${esc(ev.editedBy||'—')}</span></div>`:''}`;

  // footer: Delete / Cancel / Save (approve + reopen live in the header now)
  const foot=document.getElementById('mFoot');
  let acts='';
  if(ev.id && canEdit && !locked) acts+=`<button class="btn danger" data-act="delete">Delete</button>`;
  acts+=`<span class="push"></span>`;
  acts+=`<button class="btn" data-act="close">${canEdit&&!locked?'Cancel':'Close'}</button>`;
  if(canEdit && !locked) acts+=`<button class="btn primary" data-act="save">${ev.id?'Save':'Create'}</button>`;
  foot.innerHTML=acts;

  // leads (leadership cohort) + volunteers (all people) + venue typeaheads
  const resolveIds = (ids, names) => (ids && ids.length) ? ids : (names||[]).map(n=>peopleIdByName[n]).filter(Boolean);
  const leadsBox=document.getElementById('f_leads'); if(leadsBox) initTypeahead(leadsBox, { selected:resolveIds(ev.leads, ev.leadNames), pool:()=>LEADS_LIST });
  const volBox=document.getElementById('f_vols');   if(volBox)   initTypeahead(volBox,   { selected:resolveIds(ev.volunteers, ev.volunteerNames), pool:()=>PEOPLE_LIST });
  const venBox=document.getElementById('f_venue_box'); if(venBox) initVenuePicker(venBox, ev);

  // notes doc: "Create notes doc" → push the Coda button via the proxy, then poll
  const ndoc=document.getElementById('f_ndoc');
  if(ndoc) ndoc.addEventListener('click', async e=>{
    const b=e.target.closest('[data-act="ndoc-create"]'); if(!b) return;
    if(!editing || !editing.id){ toast('Save the event first','err'); return; }
    ndoc.innerHTML=`<div class="ndoc-loading"><span class="ndoc-spin"></span> Setting up your notes doc… <span class="hint">(this can take up to a minute)</span></div>`;
    const gen = ++_ndocGen;
    const rowId = editing.id;
    const pushed = await pushNotesDocButton(rowId, gen);   // retries past Coda's row-settle lag
    if(pushed==='cancelled') return;                       // editor closed / superseded
    if(pushed!=='ok'){ toast('Could not start — try again in a moment','err'); if(document.getElementById('f_ndoc')) ndoc.innerHTML=NDOC_CREATE_HTML; return; }
    pollForNotesDoc(rowId, 0, gen);
  });

  // program chips: toggle + append that program's Current Leads when selected
  if(canEdit && !locked){
    document.getElementById('f_progs').addEventListener('click', e=>{
      const b=e.target.closest('.leadchip'); if(!b) return;
      const now = b.getAttribute('aria-pressed')!=='true';
      b.setAttribute('aria-pressed', String(now));
      if(now && leadsBox && leadsBox.addPerson){
        const prog=PROG[b.dataset.p];
        (prog && prog.currentLeadNames || []).forEach(nm=>{ const id=peopleIdByName[nm]; if(id) leadsBox.addPerson(id); });
      }
    });
    // Where: venue-type switcher (single-select) — filters the venue typeahead pool
    document.getElementById('f_vtype_seg').addEventListener('click', e=>{
      const b=e.target.closest('button[data-vtype]'); if(!b) return;
      [...b.parentElement.children].forEach(x=>x.setAttribute('aria-pressed', x===b));
    });
  }

  // when control: mode switch + all-day toggle both re-render the time fields
  whenType = sched;
  const wf=document.getElementById('whenFields');
  wf.innerHTML = whenFieldsHTML(whenType, ev, dis);
  if(canEdit && !locked){
    document.getElementById('f_when').addEventListener('click',e=>{
      const b=e.target.closest('button[data-when]'); if(!b) return;
      const cur=collectWhen();
      whenType=b.dataset.when;
      [...b.parentElement.children].forEach(x=>x.setAttribute('aria-pressed', x===b));
      wf.innerHTML=whenFieldsHTML(whenType, Object.assign({},ev,cur), '');
    });
    wf.addEventListener('change', e=>{                 // All-day toggled → show/hide the times
      if(e.target.id!=='f_allday') return;
      wf.innerHTML=whenFieldsHTML('exact', Object.assign({},ev,collectWhen()), '');
    });
  }

  show();
  const t=document.getElementById('f_title'); if(t && !ev.id) t.focus();
}

function readForm(){
  const g=id=>document.getElementById(id);
  const chipIds=sel=>[...document.querySelectorAll(sel)].map(c=>c.dataset.id);
  const programs=[...document.querySelectorAll('#f_progs .leadchip')].filter(b=>b.getAttribute('aria-pressed')==='true').map(b=>b.dataset.p);
  const leads=chipIds('#f_leads .ta-chip');
  const volunteers=chipIds('#f_vols .ta-chip');
  const venBox=g('f_venue_box'), venOther=venBox && venBox.querySelector('.venue-other-wrap');
  const venue=venBox ? (venBox.dataset.venueId||'') : '';
  const venueOther=(venOther && !venOther.hidden) ? venBox.querySelector('.venue-other').value.trim() : '';
  const vtBtn=document.querySelector('#f_vtype_seg button[aria-pressed="true"]');
  const venueType=vtBtn ? (vtBtn.dataset.vtype||'') : '';
  const w=collectWhen();
  const exact=whenType==='exact', allDay= exact ? !!w.allDay : true;   // range/month are all-day
  const o={
    program:programs[0]||'oth', programs, status:g('f_status').value, title:g('f_title').value.trim()||'Untitled',
    allDay, start:(exact && !allDay) ? (w.start||'') : '', end:(exact && !allDay) ? (w.end||'') : '',
    leads, volunteers, venueType, venue, venueOther,
    location:(venue ? ((VENUES.find(v=>v.id===venue)||{}).name||'') : '') || venueOther,   // display fallback
    description:g('f_desc').value.trim(), planningNotes:(editing && editing.planningNotes)||'',
    scheduling:whenType, date:'', rangeStart:'', rangeEnd:'', targetMonth:''
  };
  if(exact) o.date=w.date||'';
  else if(whenType==='range'){ o.rangeStart=w.rangeStart||''; o.rangeEnd=w.rangeEnd||w.rangeStart||''; }
  else if(whenType==='month') o.targetMonth=w.targetMonth||'';
  return o;
}

/* ---- optimistic writes: reflect the change instantly, reconcile after ------ */
let _toastEl=null, _toastT=null;
function toast(msg, kind){
  if(!_toastEl){ _toastEl=document.createElement('div'); _toastEl.className='toast'; document.body.appendChild(_toastEl); }
  _toastEl.textContent=msg; _toastEl.className='toast show'+(kind?' '+kind:'');
  clearTimeout(_toastT);
  if(kind!=='busy') _toastT=setTimeout(()=>{ if(_toastEl) _toastEl.className='toast'; }, 2200);
}
let _saving=false, _reconcileT=null;
function scheduleReconcile(){ clearTimeout(_reconcileT); _reconcileT=setTimeout(()=>refresh(), 2500); }  // let Coda index, then pull server truth (recent guard prevents flicker)
function applyLocal(e, remove){
  const i=state.events.findIndex(x=>x.id===e.id);
  if(remove){ if(i>=0) state.events.splice(i,1); return; }
  if(i>=0) state.events[i]=e; else state.events.push(e);
}
async function saveEditor(approve){
  if(_saving) return;
  const exp=tokenExpMs(); if(exp && exp<=Date.now()){ sessionExpired(); return; }   // token already dead → don't lose the edit to an optimistic revert
  const f=readForm();
  const isNew=!editing.id;
  const me=(state.identity && state.identity.name) || '';
  const base= isNew ? {source:'planning', eventbriteUrl:'', gcalId:'', createdBy:me, editedBy:me} : editing;
  const e=Object.assign({}, base, f);
  e.editedBy = me || e.editedBy;
  if(approve) e.status='approved';
  const prev = isNew ? null : Object.assign({}, editing);
  if(isNew) e.id='tmp-'+Date.now();
  _saving=true;
  applyLocal(e); close(); rerender(); toast(approve?'Approving…':'Saving…','busy');   // instant reflect
  try{
    const saved = isNew ? await DB.create(e) : await DB.update(e);
    if(isNew && saved && saved.id && saved.id!==e.id){ applyLocal(e, true); e.id=saved.id; applyLocal(e); rerender(); }  // swap temp id → real
    markRecent(e.id, { e });
    toast(approve?'Approved':'Saved','ok');
    scheduleReconcile();
  }catch(err){
    applyLocal(e, true); if(prev) applyLocal(prev); rerender();
    if(err && err.status===401) sessionExpired();
    else { toast('Save failed — reverted','err'); console.warn('save failed:', err); }
  }finally{ _saving=false; }
}
async function reopenEditor(){
  if(_saving || !editing || !editing.id) return;
  const prev=Object.assign({}, editing);
  const e=Object.assign({}, editing, {status:'confirmed'});
  _saving=true;
  applyLocal(e); close(); rerender(); toast('Reopening…','busy');
  try{ await DB.update(e); markRecent(e.id, { e }); toast('Reopened','ok'); scheduleReconcile(); }
  catch(err){ applyLocal(prev); rerender(); if(err && err.status===401) sessionExpired(); else { toast('Reopen failed — restored','err'); console.warn('reopen failed:', err); } }
  finally{ _saving=false; }
}
async function deleteEditor(){
  if(_saving) return;
  if(!editing || !editing.id){ close(); return; }
  const id=editing.id, prev=Object.assign({}, editing);
  _saving=true;
  applyLocal({id}, true); close(); rerender(); toast('Deleting…','busy');
  try{
    await DB.remove(id);
    markRecent(id, { deleted:true });
    toast('Deleted','ok'); scheduleReconcile();
  }catch(err){
    applyLocal(prev); rerender();
    if(err && err.status===401) sessionExpired();
    else { toast('Delete failed — restored','err'); console.warn('delete failed:', err); }
  }finally{ _saving=false; }
}

/* =========================================================================
   WIRING
   ========================================================================= */
function show(){ document.getElementById('scrim').classList.add('open'); }
function close(){ _ndocGen++; document.getElementById('scrim').classList.remove('open'); editing=null; }

document.getElementById('scrim').addEventListener('click',e=>{ if(e.target.id==='scrim') close(); });
document.addEventListener('keydown',e=>{ if(e.key==='Escape') close(); });

document.getElementById('mFoot').addEventListener('click',e=>{
  const act=e.target.closest('[data-act]')?.dataset.act; if(!act) return;
  if(act==='close') close();
  else if(act==='save') saveEditor(false);
  else if(act==='approve') saveEditor(true);
  else if(act==='reopen'){ reopenEditor(); }
  else if(act==='delete') deleteEditor();
});
// header actions (status live in the select; approve/reopen buttons)
document.getElementById('mActions').addEventListener('click',e=>{
  const act=e.target.closest('[data-act]')?.dataset.act; if(!act) return;
  if(act==='approve') saveEditor(true);
  else if(act==='reopen') reopenEditor();
});
document.getElementById('mBody').addEventListener('click',e=>{
  if(e.target.closest('[data-act="coda"]')){ e.preventDefault(); alert('Live version: deep-links to this row in the Mission Control Coda doc for full editing (ticketing, banner, promotion).'); }
});

document.getElementById('months').addEventListener('click',e=>{
  const gchip=e.target.closest('.gchip'); if(gchip){ const ev=state.events.find(x=>x.id===gchip.dataset.id); if(ev) openEditor(ev); return; }
  const gadd=e.target.closest('[data-newidea]'); if(gadd){ openEditor(newIdeaInMonth(gadd.dataset.newidea)); return; }
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
  const cell=e.target.closest('.cell'); if(!cell) return;
  openEditor(newEventOn(cell.dataset.date));
});

document.getElementById('quarter').addEventListener('click',e=>{
  const chip=e.target.closest('.qchip');
  if(chip){ const ev=state.events.find(x=>x.id===chip.dataset.id); if(ev) openEditor(ev); return; }
  const z=e.target.closest('.qzone'); if(z && z.dataset.add) openEditor(newEventOn(z.dataset.add));
});

function newEventOn(date){
  return {id:null,source:'planning',program:'',programs:[],title:'',leads:[],date,start:'18:30',end:'20:00',allDay:false,location:'',status:'draft',description:'',scheduling:'exact',rangeStart:'',rangeEnd:'',targetMonth:'',createdBy:state.currentUser,editedBy:state.currentUser,eventbriteUrl:'',gcalId:''};
}
function newIdeaInMonth(mkey){
  return {id:null,source:'planning',program:'oth',title:'',leads:[],date:'',start:'',end:'',allDay:false,location:'',status:'idea',description:'',scheduling:'month',rangeStart:'',rangeEnd:'',targetMonth:mkey,createdBy:state.currentUser,editedBy:state.currentUser,eventbriteUrl:'',gcalId:''};
}

/* tiny day picker when a cell overflows */
function openDayPicker(ds,list){
  editing={id:'__picker__'};
  document.getElementById('mStripe').style.setProperty('--c','var(--accent)');
  document.getElementById('mTitle').textContent=fmtDate(ds);
  document.getElementById('mActions').innerHTML=`<span class="badge b-ref">${list.length} events</span>`;
  document.getElementById('mBody').innerHTML=`<div class="fld full"><div class="chips" id="dp">${list.map(chipHTML).join('')}</div></div>`;
  document.getElementById('mFoot').innerHTML=`<button class="btn primary" data-act="newhere">+ New on this day</button><span class="push"></span><button class="btn" data-act="close">Close</button>`;
  document.getElementById('dp').addEventListener('click',ev=>{ const c=ev.target.closest('.chip'); if(!c) return; const item=state.events.find(x=>x.id===c.dataset.id); if(item) openEditor(item); });
  document.getElementById('mFoot').querySelector('[data-act="newhere"]').addEventListener('click',()=>openEditor(newEventOn(ds)));
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
function rerender(){ if(state.view==='overview') renderOverview(); else renderMonths(); }
function applyView(){
  const yv=document.getElementById('yearView'), q=document.getElementById('quarter');
  if(state.view==='overview'){ yv.style.display='none'; q.classList.add('on'); renderOverview(); }
  else { yv.style.display=''; q.classList.remove('on'); renderMonths(); }
  updateNavLabel(); layoutSticky();
}
document.getElementById('viewSeg').addEventListener('click',e=>{
  const b=e.target.closest('button'); if(!b) return;
  state.view=b.dataset.view;
  [...b.parentElement.children].forEach(x=>x.setAttribute('aria-pressed', x===b));
  applyView();
});

/* legend / info modal */
document.getElementById('infoBtn').addEventListener('click',openInfo);

/* close the account + overflow menus on outside click / Esc */
document.addEventListener('click', e=>{
  if(!e.target.closest('.acct')) acctMenu(false);
  if(!e.target.closest('#ovfPanel') && !e.target.closest('#ovfBtn')) ovfMenu(false);
});
document.addEventListener('keydown', e=>{ if(e.key==='Escape'){ acctMenu(false); ovfMenu(false); } });

/* layer toggles */
document.getElementById('layers').addEventListener('click',e=>{
  const lab=e.target.closest('.lyr'); if(!lab) return;
  const id=lab.dataset.layer; if(id==='planning'){ state.layers.planning=!state.layers.planning; lab.dataset.on=state.layers.planning; }
  else { state.layers[id]=!state.layers[id]; lab.dataset.on=state.layers[id]; }
  rerender();
});

/* nav — both views span a program year */
function navStep(dir){ state.startYear+=dir; rerender(); updateNavLabel(); }
function updateNavLabel(){
  const el=document.getElementById('yrLabel');
  el.textContent=`'${String(state.startYear).slice(2)}–'${String(state.startYear+1).slice(2)}`;   // compact: '26–'27
  el.title=`Program year ${state.startYear}–${state.startYear+1}`;
}
document.getElementById('prevYr').addEventListener('click',()=>navStep(-1));
document.getElementById('nextYr').addEventListener('click',()=>navStep(1));
document.getElementById('addBtn').addEventListener('click',()=>openEditor(newEventOn(inProgramYear(todayStr)?todayStr:firstOfProgramYear())));
function firstOfProgramYear(){ return ymd(state.startYear,8,1); }
function inProgramYear(ds){ return ds>=ymd(state.startYear,8,1) && ds<=ymd(state.startYear+1,7,31); }

/* ---- Google sign-in (identity + role gating via the Worker /me) --------- */
const GOOGLE_CLIENT_ID = '463482291986-hpei9a9egdth2m2vlf9nt56t1jglmnjq.apps.googleusercontent.com';   // OAuth Web client (public)
// Persist the ID token so a page reload / discarded-tab restore keeps the
// session without depending on Google's silent One-Tap re-auth (which 403s on
// localhost). sessionStorage: survives reload + tab-discard, clears on tab close.
const TOKEN_KEY = 'est-idtoken';
function saveToken(t){ try{ t ? sessionStorage.setItem(TOKEN_KEY, t) : sessionStorage.removeItem(TOKEN_KEY); }catch(_){} }
function loadToken(){ try{ return sessionStorage.getItem(TOKEN_KEY) || null; }catch(_){ return null; } }
function jwtClaims(t){ try{ return JSON.parse(atob(String(t).split('.')[1].replace(/-/g,'+').replace(/_/g,'/'))); }catch(_){ return {}; } }
function initials(name){ return (String(name||'?').trim().split(/\s+/).map(w=>w[0]).slice(0,2).join('')||'?').toUpperCase(); }
function roleLabel(id){ return id.canApprove ? 'Tribal Council' : (id.canWrite ? 'Program Lead' : (id.matched ? 'Member' : 'Not a recognized lead')); }
function renderAuth(){
  const el = document.getElementById('authSlot'); if(!el) return;
  const id = state.identity;
  if(id && id.signedIn){
    const claims = jwtClaims(state.idToken);
    const name = id.name || claims.name || claims.email || 'Account';
    const pic = claims.picture || '';
    el.innerHTML = `<div class="acct">
        <button class="avatar" id="avatarBtn" aria-haspopup="menu" aria-expanded="false" title="${esc(name)}">${pic ? `<img src="${esc(pic)}" alt="" referrerpolicy="no-referrer">` : esc(initials(name))}</button>
        <div class="acct-menu" id="acctMenu" role="menu" hidden>
          <div class="acct-who"><b>${esc(name)}</b><span class="role">${esc(roleLabel(id))}</span></div>
          <button class="btn ghost" id="signOut" role="menuitem">Sign out</button>
        </div>
      </div>`;
    el.querySelector('#avatarBtn').addEventListener('click', e=>{ e.stopPropagation(); acctMenu(); });
    el.querySelector('#signOut').addEventListener('click', signOut);
  } else {
    el.innerHTML = `<span id="gbtn"></span>`;
    if(GOOGLE_CLIENT_ID && window.google && google.accounts && google.accounts.id)
      google.accounts.id.renderButton(el.querySelector('#gbtn'), { type:'standard', size:'medium', text:'signin_with', shape:'pill' });
  }
}
function acctMenu(open){
  const m=document.getElementById('acctMenu'), b=document.getElementById('avatarBtn'); if(!m||!b) return;
  const willOpen = open!==undefined ? open : m.hidden;
  m.hidden = !willOpen; b.setAttribute('aria-expanded', String(willOpen));
}

/* ---- mobile overflow (⋯): relocate year-nav + filters into a dropdown ---- */
const headerMQ = window.matchMedia('(max-width:600px)');
function ovfMenu(open){
  const p=document.getElementById('ovfPanel'), b=document.getElementById('ovfBtn'); if(!p||!b) return;
  const willOpen = open!==undefined ? open : p.hidden;
  p.hidden=!willOpen; b.setAttribute('aria-expanded', String(willOpen));
}
function applyHeaderMode(){
  const panel=document.getElementById('ovfPanel'), ovfBtn=document.getElementById('ovfBtn');
  const yearnav=document.querySelector('.yearnav'), layers=document.getElementById('layers');
  const controls=document.querySelector('.controls'), bar=document.querySelector('.bar');
  if(!panel||!ovfBtn) return;
  if(headerMQ.matches){                                   // mobile: tuck year-nav + filters into the ⋯ panel
    if(yearnav && yearnav.parentElement!==panel) panel.appendChild(yearnav);
    if(layers && layers.parentElement!==panel) panel.appendChild(layers);
    ovfBtn.hidden=false;
  } else {                                                // desktop: restore to their inline homes
    if(yearnav && controls && yearnav.parentElement===panel) controls.appendChild(yearnav);
    if(layers && bar && layers.parentElement===panel) bar.after(layers);
    ovfBtn.hidden=true; ovfMenu(false);
  }
  layoutSticky();
}
async function fetchMe(){
  if(!PROXY_BASE || !state.idToken){ state.identity=null; renderAuth(); return; }
  try{
    const r = await fetch(`${PROXY_BASE}/me`, { headers:{ 'Authorization':`Bearer ${state.idToken}` } });
    if(r.ok){ state.identity = await r.json(); }
    else { state.identity = null; if(r.status===401){ state.idToken=null; saveToken(null); } } // stale/expired token -> drop it
  }catch(_){ state.identity=null; }               // transient network error: keep the token, try again later
  renderAuth(); applyView();
}
async function onCredential(resp){ state.idToken = (resp && resp.credential) || null; saveToken(state.idToken); await fetchMe(); }
function signOut(){ state.idToken=null; state.identity=null; saveToken(null); try{ google.accounts.id.disableAutoSelect(); }catch(_){} renderAuth(); applyView(); }

/* Google ID tokens expire ~1h. Keep the UI honest as the token ages and refresh
   proactively so an idle tab doesn't silently go stale. */
function tokenExpMs(){ const e=jwtClaims(state.idToken).exp; return e ? e*1000 : 0; }
function sessionExpired(){
  state.idToken=null; state.identity=null; saveToken(null);
  renderAuth(); applyView();                        // reflect signed-out (Sign in button)
  toast('Session expired — please sign in again','err');
  try{ if(window.google && google.accounts && google.accounts.id) google.accounts.id.prompt(); }catch(_){}  // courtesy silent re-auth (works on the deploy origin)
}
let _reauthT=null;
function checkAuthFreshness(){                       // called on tab focus + the 60s poll
  if(!state.idToken) return;
  const exp=tokenExpMs(); if(!exp) return;
  const now=Date.now();
  if(exp - now > 5*60*1000) return;                 // still comfortably fresh
  try{ if(window.google && google.accounts && google.accounts.id) google.accounts.id.prompt(); }catch(_){}  // silent refresh before it lapses
  if(exp <= now){                                   // already expired — if silent re-auth doesn't land, show signed-out
    clearTimeout(_reauthT);
    _reauthT=setTimeout(()=>{ if(!state.idToken || tokenExpMs() <= Date.now()) sessionExpired(); }, 3000);
  }
}
function initAuth(){
  if(!GOOGLE_CLIENT_ID){ renderAuth(); return; }                         // not configured yet
  if(!state.idToken){ state.idToken = loadToken(); if(state.idToken) fetchMe(); } // restore persisted session, validate via /me
  gisReady();
}
function gisReady(){
  if(!(window.google && google.accounts && google.accounts.id)) return setTimeout(gisReady, 300); // wait for GIS
  google.accounts.id.initialize({ client_id: GOOGLE_CLIENT_ID, callback: onCredential, auto_select: true });
  renderAuth();
  if(!state.idToken) google.accounts.id.prompt();     // only fall back to silent re-auth if we have no token
}

let _refreshing = false;
async function refresh(){
  if(_refreshing) return;                    // don't stack overlapping polls/clicks
  _refreshing = true;
  try { await loadEvents(); applyView(); layoutSticky(); } finally { _refreshing = false; }
}
async function init(){
  buildWeekHead(); renderLayers(); updateNavLabel(); initAuth();
  document.getElementById('ovfBtn').addEventListener('click', e=>{ e.stopPropagation(); ovfMenu(); });
  headerMQ.addEventListener('change', applyHeaderMode);
  applyHeaderMode();
  // Wire refresh/focus/poll up front so they work immediately (never dead while loading).
  const rb = document.getElementById('refreshBtn'); if(rb) rb.addEventListener('click', refresh);
  document.addEventListener('visibilitychange', () => { if(!document.hidden){ refresh(); checkAuthFreshness(); } }); // refetch + re-check auth on tab focus
  setInterval(() => { if(!document.hidden){ refresh(); checkAuthFreshness(); } }, 60000);    // light 60s poll while visible

  // Kick off ref loads — each hydrates its maps synchronously from cache, then
  // refreshes in the background. loadPeople is the slow one (/ref/people is many
  // seconds) so it is NOT awaited — the calendar doesn't need it (leads/venues
  // resolve in the editor via cached maps / stored names).
  loadPrograms(); loadVenues(); loadPeople();
  // Instant paint from the last cached events (maps are hydrated above).
  const cachedRows = cacheGet('rows-raw');
  if(cachedRows && cachedRows.length){ state.events = [...cachedRows.map(planningRowToEvent), ...MOCK_REFS]; applyView(); layoutSticky(); }
  // Fresh events (renders as soon as /rows returns).
  await refresh();
  setTimeout(()=>{
    const t=new Date();
    if(state.view==='overview'){ const el=document.querySelector(`.qcol[data-mk="${monthKey(t.getFullYear(),t.getMonth())}"]`); if(el) el.scrollIntoView({block:'center'}); }
    else { const el=document.querySelector('.cell.today'); if(el) el.scrollIntoView({block:'center'}); }
  },60);
}

/* utils */
function esc(s){return String(s==null?'':s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));}
function cap(s){return s?s[0].toUpperCase()+s.slice(1):s;}
function fmtDate(ds){const [y,m,d]=ds.split('-').map(Number);return `${WD[new Date(y,m-1,d).getDay()]}, ${MONTHS[m-1]} ${d}, ${y}`;}

init();
