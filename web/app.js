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
const STATUSES = ['draft','proposed','approved','cancelled'];
/* reference layers — muted context, read-only. Populated live from
   /references (Reference Calendars SRC in Coda); starts empty. */
let REF_LAYERS = [];
let REF = {};
function rebuildRefs(layers){
  REF_LAYERS = layers.map(l=>({ id:l.id, name:l.name, color:l.color, on:!!l.defaultOn }));
  REF = Object.fromEntries(REF_LAYERS.map(r=>[r.id,r]));
  for(const l of REF_LAYERS){ if(!(l.id in state.layers)) state.layers[l.id] = l.on; }
}

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
  let matches = [], active = -1, ready = false;
  const fire = () => { if(ready && opts.onChange) opts.onChange(); };   // user edits only (not initial seed)
  const has = id => [...container.querySelectorAll('.ta-chip')].some(c=>c.dataset.id===id);
  const addChip = (id, name) => {
    if(!id || has(id)) return;
    const chip = document.createElement('span');
    chip.className = 'ta-chip'; chip.dataset.id = id;
    chip.innerHTML = esc(name) + (disabled ? '' : ' <button type="button" aria-label="Remove" tabindex="-1">×</button>');
    if(!disabled) chip.querySelector('button').addEventListener('click', ()=>{ chip.remove(); fire(); });
    container.insertBefore(chip, input);
    fire();
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
  ready = true;   // seed done — subsequent adds/removes are user edits
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
function initVenuePicker(container, ev, opts){
  opts = opts || {};
  const input = container.querySelector('.ta-input');
  const menu  = container.querySelector('.ta-menu');
  const otherWrap = container.querySelector('.venue-other-wrap');
  const otherInput = container.querySelector('.venue-other');
  const disabled = input.disabled;
  let ready = false;
  const fire = () => { if(ready && opts.onChange) opts.onChange(); };   // user edits only (not initial state)
  const selTypeId = () => { const b=document.querySelector('#f_vtype_seg button[aria-pressed="true"]'); return b?b.dataset.vtype:''; };
  const typeName = () => (VENUE_TYPES.find(x=>x.id===selTypeId())||{}).name;
  const pool = () => { const tn=typeName(); return VENUES.filter(v=>!v.closed && (!tn || v.type===tn)).slice().sort((a,b)=>a.name.localeCompare(b.name)); };
  let active = -1;
  const clearPill = () => [...container.querySelectorAll('.ta-chip')].forEach(c=>c.remove());
  function showSelect(){ container.dataset.venueId=''; clearPill(); otherWrap.hidden=true; otherInput.value=''; input.hidden=false; input.value=''; menu.hidden=true; if(!disabled) input.focus(); fire(); }
  function selectVenue(v){
    container.dataset.venueId=v.id; clearPill(); otherWrap.hidden=true; input.hidden=true; menu.hidden=true;
    const tid=venueTypeIdByName[v.type], seg=document.getElementById('f_vtype_seg');   // sync the type switcher to the venue
    if(seg && tid) [...seg.children].forEach(b=>b.setAttribute('aria-pressed', String(b.dataset.vtype===tid)));
    const chip=document.createElement('span'); chip.className='ta-chip venue-pick';
    chip.innerHTML=esc(v.name)+(disabled?'':' <button type="button" aria-label="Clear" tabindex="-1">×</button>');
    if(!disabled) chip.querySelector('button').addEventListener('click', showSelect);
    container.insertBefore(chip, input);
    fire();
  }
  function enterOther(text){ container.dataset.venueId=''; clearPill(); input.hidden=true; menu.hidden=true; otherWrap.hidden=false; otherInput.value=text; if(!disabled) otherInput.focus(); fire(); }
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
  ready = true;   // initial state set — subsequent changes are user edits
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
    {column:'Status',          value:cap(e.status||'draft')},
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
    {column:'Capacity',           value:(e.capacity===''||e.capacity==null)?'':Number(e.capacity)},
    {column:'Address visibility', value:e.addressVisibility||'Public'},
    {column:'Public summary',     value:e.publicSummary||''},
    {column:'Public description', value:e.publicDescription||''},
  ];
}

