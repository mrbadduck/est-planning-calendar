/* data.js — reference lists (programs, people, venues, refs), the local cache, the
   Coda row <-> event seam (planningRowToEvent / eventToCodaCells) and CodaSource (DB).
   Owns: PROGRAMS, PROG, REF_LAYERS, REF, rebuildRefs, _live, progColor, cacheGet, loadPrograms, loadPeople, loadVenues, refreshVenues, PEOPLE_LIST, LEADS_LIST, peopleById, peopleIdByName, VENUES, VENUE_TYPES, PROXY_BASE, mapRelations, planningRowToEvent, eventToCodaCells, venueTypeIdByName, DB
   Reads: state.layers, state.idToken (state.js; only when called, not at load)
   Writes: state.layers (rebuildRefs)
   Loaded after: editor-head.js (nothing needed at load) */

/* =========================================================================
   DATA LAYER  —  the only part that changes when we go live on Coda.
   Everything below `DataSource` treats events in one normalized shape:
     { id, source, program, title, leads:[], date:'YYYY-MM-DD',
       start, end, allDay, location, status, description,
       createdBy, editedBy, approvedBy, approvedAt, lastPublishedAt, lastEbPushAt, readOnly, eventbriteUrl, gcalId }
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
  for(const l of REF_LAYERS){ if(!(l.id in state.layers)) state.layers[l.id] = savedLayer(l.id) ?? l.on; }
}

let progIdByName = Object.fromEntries(PROGRAMS.map(p=>[p.name,p.id]));
// Which reference lists hold real rows yet (from the local cache or the network).
// Until they all do, relation names can't be mapped to row ids — see mapRelations.
const _live = { programs:false, people:false, venues:false, venueTypes:false };
/* live programs: replace the built-in palette with the real EST Programs SRC set */
function genColor(i,n){ return `hsl(${Math.round(i*360/Math.max(n,1))}, 50%, 55%)`; }
function rebuildPrograms(list){
  PROGRAMS = list.concat([{id:'oth', name:'Other', color:'#888'}]);
  PROG = Object.fromEntries(PROGRAMS.map(p=>[p.id,p]));
  progIdByName = Object.fromEntries(PROGRAMS.map(p=>[p.name,p.id]));
  _live.programs = true;
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
    if(list.length){ rebuildPrograms(list); cacheSet('programs', list); onRefsLoaded(); }
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
  _live.people = true;
}
async function loadPeople(){
  const c = cacheGet('people'); if(c && c.length) rebuildPeople(c);       // instant from cache
  if(!PROXY_BASE) return;
  try{
    const r = await fetch(`${PROXY_BASE}/ref/people`); if(!r.ok) return;
    const items = ((await r.json()).items || []).map(x=>({ id:x.id, name:x.name, lead:!!x.lead }));
    if(items.length){ rebuildPeople(items); cacheSet('people', items); onRefsLoaded(); }
  }catch(_){}
}

/* live venues + venue types for the cascade (small tables — full rows) */
let VENUES = [];          // {id,name,type,closed,hasAddress}
let VENUE_TYPES = [];     // {id,name}
let venueIdByName = {}, venueTypeIdByName = {};
function setVenues(list){ VENUES=list; venueIdByName=Object.fromEntries(VENUES.map(v=>[v.name,v.id])); _live.venues=true; }
function setVenueTypes(list){ VENUE_TYPES=list; venueTypeIdByName=Object.fromEntries(VENUE_TYPES.map(t=>[t.name,t.id])); _live.venueTypes=true; }
// /ref/venues items → the app's {id,name,type,closed,hasAddress} list.
const venueRefList = items => (items || []).filter(x=>x && x.name).map(x=>({ id:x.id, name:x.name,
  type:(x.values && x.values['Venue Type']) || '', closed:!!(x.values && x.values['Closed/Unavailable?']===true),
  hasAddress: x.hasAddress != null ? !!x.hasAddress : !!(x.values && x.values['Address']) }));   // the Worker sends whether a venue has an address, never the address (R12); an older /ref/venues (or cache) still sends Address