/* Reference events are fetched + parsed server-side by the proxy (GET /references)
   from the council-managed Reference Calendars SRC table, and arrive already
   normalized to the { source:'ref', refLayer, ... } shape. See DB.listReferences. */

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
    status: String(v['Status'] || 'draft').toLowerCase(),
    description: v['Event Description'] || '',
    capacity: (v['Capacity'] === '' || v['Capacity'] == null) ? '' : Number(v['Capacity']),
    addressVisibility: v['Address visibility'] || 'Public',
    publicSummary: v['Public summary'] || '',
    publicDescription: v['Public description'] || '',
    publishStatus: v['Publish status'] || 'Unpublished',
    eventbriteId: v['Eventbrite Event ID'] || '',
    lastPublishError: v['Last publish error'] || '',
    planningNotes: v['Planning Notes'] || '',
    // proxy injects notesDocUrl resolved by the stable column id (rename-proof);
    // Notes Doc is a Coda link column, so the value may be a string or {url,name}.
    notesDocUrl: (typeof r.notesDocUrl === 'string' ? r.notesDocUrl : (r.notesDocUrl && (r.notesDocUrl.url || r.notesDocUrl.name))) || '',
    createdBy: _asList(v['Created by'])[0] || '', editedBy: _asList(v['Edited by'])[0] || '',
    eventbriteUrl: (typeof v['Eventbrite URL'] === 'string' ? v['Eventbrite URL'] : '') || '', gcalId:'', readOnly:true,          // writes come in Plan 2b
    scheduling: sched,
    rangeStart: String(v['Window start'] || '').slice(0,10),
    rangeEnd: String(v['Window end'] || '').slice(0,10),
    targetMonth: sched === 'month' ? rawDate.slice(0,7) : ''
  };
}
const READONLY_MSG = 'This calendar is read-only in Phase 1 — editing goes live in Phase 2 (Google sign-in + lead allowlist).';
const CodaSource = {
  base: PROXY_BASE,
  async listPlanning(opts={}){
    // fresh:true bypasses the Worker's 30s KV snapshot (notes-doc fast-poll needs
    // to see the button's URL write-back as soon as Coda has it).
    const r = await fetch(`${this.base}/rows${opts.fresh?'?fresh=1':''}`, { headers:{ 'Accept':'application/json' } });
    if(!r.ok) throw new Error(`proxy ${r.status}: ${await r.text()}`);
    const j = await r.json();
    const items = j.items || [];
    cacheSet('rows-raw', items);                       // instant repaint on next reload
    return items.map(planningRowToEvent);
  },
  async listReferences(){
    try{
      const r = await fetch(`${this.base}/references`, { headers:{ 'Accept':'application/json' } });
      if(!r.ok) return [];
      const j = await r.json();
      rebuildRefs(j.layers || []);
      renderLayers();
      cacheSet('references', j);                       // instant repaint on next reload
      return j.events || [];
    }catch(_){ return []; }
  },
  _wh(){ return { 'Content-Type':'application/json', 'Authorization':`Bearer ${state.idToken||''}` }; },
  async _fail(r){ let t=await r.text(); try{ t=JSON.parse(t).error||t; }catch(_){} const e=new Error(`save failed (${r.status})${t?': '+t:''}`); e.status=r.status; throw e; },
  async create(e){ const r=await fetch(`${this.base}/rows`,{method:'POST',headers:this._wh(),body:JSON.stringify({rows:[{cells:eventToCodaCells(e)}]})}); if(!r.ok) await this._fail(r); try{ const j=await r.json(); const id=j&&j.addedRowIds&&j.addedRowIds[0]; if(id) e.id=id; }catch(_){} return e; },
  async update(e){ const r=await fetch(`${this.base}/rows/${encodeURIComponent(e.id)}`,{method:'PUT',headers:this._wh(),body:JSON.stringify({row:{cells:eventToCodaCells(e)}})}); if(!r.ok) await this._fail(r); return e; },
  async remove(id){ const r=await fetch(`${this.base}/rows/${encodeURIComponent(id)}`,{method:'DELETE',headers:this._wh()}); if(!r.ok) await this._fail(r); },
  async createNotesDoc(rowId){ const r=await fetch(`${this.base}/notes-doc`,{method:'POST',headers:this._wh(),body:JSON.stringify({rowId})}); if(!r.ok) await this._fail(r); return true; },
  async publishEventbrite(rowId, draftOnly){ const r=await fetch(`${this.base}/publish/eventbrite`,{method:'POST',headers:this._wh(),body:JSON.stringify({rowId, draftOnly:!!draftOnly})}); const j=await r.json().catch(()=>({})); if(!r.ok){ const e=new Error(j.error||`publish failed (${r.status})`); e.status=r.status; throw e; } return j; },
  async cancelEventbrite(rowId){ const r=await fetch(`${this.base}/cancel/eventbrite`,{method:'POST',headers:this._wh(),body:JSON.stringify({rowId})}); const j=await r.json().catch(()=>({})); if(!r.ok){ const e=new Error(j.error||`cancel failed (${r.status})`); e.status=r.status; throw e; } return j; },
  async listFeedback(context){ const q=context?`?context=${encodeURIComponent(context)}`:''; const r=await fetch(`${this.base}/feedback${q}`,{headers:{Authorization:`Bearer ${state.idToken||''}`}}); if(!r.ok) return []; return (await r.json()).items||[]; },
  async submitFeedback(idea, context){ const r=await fetch(`${this.base}/feedback`,{method:'POST',headers:this._wh(),body:JSON.stringify({idea,context})}); if(!r.ok) await this._fail(r); return true; },
  async voteFeedback(id){ const r=await fetch(`${this.base}/feedback/${encodeURIComponent(id)}/vote`,{method:'POST',headers:this._wh()}); const j=await r.json().catch(()=>({})); if(!r.ok){ const e=new Error(j.error||'vote failed'); e.status=r.status; throw e; } return j; },
  // gather sign-up slots (lead-authored; members fill them in the gather app)
  async listSlots(eventId){ const r=await fetch(`${this.base}/slots?event=${encodeURIComponent(eventId)}`,{headers:this._wh()}); if(!r.ok) await this._fail(r); return (await r.json()).items||[]; },
  async createSlot(body){ const r=await fetch(`${this.base}/slots`,{method:'POST',headers:this._wh(),body:JSON.stringify(body)}); if(!r.ok) await this._fail(r); return (await r.json().catch(()=>({}))); },
  async updateSlot(id, body){ const r=await fetch(`${this.base}/slots/${encodeURIComponent(id)}`,{method:'PUT',headers:this._wh(),body:JSON.stringify(body)}); if(!r.ok) await this._fail(r); return true; },
  async removeSlot(id){ const r=await fetch(`${this.base}/slots/${encodeURIComponent(id)}`,{method:'DELETE',headers:this._wh()}); if(!r.ok) await this._fail(r); return true; },
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
  layers: { planning:true },   // ref-layer keys added dynamically from /references
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
        body += `<div class="cell ${other?'other':''} ${k===0||k===6?'we':''} ${isToday?'today':''}" data-date="${ds}" ${other?'data-other="1"':''}>
          <span class="add-hint">+</span>
          <span class="dnum">${dn}</span>
          <div class="chips">${evs.map(chipHTML).join('')}</div>
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
      <div style="font-size:11px;color:var(--faint)"><b style="color:var(--muted)">Reference calendars</b> (holidays, partner orgs) are read-only context pulled live from public feeds — toggle them under REFERENCE in the sidebar. Planning events read and write to the Coda <b>Mission Control</b> table.</div>
    </div>`;
}
function openInfo(){
  editing={id:'__info__'};
  document.getElementById('modal').classList.remove('ws'); document.getElementById('mBody').classList.remove('ws');
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

// Editor workspace sections (left rail). `live` sections have real panels;
// the rest render a muted "coming soon" teaser. No icon webfont — text labels.
const SECTIONS = [
  { id:'planning', label:'Planning', live:true },
  { id:'publish',  label:'Publish',  live:true },
  { id:'budget',    label:'Budget & expenses',   live:false },
  { id:'comms',     label:'Comms',               live:false },
  { id:'volunteers',label:'Volunteers & potluck', live:true },
  { id:'attendance',label:'Attendance',          live:false },
  { id:'feedback',  label:'Feedback',            live:false },
];
let activeSection = 'planning';

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

/* ---- publish-to-Eventbrite panel — mirrors the notes-doc panel's shape:
   a small `<div id="f_publish">` whose contents swap between a button, a
   "publishing…" spinner, and a linked/badge state. The Worker owns the
   Eventbrite fields (publishStatus/eventbriteId/eventbriteUrl/lastPublishError);
   this panel only ever reads them off `ev`, never writes them locally except
   as an optimistic reflection of what the Worker just told us. */
function publishPanelHTML(ev, canEdit){
  if(!canEdit) return '';
  if(ev.status!=='approved') return `<div class="fld full"><label>Eventbrite</label><div class="pubpanel"><span class="hint">Approve this event to publish it to Eventbrite.</span></div></div>`;
  const linked = !!ev.eventbriteId;
  const badge = `<span class="badge b-${(ev.publishStatus||'').toLowerCase()}">${esc(ev.publishStatus||'Unpublished')}</span>`;
  // Draft-first: build/sync a draft in Eventbrite (data-act="publish-eb-draft"),
  // review it there, then Publish for real (data-act="publish-eb-publish").
  const st = ev.publishStatus||'Unpublished';
  let inner;
  if(!linked){
    inner = `<button type="button" class="btn sm primary" data-act="publish-eb-draft">Create Eventbrite draft</button>
      <span class="hint">Builds a draft in Eventbrite — review it there, then Publish.</span>`;
  } else {
    const open = `<a class="reflink" href="${esc(ev.eventbriteUrl||'#')}" target="_blank" rel="noopener">Open in Eventbrite ↗</a>`;
    const dirty = !!ev._ebDirty;
    const btns = st==='Published'
      ? `<button type="button" class="btn sm primary" data-act="publish-eb-publish">Update &amp; re-publish</button>`
      : `<button type="button" class="btn sm${dirty?' primary':''}" data-act="publish-eb-draft">Update draft</button><button type="button" class="btn sm${dirty?'':' primary'}" data-act="publish-eb-publish">Publish</button>`;
    const sync = dirty ? `<div class="ndoc-warn">Eventbrite is behind your latest edits — ${st==='Published'?'update &amp; re-publish':'update the draft'} to sync.</div>` : '';
    inner = `${sync}${open} ${btns} ${badge}
      <div class="hint" style="margin-top:6px">On your phone, tap through to Check-In in the Eventbrite Organizer app.</div>`;
  }
  const err = ev.lastPublishError && (ev.publishStatus==='Error') ? `<div class="ndoc-warn">${esc(ev.lastPublishError)}</div>` : '';
  return `<div class="fld full"><label>Eventbrite</label><div class="pubpanel" id="f_publish">${inner}${err}</div></div>`;
}
// Wires (and, after each outerHTML swap, re-wires) the publish panel's click
// handler. Named function instead of arguments.callee so it can rebind itself
// onto the fresh DOM node `outerHTML` produces.
function wirePublishPanel(pub){
  if(!pub) return;
  pub.addEventListener('click', async e=>{
    const b=e.target.closest('[data-act="publish-eb-draft"],[data-act="publish-eb-publish"]'); if(!b) return;
    if(!editing || !editing.id){ toast('Save the event first','err'); return; }
    const draftOnly = b.dataset.act==='publish-eb-draft';
    const rowId=editing.id;
    await flushAutosave();   // ensure Coda has the latest public copy the Worker reads
    pub.innerHTML=`<div class="ndoc-loading"><span class="ndoc-spin"></span> ${draftOnly?'Creating Eventbrite draft':'Publishing to Eventbrite'}… <span class="hint">(a few seconds)</span></div>`;
    try{
      const res=await DB.publishEventbrite(rowId, draftOnly);
      const newStatus = res.draft ? 'Draft' : 'Published';
      if(editing && editing.id===rowId){ editing.eventbriteId=res.eventbriteId||editing.eventbriteId; editing.eventbriteUrl=res.url||editing.eventbriteUrl; editing.publishStatus=newStatus; editing.lastPublishError=''; editing._ebDirty=false; }
      const item=state.events.find(x=>x.id===rowId); if(item){ item.eventbriteId=editing.eventbriteId; item.eventbriteUrl=editing.eventbriteUrl; item.publishStatus=newStatus; }
      if(document.getElementById('f_publish') && (!editing||editing.id===rowId)){ document.getElementById('f_publish').outerHTML=publishPanelHTML(editing,true); wirePublishPanel(document.getElementById('f_publish')); }
      toast(draftOnly?'Eventbrite draft ready':'Published to Eventbrite','ok');
      refresh();
    }catch(err){
      if(editing && editing.id===rowId){ editing.publishStatus='Error'; editing.lastPublishError=(err&&err.message)||'Publish failed'; }
      if(document.getElementById('f_publish')){ document.getElementById('f_publish').outerHTML=publishPanelHTML(editing,true); wirePublishPanel(document.getElementById('f_publish')); }
      if(err && err.status===401 && typeof sessionExpired==='function') sessionExpired();
      else toast((err&&err.message)||'Publish failed','err');
    }
  });
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
  try{ const rows=await DB.listPlanning({fresh:true}); ev=rows.find(x=>x.id===rowId); }catch(_){}
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

/* ---- status state machine (draft → proposed → approved; bail → cancelled) ----
   Status stores 4 states; "Live" (approved + EB published) and "Past" (date has
   passed) are DERIVED for display, not stored. */
function statusInfo(ev){
  if(ev.status==='cancelled') return {label:'Cancelled', cls:'cancelled'};
  if(ev.status==='approved')  return (ev.publishStatus==='Published') ? {label:'Live', cls:'live'} : {label:'Approved', cls:'approved'};
  if(ev.status==='proposed')  return {label:'Proposed', cls:'proposed'};
  return {label:'Draft', cls:'draft'};
}
function isPastEvent(ev){ return ev.scheduling==='exact' && ev.date && ev.date < todayStr && ev.status!=='cancelled'; }
const LINK_ICON = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>`;
// Left-cluster footer transition buttons for an existing event, by state + role.
// canWrite = Program Lead or Council; canApprove = Council. Leads never see Approve.
function footerActionsHTML(ev, canWrite, canApprove){
  if(!ev.id) return '';
  const b=[];
  if(ev.status==='draft'){
    if(canWrite) b.push(`<button class="btn primary sm" data-act="propose">Propose</button>`);
    if(canWrite) b.push(`<button class="btn sm" data-act="cancel">Cancel event</button>`);
  } else if(ev.status==='proposed'){
    if(canApprove) b.push(`<button class="btn primary sm" data-act="approve">Approve</button>`);
    if(canWrite)   b.push(`<button class="btn sm" data-act="cancel">Cancel event</button>`);
  } else if(ev.status==='approved'){
    if(canWrite) b.push(`<button class="btn sm" data-act="cancel">Cancel event</button>`);
  } else if(ev.status==='cancelled'){
    if(canApprove) b.push(`<button class="btn primary sm" data-act="reopen">Reopen</button>`);
  }
  if(canApprove) b.push(`<button class="btn danger sm" data-act="delete">Delete</button>`);
  return b.join('');
}
function openEditor(ev, section){
  editing = ev;
  activeSection = (section && SECTIONS.some(s=>s.id===section)) ? section : 'planning';   // reset per open; honor a deep-linked section
  const isRef = ev.source==='ref';
  const canEdit = !isRef && !!(state.identity && state.identity.canWrite);
  const canApprove = !isRef && !!(state.identity && state.identity.canApprove);
  // Fields are read-only when Cancelled (reopen to edit) or Approved-and-not-Council.
  const locked = (!isRef) && (ev.status==='cancelled' || (ev.status==='approved' && !canApprove));
  const c = isRef ? REF[ev.refLayer].color : progColor(ev.program);
  document.getElementById('mStripe').style.setProperty('--c',c);
  document.getElementById('mTitle').textContent = isRef ? 'Reference event' : (ev.id ? (ev.title||'Untitled') : 'New event');
  const actions=document.getElementById('mActions');
  const body=document.getElementById('mBody');
  document.getElementById('modal').classList.remove('ws','create'); body.classList.remove('ws');   // workspace mode only for the planning editor
  if(isRef){
    const R = REF[ev.refLayer] || {name:'Reference', color:'#888'};
    actions.innerHTML = `<span class="badge b-ref">${esc(R.name)}</span>`;
    const when = ev.allDay ? `All day · ${fmtDate(ev.date)}` : fmtDateTimeRange(ev.start, ev.end);
    body.innerHTML = `
      <div class="fld full"><label>Title</label><input value="${esc(ev.title)}" disabled></div>
      <div class="fld full"><label>When</label><input value="${esc(when)}" disabled></div>
      ${ev.location ? `<div class="fld full"><label>Location</label><input value="${esc(ev.location)}" disabled></div>` : ''}
      ${ev.description ? `<div class="fld full"><label>Description</label><div class="refdesc">${linkify(ev.description)}</div></div>` : ''}
      ${ev.url ? `<div class="fld full"><a class="reflink" href="${esc(ev.url)}" target="_blank" rel="noopener">Open event ↗</a></div>` : ''}
      <div class="fld full"><label>Calendar</label><input value="${esc(R.name)}" disabled></div>
      <div class="locknote">Read-only reference calendar. Toggle it off in the top strip to hide this layer.</div>`;
    document.getElementById('mFoot').innerHTML=`<span class="push"></span><button class="btn" data-act="close">Close</button>`;
    show(); return;
  }

  // header (top-right): derived status badge + copy-link icon (transitions moved
  // to the footer; status is display-only here).
  const si=statusInfo(ev);
  let head = `<span class="badge b-${si.cls}">${si.label}</span>`;
  if(isPastEvent(ev)) head += `<span class="badge b-past">Past</span>`;
  if(ev.id) head += `<button class="mhead-ico" data-act="copylink" title="Copy link" aria-label="Copy link">${LINK_ICON}</button>`;
  actions.innerHTML = head;

  // footer: transition actions on the LEFT (Propose/Approve/Cancel/Reopen +
  // council Delete), save-status on the RIGHT. Dismissal is the header ✕/Esc/scrim.
  const foot=document.getElementById('mFoot');
  let acts = footerActionsHTML(ev, canEdit, canApprove);
  acts += `<span class="push"></span>`;
  if(ev.id && canEdit && !locked) acts += `<span class="savestat clean" id="saveStatus">Saved</span>`;
  foot.innerHTML=acts;

  // workspace: left rail + active-section panel (fixed-height modal; only the panel scrolls)
  document.getElementById('modal').classList.add('ws'); body.classList.add('ws');
  body.innerHTML = `<div class="wsplit"><nav class="wrail" id="wrail">${railHTML()}</nav><div class="wpanel" id="wpanel"></div></div>`;
  renderSection(activeSection, ev, canEdit, locked, canApprove);
  document.getElementById('wrail').addEventListener('click', e=>{
    const b=e.target.closest('[data-sect]'); if(!b) return;
    const id=b.dataset.sect; if(id===activeSection) return;
    if(canEdit && !locked) Object.assign(ev, readForm());   // capture the outgoing section's edits so nothing is lost on switch
    setActiveRail(id); renderSection(id, ev, canEdit, locked, canApprove);
    const sec=SECTIONS.find(s=>s.id===id); if(sec && sec.live && typeof syncUrl==='function') syncUrl(ev, id);
  });

  show();
  if(ev.id) syncUrl(ev, activeSection);
  _lastSavedSnap = (canEdit && !locked && ev.id) ? snap(readForm()) : null;   // baseline so a section-switch focusout doesn't trigger a spurious first save
  if(canEdit && !locked){
    document.getElementById('wpanel').addEventListener('focusout', ()=>scheduleAutosave());
  }
}

/* ---- create flow: a one-shot Planning form in its OWN compact modal ---------
   A brand-new event is NOT the workspace — just the Planning fields with a clear
   Cancel / Create. On Create it persists once (no premature empty rows) and
   transitions into the full workspace via openEditor(savedEvent). */
function openNewEventForm(seed){
  if(!(state.identity && state.identity.canWrite)){ toast('Sign in as a program lead to add events','err'); return; }
  editing = seed;
  _lastSavedSnap = null;
  document.getElementById('mStripe').style.setProperty('--c', progColor(seed.program));
  document.getElementById('mTitle').textContent = 'New event';
  document.getElementById('mActions').innerHTML = '';   // no status/approve until the row exists
  document.getElementById('modal').classList.remove('ws'); document.getElementById('modal').classList.add('create');   // fixed shell = same height as the workspace
  const body=document.getElementById('mBody'); body.classList.remove('ws');
  body.innerHTML = renderPlanning(seed, true, false, false);
  wirePlanning(body, seed, true, false, false);
  document.getElementById('mFoot').innerHTML =
    `<span class="push"></span><button class="btn" data-act="close">Cancel</button><button class="btn primary" data-act="create">Create</button>`;
  show();
  const t=document.getElementById('f_title'); if(t) t.focus();
}
async function createFromForm(){
  if(_saving) return;
  const f=readForm();
  const me=(state.identity && state.identity.name) || '';
  const e=Object.assign({}, {source:'planning', eventbriteUrl:'', gcalId:'', createdBy:me, editedBy:me}, f);
  e.id='tmp-'+Date.now();
  _saving=true; applyLocal(e); rerender(); toast('Creating…','busy');
  try{
    const saved=await DB.create(e);
    if(saved && saved.id && saved.id!==e.id){ applyLocal(e, true); e.id=saved.id; applyLocal(e); }  // swap temp → real id
    markRecent(e.id, {e}); rerender(); toast('Created','ok'); scheduleReconcile();
    _saving=false;
    openEditor(e);                 // land in the workspace for the just-created event
  }catch(err){
    applyLocal(e, true); rerender(); _saving=false;
    if(err && err.status===401) sessionExpired();
    else toast('Create failed — try again','err');   // leave the create modal open; input is preserved
  }
}

/* ---- URL deep-linking: ?event=<rowId>&section=<id>, two-way synced ---------- */
function syncUrl(ev, section){
  if(!ev || !ev.id) return;
  const u=new URL(location.href);
  u.searchParams.set('event', ev.id); u.searchParams.set('section', section||activeSection);
  history.replaceState(null,'',u);
}
function clearUrl(){
  const u=new URL(location.href);
  if(!u.searchParams.has('event') && !u.searchParams.has('section')) return;
  u.searchParams.delete('event'); u.searchParams.delete('section');
  history.replaceState(null,'',u);
}
// Open the event named in the URL (once events are loaded). Silent if absent.
function openFromUrl(){
  const p=new URL(location.href).searchParams;
  const id=p.get('event'); if(!id) return;
  const ev=state.events.find(x=>x.id===id); if(!ev) return;
  openEditor(ev, p.get('section')||'planning');
}

/* ---- editor workspace: rail + section panels ------------------------------
   The planning editor is a rail of sections. Two are live (Planning / Publish);
   the rest render a muted "coming soon" teaser. Each section owns its own render
   (markup) + wire (post-render listeners) pair. Field ids stay globally unique
   within the open editor, so readForm()/collectWhen() still find them by id. */
function railHTML(){
  const item = s=>`<button type="button" class="wrail-item${s.id===activeSection?' on':''}${s.live?'':' soon'}" data-sect="${s.id}">${esc(s.label)}</button>`;
  const live=SECTIONS.filter(s=>s.live), soon=SECTIONS.filter(s=>!s.live);
  return live.map(item).join('') + `<div class="wrail-soon">Coming soon…</div>` + soon.map(item).join('');
}
function setActiveRail(id){ activeSection=id; document.querySelectorAll('#wrail .wrail-item').forEach(b=>b.classList.toggle('on', b.dataset.sect===id)); }

function renderSection(id, ev, canEdit, locked, canApprove){
  const panel=document.getElementById('wpanel'); if(!panel) return;
  const sec=SECTIONS.find(s=>s.id===id);
  if(sec && !sec.live){ panel.innerHTML=comingSoonHTML(sec); if(typeof wireFeedback==='function') wireFeedback(panel, id); return; }
  if(id==='publish'){ panel.innerHTML=renderPublish(ev, canEdit, locked); wirePublish(panel, ev, canEdit, locked); return; }
  if(id==='volunteers'){ panel.innerHTML=renderSlots(ev, canEdit); wireSlots(panel, ev, canEdit); return; }
  panel.innerHTML=renderPlanning(ev, canEdit, locked, canApprove); wirePlanning(panel, ev, canEdit, locked, canApprove);
}

/* Planning section — every planning field EXCEPT capacity / address-visibility /
   the publish panel (those live in Publish now). `#whenFields` is filled by
   wirePlanning after render. */
function renderPlanning(ev, canEdit, locked, canApprove){
  const dis = (!canEdit || locked) ? 'disabled' : '';
  const sched = ev.scheduling || 'exact';
  return `
    <div class="fld full"><label>Title</label><input id="f_title" value="${esc(ev.title)}" ${dis} placeholder="e.g. Kabbalat Shabbat"></div>
    <div class="fld full"><label>Internal description <span class="hint">(planning copy — not shown publicly)</span></label><textarea id="f_desc" ${dis} placeholder="What's the plan?">${esc(ev.description||'')}</textarea></div>
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
}

function wirePlanning(panel, ev, canEdit, locked, canApprove){
  const sched = ev.scheduling || 'exact';
  // leads (leadership cohort) + volunteers (all people) + venue typeaheads
  const resolveIds = (ids, names) => (ids && ids.length) ? ids : (names||[]).map(n=>peopleIdByName[n]).filter(Boolean);
  const leadsBox=document.getElementById('f_leads'); if(leadsBox) initTypeahead(leadsBox, { selected:resolveIds(ev.leads, ev.leadNames), pool:()=>LEADS_LIST, onChange:scheduleAutosave });
  const volBox=document.getElementById('f_vols');   if(volBox)   initTypeahead(volBox,   { selected:resolveIds(ev.volunteers, ev.volunteerNames), pool:()=>PEOPLE_LIST, onChange:scheduleAutosave });
  const venBox=document.getElementById('f_venue_box'); if(venBox) initVenuePicker(venBox, ev, { onChange:scheduleAutosave });

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
      scheduleAutosave();
    });
    // Where: venue-type switcher (single-select) — filters the venue typeahead pool
    document.getElementById('f_vtype_seg').addEventListener('click', e=>{
      const b=e.target.closest('button[data-vtype]'); if(!b) return;
      [...b.parentElement.children].forEach(x=>x.setAttribute('aria-pressed', x===b));
      scheduleAutosave();
    });
  }

  // when control: mode switch + all-day toggle both re-render the time fields
  whenType = sched;
  const wf=document.getElementById('whenFields');
  wf.innerHTML = whenFieldsHTML(whenType, ev, (!canEdit || locked) ? 'disabled' : '');
  if(canEdit && !locked){
    document.getElementById('f_when').addEventListener('click',e=>{
      const b=e.target.closest('button[data-when]'); if(!b) return;
      const cur=collectWhen();
      whenType=b.dataset.when;
      [...b.parentElement.children].forEach(x=>x.setAttribute('aria-pressed', x===b));
      wf.innerHTML=whenFieldsHTML(whenType, Object.assign({},ev,cur), '');
      scheduleAutosave();
    });
    wf.addEventListener('change', e=>{                 // All-day toggled → show/hide the times
      if(e.target.id!=='f_allday') return;
      wf.innerHTML=whenFieldsHTML('exact', Object.assign({},ev,collectWhen()), '');
      scheduleAutosave();
    });
  }
}

/* Publish section — public listing copy + capacity + address visibility + the
   Eventbrite publish panel. Only meaningful once the event is approved. */
function renderPublish(ev, canEdit, locked){
  if(ev.status!=='approved') return `<div class="fld full"><div class="locknote">Approve this event under Planning to publish it to Eventbrite.</div></div>`;
  const dis=(!canEdit||locked)?'disabled':'';
  return `
    <div class="fld full"><label>Public summary <span class="hint">(≤140, shows on Eventbrite)</span></label><input id="f_pubsummary" maxlength="140" value="${esc(ev.publicSummary||'')}" ${dis} placeholder="One-line blurb for the listing"></div>
    <div class="fld full"><label>Public description <span class="hint">(listing body)</span> <button type="button" class="btn xs" data-act="copy-internal" ${dis}>Copy from internal</button></label><textarea id="f_pubdesc" rows="4" ${dis} placeholder="What attendees see on Eventbrite">${esc(ev.publicDescription||'')}</textarea></div>
    <div class="fld"><label>Capacity</label><input id="f_capacity" type="number" min="0" step="1" value="${ev.capacity!==''&&ev.capacity!=null?esc(ev.capacity):''}" ${dis} placeholder="e.g. 40"></div>
    <div class="fld"><label>Address on listing</label><div class="whenseg" id="f_addrvis"><button type="button" data-addrvis="Public" aria-pressed="${(ev.addressVisibility||'Public')==='Public'}" ${dis}>Public</button><button type="button" data-addrvis="Registrants only" aria-pressed="${ev.addressVisibility==='Registrants only'}" ${dis}>Registrants only</button></div></div>
    ${publishPanelHTML(ev, canEdit && !locked)}`;
}
function wirePublish(panel, ev, canEdit, locked){
  const ci=panel.querySelector('[data-act="copy-internal"]');
  if(ci) ci.addEventListener('click', ()=>{ const t=panel.querySelector('#f_pubdesc'); if(t){ t.value=(editing&&editing.description)||''; scheduleAutosave(); } });
  const av=panel.querySelector('#f_addrvis');
  if(av && canEdit && !locked) av.addEventListener('click', e=>{ const b=e.target.closest('button[data-addrvis]'); if(!b) return; [...b.parentElement.children].forEach(x=>x.setAttribute('aria-pressed', x===b)); scheduleAutosave(); });
  wirePublishPanel(panel.querySelector('#f_publish'));
}

function comingSoonHTML(sec){
  return `<div class="soon-teaser"><div class="soon-h">${esc(sec.label)} — coming soon</div><div class="hint">On our roadmap. Tell us what you'd want here, or +1 an idea below.</div>${typeof feedbackBoardHTML==='function'?feedbackBoardHTML(sec.id):''}</div>`;
}

/* ---- Volunteers & potluck: the gather slot builder ------------------------
   Leads author sign-up slots (Potluck dishes / Volunteer roles) on a SAVED event;
   members fill them in the gather app. Slots persist to EST Slots SRC via the
   lead-gated /slots routes. Read-only for non-writers; needs a Coda row id. */
function renderSlots(ev, canEdit){
  if(!ev.id) return `<div class="slots-wrap"><div class="soon-teaser"><div class="soon-h">Volunteers & potluck</div><div class="hint">Save the event first, then add sign-up slots here.</div></div></div>`;
  return `<div class="slots-wrap" id="f_slots">
      <p class="hint">Add potluck dishes or volunteer roles. These go live to members in <b>gather</b> once the event is published — once approved, leads &amp; council can already preview them there.</p>
      <div class="slots-list" aria-live="polite"><div class="hint">Loading slots…</div></div>
      ${canEdit ? `<form class="slot-add" autocomplete="off">
        <div class="whenseg" id="f_slotkind">
          <button type="button" data-kind="Potluck" aria-pressed="true">Potluck</button>
          <button type="button" data-kind="Volunteer" aria-pressed="false">Volunteer</button>
        </div>
        <div class="slot-add-row">
          <input class="slot-label" type="text" placeholder="e.g. Dessert, Setup 5–6pm" maxlength="80" required>
          <input class="slot-qty" type="number" min="1" max="99" value="1" title="How many needed" aria-label="How many needed">
          <button class="btn sm primary" type="submit">Add</button>
        </div>
      </form>` : `<p class="hint">Only program leads can edit slots.</p>`}
    </div>`;
}
async function wireSlots(panel, ev, canEdit){
  const wrap=panel.querySelector('#f_slots'); if(!wrap) return;
  const list=wrap.querySelector('.slots-list'); if(!list) return;   // save-first teaser has no list
  let slots=[];
  // Optimistic overlay (mirrors the planning _recent stack): every mutation paints
  // immediately, and a delayed reconcile pulls server truth. Coda reads are
  // eventually consistent, so a refetch right after a write often misses the new
  // row — `recent` keeps just-changed slots alive until the server catches up.
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
  const paint=()=>{
    if(!slots.length){ list.innerHTML=`<div class="hint">No slots yet.${canEdit?' Add one below.':''}</div>`; return; }
    list.innerHTML=slots.map((s,i)=>`
      <div class="slot-item" data-id="${esc(s.id)}">
        <span class="slot-kind ${s.kind==='Volunteer'?'vol':'pot'}">${esc(s.kind||'')}</span>
        <span class="slot-name">${esc(s.label||'')}</span>
        <span class="slot-need">×${s.neededQty||1}</span>
        ${canEdit?`<span class="slot-ctl">
          <button type="button" class="iconbtn" data-move="-1" ${i===0?'disabled':''} title="Move up" aria-label="Move up">↑</button>
          <button type="button" class="iconbtn" data-move="1" ${i===slots.length-1?'disabled':''} title="Move down" aria-label="Move down">↓</button>
          <button type="button" class="iconbtn del" data-del title="Remove" aria-label="Remove">×</button>
        </span>`:''}
      </div>`).join('');
  };
  const sortPaint=()=>{ slots.sort((a,b)=>(a.sortOrder||0)-(b.sortOrder||0)); paint(); };
  const load=async()=>{
    try{ slots=merge(await DB.listSlots(ev.id)); }
    catch(err){ if(!slots.length) list.innerHTML=`<div class="hint err">Couldn't load slots: ${esc(err.message||'')}</div>`; return; }
    sortPaint();
  };
  let _reconT;
  const reconcile=()=>{ clearTimeout(_reconT); _reconT=setTimeout(load, 2500); };   // let Coda index, then pull server truth
  const form=wrap.querySelector('.slot-add');
  if(form && canEdit){
    let kind='Potluck';
    const kseg=form.querySelector('#f_slotkind');
    kseg.addEventListener('click', e=>{ const b=e.target.closest('button[data-kind]'); if(!b) return; kind=b.dataset.kind; [...kseg.children].forEach(x=>x.setAttribute('aria-pressed', String(x===b))); });
    form.addEventListener('submit', async e=>{
      e.preventDefault();
      const labEl=form.querySelector('.slot-label'), qtyEl=form.querySelector('.slot-qty');
      const label=labEl.value.trim(); if(!label) return;
      const neededQty=Math.max(1, Math.min(99, parseInt(qtyEl.value,10)||1));
      const sortOrder=(slots.length?Math.max(...slots.map(s=>s.sortOrder||0)):0)+1;
      const btn=form.querySelector('button[type=submit]'); btn.disabled=true;
      try{
        const r=await DB.createSlot({event:ev.id, kind, label, neededQty, sortOrder});
        const s={id:(r&&r.id)||`tmp-${Date.now()}`, event:ev.id, kind, label, neededQty, sortOrder};
        slots.push(s); remember(s.id,{slot:s}); sortPaint();          // show it now; server read lags
        labEl.value=''; qtyEl.value='1'; labEl.focus(); reconcile();
      }
      catch(err){ toast(err.message||'Could not add slot','err'); }
      finally{ btn.disabled=false; }
    });
  }
  if(canEdit) list.addEventListener('click', async e=>{
    const row=e.target.closest('.slot-item'); if(!row) return; const id=row.dataset.id;
    if(e.target.closest('[data-del]')){
      const gone=slots.find(s=>s.id===id); if(!gone) return;
      slots=slots.filter(s=>s.id!==id); remember(id,{deleted:true}); paint();   // drop it now
      try{ await DB.removeSlot(id); reconcile(); }
      catch(err){ recent.delete(id); slots.push(gone); sortPaint(); toast(err.message||'Could not remove','err'); }
      return;
    }
    const mv=e.target.closest('[data-move]');
    if(mv){
      const dir=parseInt(mv.dataset.move,10), i=slots.findIndex(s=>s.id===id), j=i+dir;
      if(i<0||j<0||j>=slots.length) return;
      const a=slots[i], b=slots[j], ao=a.sortOrder||0, bo=b.sortOrder||0;
      a.sortOrder=bo; b.sortOrder=ao; remember(a.id,{slot:a}); remember(b.id,{slot:b}); sortPaint();   // swap now
      try{ await Promise.all([DB.updateSlot(a.id,{sortOrder:bo}), DB.updateSlot(b.id,{sortOrder:ao})]); reconcile(); }
      catch(err){ a.sortOrder=ao; b.sortOrder=bo; recent.delete(a.id); recent.delete(b.id); sortPaint(); toast(err.message||'Could not reorder','err'); }
    }
  });
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

function readForm(){
  // Fields now live in whichever section is rendered — so any field may be
  // absent from the DOM. For every read, fall back to `editing.<field>` when its
  // element isn't present, so a save from a section that doesn't own that field
  // never throws and never wipes the stored value.
  const g=id=>document.getElementById(id);
  const chipIds=sel=>[...document.querySelectorAll(sel)].map(c=>c.dataset.id);
  const hasProgs=!!g('f_progs');
  const programs=hasProgs
    ? [...document.querySelectorAll('#f_progs .leadchip')].filter(b=>b.getAttribute('aria-pressed')==='true').map(b=>b.dataset.p)
    : ((editing&&editing.programs&&editing.programs.length) ? editing.programs.slice() : ((editing&&editing.program)?[editing.program]:[]));
  const leads=g('f_leads') ? chipIds('#f_leads .ta-chip') : ((editing&&editing.leads)||[]);
  const volunteers=g('f_vols') ? chipIds('#f_vols .ta-chip') : ((editing&&editing.volunteers)||[]);
  const venBox=g('f_venue_box'), venOther=venBox && venBox.querySelector('.venue-other-wrap');
  const venue=venBox ? (venBox.dataset.venueId||'') : ((editing&&editing.venue)||'');
  const venueOther=venBox ? ((venOther && !venOther.hidden) ? venBox.querySelector('.venue-other').value.trim() : '') : ((editing&&editing.venueOther)||'');
  const vtBtn=document.querySelector('#f_vtype_seg button[aria-pressed="true"]');
  const venueType=g('f_vtype_seg') ? (vtBtn ? (vtBtn.dataset.vtype||'') : '') : ((editing&&editing.venueType)||'');
  const whenRendered=!!g('f_when');
  const wt=whenRendered ? whenType : ((editing&&editing.scheduling)||'exact');
  const w=whenRendered ? collectWhen() : {};
  const exact=wt==='exact';
  const allDay= exact ? (whenRendered ? !!w.allDay : !!(editing&&editing.allDay)) : true;   // range/month are all-day
  const capEl=g('f_capacity');
  const o={
    program:programs[0]||'oth', programs,
    status:g('f_status') ? g('f_status').value : ((editing&&editing.status)||'draft'),
    title:g('f_title') ? (g('f_title').value.trim()||'Untitled') : ((editing&&editing.title)||'Untitled'),
    allDay,
    start:(exact && !allDay) ? (whenRendered ? (w.start||'') : ((editing&&editing.start)||'')) : '',
    end:(exact && !allDay) ? (whenRendered ? (w.end||'') : ((editing&&editing.end)||'')) : '',
    leads, volunteers, venueType, venue, venueOther,
    location:(venue ? ((VENUES.find(v=>v.id===venue)||{}).name||'') : '') || venueOther,   // display fallback
    description:g('f_desc') ? g('f_desc').value.trim() : ((editing&&editing.description)||''),
    planningNotes:(editing && editing.planningNotes)||'',
    capacity: capEl ? (capEl.value.trim()!=='' ? Number(capEl.value) : '') : ((editing&&editing.capacity!=null)?editing.capacity:''),
    addressVisibility: (document.querySelector('#f_addrvis button[aria-pressed="true"]')?.dataset.addrvis) || (editing && editing.addressVisibility) || 'Public',
    publicSummary:(g('f_pubsummary')?g('f_pubsummary').value:(editing&&editing.publicSummary)||''),
    publicDescription:(g('f_pubdesc')?g('f_pubdesc').value:(editing&&editing.publicDescription)||''),
    publishStatus:(editing&&editing.publishStatus)||'Unpublished', eventbriteId:(editing&&editing.eventbriteId)||'', eventbriteUrl:(editing&&editing.eventbriteUrl)||'', lastPublishError:(editing&&editing.lastPublishError)||'',
    scheduling:wt, date:'', rangeStart:'', rangeEnd:'', targetMonth:''
  };
  if(exact) o.date = whenRendered ? (w.date||'') : ((editing&&editing.date)||'');
  else if(wt==='range'){
    if(whenRendered){ o.rangeStart=w.rangeStart||''; o.rangeEnd=w.rangeEnd||w.rangeStart||''; }
    else { o.rangeStart=(editing&&editing.rangeStart)||''; o.rangeEnd=(editing&&editing.rangeEnd)||''; }
  }
  else if(wt==='month') o.targetMonth = whenRendered ? (w.targetMonth||'') : ((editing&&editing.targetMonth)||'');
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

/* ---- workspace auto-save (existing events) --------------------------------
   Every editable workspace field saves on blur, debounced, in place — the modal
   stays open (unlike saveEditor, which closes). Reuses the optimistic stack
   (applyLocal/markRecent/_recent guard/scheduleReconcile). No-op saves are
   skipped by diffing readForm() against the last-saved snapshot. */
let _autosaveT=null, _lastSavedSnap=null;
const snap = f => JSON.stringify(f);
function setSaveStatus(s){                     // 'clean' | 'dirty' | 'saving' | 'error'
  const el=document.getElementById('saveStatus'); if(!el) return;
  el.className='savestat '+s;
  el.textContent = s==='saving'?'Saving…' : s==='error'?'Save failed — retry' : s==='dirty'?'Unsaved changes' : 'Saved';
}
function scheduleAutosave(){
  if(!editing || !editing.id) return;          // create modal / read-only: nothing to auto-save into
  setSaveStatus('dirty');
  clearTimeout(_autosaveT); _autosaveT=setTimeout(()=>autosaveEditor(), 800);
}
async function flushAutosave(){ clearTimeout(_autosaveT); if(editing && editing.id) await autosaveEditor(); }
async function autosaveEditor(){
  if(!editing || !editing.id) return;
  if(_saving){ clearTimeout(_autosaveT); _autosaveT=setTimeout(()=>autosaveEditor(), 300); return; }  // coalesce behind an in-flight save
  const f=readForm();
  if(_lastSavedSnap && snap(f)===_lastSavedSnap){ setSaveStatus('clean'); return; } // nothing changed
  markEbDirtyIfPublicChanged(f);
  Object.assign(editing, f);
  editing.editedBy=(state.identity && state.identity.name) || editing.editedBy;
  _saving=true; setSaveStatus('saving');
  applyLocal(editing); markRecent(editing.id, {e:editing}); rerender();   // reflect in the calendar behind the modal
  try{ await DB.update(editing); _lastSavedSnap=snap(f); setSaveStatus('clean'); scheduleReconcile(); }
  catch(err){ if(err && err.status===401) sessionExpired(); else { setSaveStatus('error'); console.warn('autosave failed:', err); } }
  finally{ _saving=false; }
}
// EB draft/listing goes out of sync when a public-facing field changes after a
// push. Session-local flag (resets on reload — see design's accepted limitation).
const EB_PUBLIC_KEYS=['publicSummary','publicDescription','capacity','addressVisibility','title','date','start','end','venue'];
function markEbDirtyIfPublicChanged(f){
  if(!editing || !editing.eventbriteId) return;
  if(EB_PUBLIC_KEYS.some(k=>String(editing[k]??'')!==String(f[k]??''))) editing._ebDirty=true;
}
function applyLocal(e, remove){
  const i=state.events.findIndex(x=>x.id===e.id);
  if(remove){ if(i>=0) state.events.splice(i,1); return; }
  if(i>=0) state.events[i]=e; else state.events.push(e);
}
// Lifecycle transition (Propose/Approve/Reopen). Captures current field edits +
// the new status in one write, then rebuilds the editor so locked/footer/publish
// reflect the new state. Cancel is separate (it tears down Eventbrite).
async function transitionTo(status){
  if(_saving || !editing || !editing.id) return;
  clearTimeout(_autosaveT);
  const prev=Object.assign({}, editing);
  if(document.getElementById('wpanel')) Object.assign(editing, readForm());   // fold in pending field edits
  editing.status=status;
  editing.editedBy=(state.identity && state.identity.name) || editing.editedBy;
  _saving=true; applyLocal(editing); rerender(); toast(status==='approved'?'Approving…':'Saving…','busy');
  try{
    await DB.update(editing); _lastSavedSnap=null; markRecent(editing.id,{e:editing});
    toast(status==='approved'?'Approved':(status==='draft'?'Reopened':'Proposed'),'ok'); scheduleReconcile();
    _saving=false; openEditor(editing, activeSection);
  }catch(err){
    Object.assign(editing, prev); applyLocal(editing); rerender(); _saving=false;
    if(err && err.status===401) sessionExpired();
    else { toast('Update failed — reverted','err'); console.warn('transition failed:', err); openEditor(editing, activeSection); }
  }
}
// Cancel: set Status=Cancelled AND tear down the Eventbrite listing (Worker
// unpublishes, or cancels if it has registrants). Works with or without an EB id.
async function cancelEvent(){
  if(_saving || !editing || !editing.id) return;
  if(!confirm('Cancel this event?' + (editing.eventbriteId ? ' Its Eventbrite listing will be taken down.' : ''))) return;
  clearTimeout(_autosaveT);
  const prev=Object.assign({}, editing);
  _saving=true; editing.status='cancelled'; editing._ebDirty=false; applyLocal(editing); rerender(); toast('Cancelling…','busy');
  try{
    const res=await DB.cancelEventbrite(editing.id);
    if(res && res.publishStatus) editing.publishStatus=res.publishStatus;
    _lastSavedSnap=null; markRecent(editing.id,{e:editing}); toast('Event cancelled','ok'); scheduleReconcile();
    _saving=false; openEditor(editing, activeSection);
  }catch(err){
    Object.assign(editing, prev); applyLocal(editing); rerender(); _saving=false;
    if(err && err.status===401) sessionExpired();
    else { toast((err&&err.message)||'Cancel failed','err'); openEditor(editing, activeSection); }
  }
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
function close(){
  _ndocGen++; clearTimeout(_autosaveT);
  // Flush a pending/failed edit before tearing down so a fast Done/Esc/✕ doesn't
  // drop the last change. autosaveEditor runs its prelude synchronously (reading
  // `editing` and firing DB.update) before we null it below; not awaited.
  const st=document.getElementById('saveStatus');
  if(editing && editing.id && st && (st.classList.contains('dirty')||st.classList.contains('error'))) autosaveEditor();
  document.getElementById('scrim').classList.remove('open');
  document.getElementById('modal').classList.remove('ws','create'); document.getElementById('mBody').classList.remove('ws');
  editing=null; clearUrl();
}

document.getElementById('scrim').addEventListener('click',e=>{ if(e.target.id==='scrim') close(); });
document.getElementById('mClose').addEventListener('click', close);   // dedicated top-right ✕ (avoids mis-hitting Approve)
document.addEventListener('keydown',e=>{ if(e.key==='Escape') close(); });

document.getElementById('mFoot').addEventListener('click',e=>{
  if(e.target.id==='saveStatus' && e.target.classList.contains('error')){ flushAutosave(); return; }
  const act=e.target.closest('[data-act]')?.dataset.act; if(!act) return;
  if(act==='close') close();
  else if(act==='create') createFromForm();
  else if(act==='propose') transitionTo('proposed');
  else if(act==='approve') transitionTo('approved');
  else if(act==='cancel') cancelEvent();
  else if(act==='reopen') transitionTo('draft');
  else if(act==='delete') deleteEditor();
});
// header actions: copy-link icon (status is display-only; transitions are in the footer)
document.getElementById('mActions').addEventListener('click',e=>{
  const act=e.target.closest('[data-act]')?.dataset.act; if(!act) return;
  if(act==='copylink'){ navigator.clipboard.writeText(location.href).then(()=>toast('Link copied','ok'), ()=>toast('Copy failed','err')); }
});
document.getElementById('mBody').addEventListener('click',e=>{
  if(e.target.closest('[data-act="coda"]')){ e.preventDefault(); alert('Live version: deep-links to this row in the Mission Control Coda doc for full editing (ticketing, banner, promotion).'); }
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
  const cell=e.target.closest('.cell'); if(!cell) return;
  openNewEventForm(newEventOn(cell.dataset.date));
});

document.getElementById('quarter').addEventListener('click',e=>{
  const chip=e.target.closest('.qchip');
  if(chip){ const ev=state.events.find(x=>x.id===chip.dataset.id); if(ev) openEditor(ev); return; }
  const z=e.target.closest('.qzone'); if(z && z.dataset.add) openNewEventForm(newEventOn(z.dataset.add));
});

function newEventOn(date){
  return {id:null,source:'planning',program:'',programs:[],title:'',leads:[],date,start:'18:30',end:'20:00',allDay:false,location:'',status:'draft',description:'',scheduling:'exact',rangeStart:'',rangeEnd:'',targetMonth:'',createdBy:state.currentUser,editedBy:state.currentUser,eventbriteUrl:'',gcalId:''};
}
function newIdeaInMonth(mkey){
  return {id:null,source:'planning',program:'oth',title:'',leads:[],date:'',start:'',end:'',allDay:false,location:'',status:'draft',description:'',scheduling:'month',rangeStart:'',rangeEnd:'',targetMonth:mkey,createdBy:state.currentUser,editedBy:state.currentUser,eventbriteUrl:'',gcalId:''};
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

/* feedback / ideas modal */
document.getElementById('feedbackBtn').addEventListener('click', ()=>{
  editing={id:'__feedback__'};
  document.getElementById('modal').classList.remove('ws'); document.getElementById('mBody').classList.remove('ws');
  document.getElementById('mStripe').style.setProperty('--c','var(--accent)');
  document.getElementById('mTitle').textContent='Feedback & ideas';
  document.getElementById('mActions').innerHTML=''; document.getElementById('mFoot').innerHTML=`<span class="push"></span><button class="btn" data-act="close">Close</button>`;
  const body=document.getElementById('mBody'); body.innerHTML=`<div class="fld full"><div class="hint">Suggest anything, or +1 an idea. For section-specific ideas, open an event and visit that section.</div>${feedbackBoardHTML('General')}</div>`;
  wireFeedback(body,'General'); show();
});

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
document.getElementById('addBtn').addEventListener('click',()=>openNewEventForm(newEventOn(inProgramYear(todayStr)?todayStr:firstOfProgramYear())));
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
  } else if(state.authPending){
    // Gap between returning from Google and /me resolving — show progress, not the
    // (stale) sign-in button, so it doesn't look like nothing happened.
    el.innerHTML = `<span class="signingin"><span class="ndoc-spin"></span> Signing in…</span>`;
  } else {
    el.innerHTML = `<div class="acct">
        <button class="btn ghost" id="signInBtn">Sign in</button>
        <div class="acct-menu" id="signInMenu" role="menu" hidden>
          <button class="btn ghost" id="googleBtn" role="menuitem">Continue with Google</button>
          <div class="signin-or">or</div>
          <form id="emailLinkForm" class="signin-email">
            <input id="emailLinkInput" type="email" required placeholder="you@email.com" autocomplete="email">
            <button class="btn primary sm" type="submit">Email me a link</button>
          </form>
        </div>
      </div>`;
    el.querySelector('#signInBtn').addEventListener('click', e=>{ e.stopPropagation(); const m=el.querySelector('#signInMenu'); m.hidden=!m.hidden; });
    el.querySelector('#googleBtn').addEventListener('click', async ()=>{ try{ await window.estAuth.signInWithGoogle(); }catch(err){ toast('Google sign-in failed','err'); } });
    el.querySelector('#emailLinkForm').addEventListener('submit', async e=>{
      e.preventDefault();
      const email = el.querySelector('#emailLinkInput').value.trim();
      if(!email) return;
      try{ await window.estAuth.sendEmailLink(email); toast('Check your email for a sign-in link'); el.querySelector('#signInMenu').hidden=true; }
      catch(err){ toast('Could not send sign-in link','err'); }
    });
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
  if(!PROXY_BASE || !state.idToken){ state.identity=null; state.authPending=false; renderAuth(); return; }
  try{
    const r = await fetch(`${PROXY_BASE}/me`, { headers:{ 'Authorization':`Bearer ${state.idToken}` } });
    if(r.ok){ state.identity = await r.json(); }
    else { state.identity = null; if(r.status===401){ state.idToken=null; } } // token rejected -> drop it; Firebase re-yields on next refresh
  }catch(_){ state.identity=null; }               // transient network error: keep the token, try again later
  state.authPending=false;
  renderAuth(); applyView();
}
// Called by estAuth whenever Firebase yields a (refreshed) ID token.
async function onFirebaseToken(token){ state.idToken = token || null; state.authPending = !!token; renderAuth(); await fetchMe(); }
function onFirebaseSignedOut(){ state.idToken=null; state.identity=null; state.authPending=false; renderAuth(); applyView(); }
function sessionExpired(){ toast('Session expired — please sign in again','err'); onFirebaseSignedOut(); }
async function signOut(){ try{ await window.estAuth.signOut(); }catch(_){} }   // onFirebaseSignedOut clears state

function initAuth(){
  const start = () => {
    window.estAuth.init({ onToken: onFirebaseToken, onSignedOut: onFirebaseSignedOut });
    window.estAuth.completeEmailLinkIfPresent().catch(()=>{});   // finish a magic-link return, if any
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
  document.getElementById('ovfBtn').addEventListener('click', e=>{ e.stopPropagation(); ovfMenu(); });
  headerMQ.addEventListener('change', applyHeaderMode);
  applyHeaderMode();
  // Wire refresh/focus/poll up front so they work immediately (never dead while loading).
  const rb = document.getElementById('refreshBtn'); if(rb) rb.addEventListener('click', refresh);
  document.addEventListener('visibilitychange', () => { if(!document.hidden){ refresh(); } }); // refetch on tab focus
  setInterval(() => { if(!document.hidden){ refresh(); } }, 60000);    // light 60s poll while visible

  // Kick off ref loads — each hydrates its maps synchronously from cache, then
  // refreshes in the background. loadPeople is the slow one (/ref/people is many
  // seconds) so it is NOT awaited — the calendar doesn't need it (leads/venues
  // resolve in the editor via cached maps / stored names).
  loadPrograms(); loadVenues(); loadPeople();
  // Instant paint from the last cached events (maps are hydrated above).
  const cachedRows = cacheGet('rows-raw');
  const cachedRefs = cacheGet('references');
  if(cachedRefs && cachedRefs.layers){ rebuildRefs(cachedRefs.layers); renderLayers(); }
  if(cachedRows && cachedRows.length){ state.events = [...cachedRows.map(planningRowToEvent), ...((cachedRefs&&cachedRefs.events)||[])]; applyView(); layoutSticky(); }
  // Fresh events (renders as soon as /rows returns).
  await refresh();
  openFromUrl();                 // deep-link: ?event=<id>&section=<id> opens that event
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
// Reference-event datetime formatting. `iso` is a UTC (…Z) or naive datetime;
// rendered in the viewer's local time zone (EST leaders are in Nashville).
function fmtTime(iso){ return new Date(iso).toLocaleTimeString([], {hour:'numeric', minute:'2-digit'}); }
function fmtDateTimeAt(iso){ const d=new Date(iso); return `${WD[d.getDay()]}, ${MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()} · ${fmtTime(iso)}`; }
function fmtDateTimeRange(startIso, endIso){
  if(!startIso) return '';
  const start=fmtDateTimeAt(startIso);
  if(!endIso) return start;
  const sd=new Date(startIso), ed=new Date(endIso);
  return sd.toDateString()===ed.toDateString() ? `${start} – ${fmtTime(endIso)}` : `${start} – ${fmtDateTimeAt(endIso)}`;
}
// Escape text, then turn bare URLs into safe links (used for ref descriptions).
function linkify(text){ return esc(text).replace(/(https?:\/\/[^\s<]+)/g, u=>`<a href="${u}" target="_blank" rel="noopener">${u}</a>`); }

init();