// Venues added or changed in this session (venue-form.js): kept through a fresh read that doesn't show them yet.
const _venuesLocal = new Set();
// After a venue write has applied: re-read /ref/venues past the Worker's caches and
// replace VENUES (VenueAddress.mergeVenues keeps this session's entries the fresh list
// lacks). Fire and forget; a failed read keeps the local list.
async function refreshVenues(id){
  if(id) _venuesLocal.add(id);
  if(!PROXY_BASE) return;
  try{
    const r=await fetch(`${PROXY_BASE}/ref/venues?fresh=1`);
    if(!r.ok) return;
    const fresh=venueRefList((await r.json()).items);
    if(!fresh.length) return;
    setVenues(VenueAddress.mergeVenues(fresh, VENUES, _venuesLocal)); cacheSet('venues', VENUES);
  }catch(err){ console.warn('venues refresh failed:', err); }
}
async function loadVenues(){
  const cv=cacheGet('venues'), ct=cacheGet('venue-types');               // instant from cache
  if(cv && cv.length) setVenues(cv);
  if(ct && ct.length) setVenueTypes(ct);
  if(!PROXY_BASE) return;
  try{
    const [rv, rt] = await Promise.all([ fetch(`${PROXY_BASE}/ref/venues`), fetch(`${PROXY_BASE}/ref/venue-types`) ]);
    if(rv && rv.ok){
      const list = venueRefList((await rv.json()).items);
      if(list.length){ setVenues(list); cacheSet('venues', list); }
    }
    if(rt && rt.ok){
      const items = (await rt.json()).items || [];
      const list = items.filter(x=>x && x.name).map(x=>({ id:x.id, name:x.name }));
      if(list.length){ setVenueTypes(list); cacheSet('venue-types', list); }
    }
    onRefsLoaded();
  }catch(_){}
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
    {column:'Address visibility', value:e.addressVisibility||''},   // blank = not chosen yet (Eventbrite treats it as Public)
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
// Dev affordance: point the app at a different Worker (e.g. a `wrangler
// versions upload` preview) without editing code —
//   localStorage.setItem('est-proxy-base','https://<version>-est-planning-proxy...workers.dev')
// then reload; localStorage.removeItem('est-proxy-base') to go back to prod.
const PROXY_BASE = (() => {
  const prod = 'https://est-planning-proxy.eastsidetribe.workers.dev';
  try { return localStorage.getItem('est-proxy-base') || prod; } catch (_) { return prod; }
})();
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
// Relation cells arrive as display-name strings; mapRelations maps them back to
// target-table row ids via the loaded reference lists. On a first visit the rows
// can arrive before the lists (init doesn't wait for them), so an event keeps its
// names and stays `_lossy` until every name maps. Until then its ids are only a
// best guess for display, and the editor shows its relations read-only
// (relationsReady) so a save can never write the guess back.
const _idsOf = (v, byName) => _asList(v).map(n => byName[n]).filter(Boolean);
function mapRelations(ev){
  ev.programs = ev.programNames.map(p => progIdByName[p] || 'oth');   // full list (crossover UI: Plan 2b)
  ev.program = ev.programs[0] || 'oth';                                // primary program drives the color
  ev.leads = _idsOf(ev.leadNames, peopleIdByName);                     // person row ids
  ev.volunteers = _idsOf(ev.volunteerNames, peopleIdByName);           // no editor field — slots/claims supersede it
  ev.venueType = venueTypeIdByName[ev.venueTypeName] || '';
  ev.venue = venueIdByName[ev.venueName] || '';
  ev._lossy = !(_live.programs && _live.people && _live.venues && _live.venueTypes)
    || ev.programNames.some(n => !progIdByName[n]) || ev.leadNames.some(n => !peopleIdByName[n])
    || (!!ev.venueName && !venueIdByName[ev.venueName]) || (!!ev.venueTypeName && !venueTypeIdByName[ev.venueTypeName]);
  return !ev._lossy;
}
function _pushedSnapshot(raw){
  if(!raw || typeof raw!=='string') return null;
  try{ const p=JSON.parse(raw); return (p && typeof p==='object' && !Array.isArray(p)) ? p : null; }catch(_){ return null; }
}
function planningRowToEvent(r){
  const v = r.values || {};
  const venueName = _asList(v['Venue'])[0] || '';
  const venueOther = v['Venue (other)'] || '';
  const sched = String(v['Scheduling'] || 'Exact').toLowerCase();
  const rawDate = String(v['Date'] || '').slice(0,10);
  const ev = {
    id: r.id, source:'planning',
    // relation names as stored — mapRelations (below) derives program/programs/leads/volunteers/venue/venueType
    programNames: _asList(v['Program(s)']), leadNames: _asList(v['Leads']), volunteerNames: _asList(v['Volunteers']),
    venueName, venueTypeName: _asList(v['Venue Type'])[0] || '',
    title: v['Title'] || '',
    date: sched === 'month' ? '' : rawDate,              // Month renders as an undated month idea
    start: _toHM(v['Start']), end: _toHM(v['End']), allDay: !!v['All day'],
    venueOther,
    location: venueName || venueOther,                   // display fallback
    status: String(v['Status'] || 'draft').toLowerCase(),
    description: v['Event Description'] || '',
    capacity: (v['Capacity'] === '' || v['Capacity'] == null) ? '' : Number(v['Capacity']),
    addressVisibility: v['Address visibility'] || '',
    publicSummary: v['Public summary'] || '',
    publicDescription: v['Public description'] || '',
    publishStatus: v['Publish status'] || 'Unpublished',
    eventbriteId: v['Eventbrite Event ID'] || '',
    lastPublishError: v['Last publish error'] || '',
    pushed: _pushedSnapshot(v['Last EB pushed values']),   // what the Worker last sent to Eventbrite; read-only (never written by the app)
    planningNotes: v['Planning Notes'] || '',
    // proxy injects notesDocUrl resolved by the stable column id (rename-proof);
    // Notes Doc is a Coda link column, so the value may be a string or {url,name}.
    notesDocUrl: (typeof r.notesDocUrl === 'string' ? r.notesDocUrl : (r.notesDocUrl && (r.notesDocUrl.url || r.notesDocUrl.name))) || '',
    approvedBy: _asList(v['Approved by'])[0] || '', approvedAt: String(v['Approved at'] || '').slice(0,10),
    lastPublishedAt: String(v['Last published at'] || ''), lastEbPushAt: String(v['Last EB push at'] || ''),   // read-only; eventToCodaCells never writes them
    createdBy: _asList(v['Created by'])[0] || '', editedBy: _asList(v['Edited by'])[0] || '',
    eventbriteUrl: (typeof v['Eventbrite URL'] === 'string' ? v['Eventbrite URL'] : '') || '', gcalId:'', readOnly:true,          // writes come in Plan 2b
    scheduling: sched,
    rangeStart: String(v['Window start'] || '').slice(0,10),
    rangeEnd: String(v['Window end'] || '').slice(0,10),
    targetMonth: sched === 'month' ? rawDate.slice(0,7) : ''
  };
  mapRelations(ev);
  return ev;
}
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
  // Coda answers a write with 202 + requestId and applies it seconds later — the
  // Worker passes that body through ({requestId, addedRowIds} for an insert,
  // {requestId, id} for an update). applied(requestId) waits for the apply.
  async create(e){ const r=await fetch(`${this.base}/rows`,{method:'POST',headers:this._wh(),body:JSON.stringify({rows:[{cells:eventToCodaCells(e)}]})}); if(!r.ok) await this._fail(r); try{ const j=await r.json(); const id=j&&j.addedRowIds&&j.addedRowIds[0]; if(id) e.id=id; e._requestId=(j&&j.requestId)||''; }catch(_){} return e; },
  // Writes ONLY the given cells — Coda leaves every other column of the row as it is.
  async update(id, cells){ const r=await fetch(`${this.base}/rows/${encodeURIComponent(id)}`,{method:'PUT',headers:this._wh(),body:JSON.stringify({row:{cells}})}); if(!r.ok) await this._fail(r); const j=await r.json().catch(()=>null); return { requestId:(j&&j.requestId)||'' }; },
  // Has Coda applied this write yet? Never throws on a non-2xx (a network error may —
  // waitApplied retries it). 401/403 count as applied: the write was accepted with
  // valid auth seconds ago, and an expired token mid-poll mustn't fail the save.
  async mutationStatus(requestId){
    // A hung request throws on the timeout, and waitApplied retries it — so its overall deadline holds.
    const r=await fetch(`${this.base}/mutation/${encodeURIComponent(requestId)}`,{headers:this._wh(), signal:AbortSignal.timeout(15000)});
    if(r.status===401 || r.status===403) return { status:404 };
    if(!r.ok) return { status:r.status };
    const j=await r.json().catch(()=>({}));
    return { status:r.status, completed: !!(j && j.completed) };
  },
  // A refusal (409 cancel first, 502 Eventbrite wouldn't delete the draft) carries the Worker's own message.
  async remove(id){ const r=await fetch(`${this.base}/rows/${encodeURIComponent(id)}`,{method:'DELETE',headers:this._wh()}); if(!r.ok){ const j=await r.json().catch(()=>({})); const e=new Error(j.error||`delete failed (${r.status})`); e.status=r.status; throw e; } },
  async createNotesDoc(rowId){ const r=await fetch(`${this.base}/notes-doc`,{method:'POST',headers:this._wh(),body:JSON.stringify({rowId})}); if(!r.ok) await this._fail(r); return true; },
  async publishEventbrite(rowId, draftOnly, force){ const r=await fetch(`${this.base}/publish/eventbrite`,{method:'POST',headers:this._wh(),body:JSON.stringify({rowId, draftOnly:!!draftOnly, force:!!force})}); const j=await r.json().catch(()=>({})); if(!r.ok){ const e=new Error(j.error||`publish failed (${r.status})`); e.status=r.status; e.conflict=!!j.conflict; e.checks=Array.isArray(j.checks)?j.checks:null; e.lastPushAt=j.lastPushAt||null; e.requestId=j.requestId||null; e.eventbriteId=j.eventbriteId?String(j.eventbriteId):''; throw e; } return j; },
  async ebPreview(rowId){ const r=await fetch(`${this.base}/eventbrite/preview?rowId=${encodeURIComponent(rowId)}`,{headers:this._wh()}); const j=await r.json().catch(()=>({})); if(r.status===404 && j && j.linked===false) return null; if(!r.ok){ const e=new Error(j.error||`preview failed (${r.status})`); e.status=r.status; throw e; } return j; },
  async ebStatus(rowId){ const r=await fetch(`${this.base}/eventbrite/status?rowId=${encodeURIComponent(rowId)}`,{headers:this._wh()}); if(!r.ok) return null; return r.json().catch(()=>null); },
  async refreshPeople(){ const r=await fetch(`${this.base}/admin/refresh-people`,{method:'POST',headers:this._wh()}); const j=await r.json().catch(()=>({})); if(!r.ok){ const e=new Error(j.error||`refresh failed (${r.status})`); e.status=r.status; throw e; } return j; },
  // Cancel / unpublish: a 409 {needsEventbriteCancel, registrants, error} means people registered,
  // so Eventbrite refuses (F7) and nothing changed.
  async cancelEventbrite(rowId){ return this._ebTeardown('cancel', rowId); },
  async unpublishEventbrite(rowId){ return this._ebTeardown('unpublish', rowId); },
  async _ebTeardown(route, rowId){ const r=await fetch(`${this.base}/${route}/eventbrite`,{method:'POST',headers:this._wh(),body:JSON.stringify({rowId})}); const j=await r.json().catch(()=>({})); if(!r.ok){ const e=new Error(j.error||`${route} failed (${r.status})`); e.status=r.status; e.needsEventbriteCancel=!!j.needsEventbriteCancel; e.registrants=Number(j.registrants)||0; throw e; } return j; },
  async listFeedback(context){ const q=context?`?context=${encodeURIComponent(context)}`:''; const r=await fetch(`${this.base}/feedback${q}`,{headers:{Authorization:`Bearer ${state.idToken||''}`}}); if(!r.ok) return []; return (await r.json()).items||[]; },
  async submitFeedback(idea, context){ const r=await fetch(`${this.base}/feedback`,{method:'POST',headers:this._wh(),body:JSON.stringify({idea,context})}); if(!r.ok) await this._fail(r); return true; },
  async voteFeedback(id){ const r=await fetch(`${this.base}/feedback/${encodeURIComponent(id)}/vote`,{method:'POST',headers:this._wh()}); const j=await r.json().catch(()=>({})); if(!r.ok){ const e=new Error(j.error||'vote failed'); e.status=r.status; throw e; } return j; },
  // gather sign-up slots (lead-authored; members fill them in the gather app)
  async listSlots(eventId){ const r=await fetch(`${this.base}/slots?event=${encodeURIComponent(eventId)}`,{headers:this._wh()}); if(!r.ok) await this._fail(r); return (await r.json()).items||[]; },
  async createClaim(body){ const r=await fetch(`${this.base}/claims`,{method:'POST',headers:this._wh(),body:JSON.stringify(body)}); if(!r.ok) await this._fail(r); return (await r.json().catch(()=>({}))); },
  async updateClaim(id, body){ const r=await fetch(`${this.base}/claims/${encodeURIComponent(id)}`,{method:'PUT',headers:this._wh(),body:JSON.stringify(body)}); if(!r.ok) await this._fail(r); return true; },
  async removeClaim(id){ const r=await fetch(`${this.base}/claims/${encodeURIComponent(id)}`,{method:'DELETE',headers:this._wh()}); if(!r.ok) await this._fail(r); return true; },
  async createSlot(body){ const r=await fetch(`${this.base}/slots`,{method:'POST',headers:this._wh(),body:JSON.stringify(body)}); if(!r.ok) await this._fail(r); return (await r.json().catch(()=>({}))); },
  async updateSlot(id, body){ const r=await fetch(`${this.base}/slots/${encodeURIComponent(id)}`,{method:'PUT',headers:this._wh(),body:JSON.stringify(body)}); if(!r.ok) await this._fail(r); return true; },
  async removeSlot(id){ const r=await fetch(`${this.base}/slots/${encodeURIComponent(id)}`,{method:'DELETE',headers:this._wh()}); if(!r.ok) await this._fail(r); return true; },
  // Venues (canWrite): one venue's structured address (never in the shared /ref/venues list),
  // add one ({name,typeId,street,unit,city,state,zip} → {id, requestId}) and change its address
  // (→ {requestId}). A refusal keeps the Worker's message, status and per-field `errors`.
  async getVenue(id){ const r=await fetch(`${this.base}/venues/${encodeURIComponent(id)}`,{headers:this._wh()}); return this._venueJson(r, 'venue read'); },
  async createVenue(body){ const r=await fetch(`${this.base}/venues`,{method:'POST',headers:this._wh(),body:JSON.stringify(body)}); return this._venueJson(r, 'add venue'); },
  async updateVenue(id, body){ const r=await fetch(`${this.base}/venues/${encodeURIComponent(id)}`,{method:'PUT',headers:this._wh(),body:JSON.stringify(body)}); return this._venueJson(r, 'address save'); },
  async _venueJson(r, what){ const j=await r.json().catch(()=>({})); if(!r.ok){ const e=new Error(j.error||`${what} failed (${r.status})`); e.status=r.status; e.errors=(j.errors && typeof j.errors==='object') ? j.errors : null; throw e; } return j; },
  // lead-facing attendee roster (Eventbrite orders ∪ gather claimants); fresh=true bypasses the Worker's KV snapshot
  async roster(rowId, fresh){ const r=await fetch(`${this.base}/roster/${encodeURIComponent(rowId)}${fresh?'?fresh=1':''}`,{headers:this._wh()}); const j=await r.json().catch(()=>({})); if(!r.ok){ const e=new Error(j.error||`roster failed (${r.status})`); e.status=r.status; throw e; } return j; },
};

// The live proxy is the only data source. Reads are unauthenticated (CORS-gated,
// localhost allowed); writes require Google sign-in + role. Runs the same locally
// and deployed. See docs/deployment.md → "Local development".
const DB = CodaSource;
