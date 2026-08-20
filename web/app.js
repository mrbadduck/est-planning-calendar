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
const PEOPLE = ['Eric','Laura','Kaitlyn','Emma','Erika','Sophie','Jesse','Brigid','Robby','Anna'];
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
async function loadPrograms(){
  if(!PROXY_BASE) return;                          // mock mode keeps the built-in palette
  try{
    const r = await fetch(`${PROXY_BASE}/ref/programs`);
    if(!r.ok) return;
    const items = (await r.json()).items || [];
    const list = items.filter(x=>x && x.name).map((x,i,a)=>({ id:x.id, name:x.name, active:!!(x.values && x.values['Active']===true), color:genColor(i,a.length) }));
    if(list.length) rebuildPrograms(list);
  }catch(_){}
}
/* Scalar write cells for EST Planning Events SRC (Plan 2b-i). Program(s)/Leads/
   Venue relations are edited in Plan 2b-ii; attribution is injected by the Worker.
   Month scheduling stores Date=1st. */
function eventToCodaCells(e){
  const sched = (e.scheduling||'exact').toLowerCase();
  const dateVal = sched==='month' ? (e.targetMonth ? `${e.targetMonth}-01` : '')
                : sched==='exact' ? (e.date||'') : '';
  return [
    {column:'Title',           value:e.title||''},
    {column:'Program(s)',      value:(e.programs||[]).filter(id=>id&&id!=='oth')},
    {column:'Status',          value:cap(e.status||'idea')},
    {column:'Scheduling',      value:cap(sched)},
    {column:'Date',            value:dateVal},
    {column:'Start',           value:e.start||''},
    {column:'End',             value:e.end||''},
    {column:'All day',         value:!!e.allDay},
    {column:'Venue (other)',   value:e.location||''},
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
function planningRowToEvent(r){
  const v = r.values || {};
  const progs = _asList(v['Program(s)']);               // all programs (names)
  const venue = _asList(v['Venue'])[0] || '';
  const sched = String(v['Scheduling'] || 'Exact').toLowerCase();
  const rawDate = String(v['Date'] || '').slice(0,10);
  return {
    id: r.id, source:'planning',
    program: progIdByName[progs[0]] || 'oth',           // primary program drives the color
    programs: progs.map(p => progIdByName[p] || 'oth'),  // full list (crossover UI: Plan 2b)
    title: v['Title'] || '',
    leads: _asList(v['Leads']),
    date: sched === 'month' ? '' : rawDate,              // Month renders as an undated month idea
    start: _toHM(v['Start']), end: _toHM(v['End']), allDay: !!v['All day'],
    location: venue || (v['Venue (other)'] || ''),
    status: String(v['Status'] || 'idea').toLowerCase(),
    description: v['Event Description'] || '',
    planningNotes: v['Planning Notes'] || '',
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
    return (j.items || []).map(planningRowToEvent);
  },
  async listReferences(){ return MOCK_REFS.slice(); },
  _wh(){ return { 'Content-Type':'application/json', 'Authorization':`Bearer ${state.idToken||''}` }; },
  async _fail(r){ let t=await r.text(); try{ t=JSON.parse(t).error||t; }catch(_){} throw new Error(`save failed (${r.status})${t?': '+t:''}`); },
  async create(e){ const r=await fetch(`${this.base}/rows`,{method:'POST',headers:this._wh(),body:JSON.stringify({rows:[{cells:eventToCodaCells(e)}]})}); if(!r.ok) await this._fail(r); return e; },
  async update(e){ const r=await fetch(`${this.base}/rows/${encodeURIComponent(e.id)}`,{method:'PUT',headers:this._wh(),body:JSON.stringify({row:{cells:eventToCodaCells(e)}})}); if(!r.ok) await this._fail(r); return e; },
  async remove(id){ const r=await fetch(`${this.base}/rows/${encodeURIComponent(id)}`,{method:'DELETE',headers:this._wh()}); if(!r.ok) await this._fail(r); },
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

async function loadEvents(){
  const [p,r] = await Promise.all([DB.listPlanning(), DB.listReferences()]);
  state.events = [...p, ...r];
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
  const badge=document.getElementById('mBadge'); badge.className='badge'; badge.textContent='';
  document.getElementById('mBody').innerHTML=legendHTML();
  document.getElementById('mFoot').innerHTML=`<span class="push"></span><button class="btn" data-act="close">Close</button>`;
  show();
}

/* =========================================================================
   MODAL
   ========================================================================= */
let editing=null; // event being edited, or null
let whenType='exact';

function whenFieldsHTML(type,ev,dis){
  if(type==='range') return `<div style="display:flex;gap:10px">
      <div class="fld" style="flex:1"><label>Window start</label><input id="f_rstart" type="date" value="${ev.rangeStart||ev.date||''}" ${dis}></div>
      <div class="fld" style="flex:1"><label>Window end</label><input id="f_rend" type="date" value="${ev.rangeEnd||''}" ${dis}></div>
    </div>
    <div style="font-size:11px;color:var(--muted);margin-top:5px">Floats in the gutter until it gets a firm day.</div>`;
  if(type==='month') return `<div class="fld"><label>Target month</label><input id="f_month" type="month" value="${ev.targetMonth||(ev.date?ev.date.slice(0,7):'')}" ${dis}></div>
    <div style="font-size:11px;color:var(--muted);margin-top:5px">Shows as a whole-month idea in the gutter.</div>`;
  return `<div class="fld"><label>Date</label><input id="f_date" type="date" value="${ev.date||''}" ${dis}></div>`;
}
function collectWhen(){
  const g=id=>document.getElementById(id), o={};
  if(g('f_date')) o.date=g('f_date').value;
  if(g('f_rstart')) o.rangeStart=g('f_rstart').value;
  if(g('f_rend')) o.rangeEnd=g('f_rend').value;
  if(g('f_month')) o.targetMonth=g('f_month').value;
  return o;
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
  const badge=document.getElementById('mBadge');
  badge.className='badge '+(isRef?'b-ref':'b-'+ev.status);
  badge.textContent = isRef ? REF[ev.refLayer].name : cap(ev.status);

  const body=document.getElementById('mBody');
  if(isRef){
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
  body.innerHTML = `
    <div class="fld full"><label>Title</label><input id="f_title" value="${esc(ev.title)}" ${dis} placeholder="e.g. Kabbalat Shabbat"></div>
    <div class="fld full"><label>Program(s)</label><div class="leadchips" id="f_progs">${PROGRAMS.filter(p=>p.id!=='oth' && (p.active!==false || (ev.programs&&ev.programs.includes(p.id)))).map(p=>`<button type="button" class="leadchip" data-p="${p.id}" aria-pressed="${(ev.programs&&ev.programs.length?ev.programs:[ev.program]).includes(p.id)}" ${dis}>${esc(p.name)}</button>`).join('')}</div></div>
    <div class="fld"><label>Status</label><select id="f_status" ${dis}>${STATUSES.filter(s=>s!=='approved').map(s=>`<option value="${s}" ${s===ev.status?'selected':''}>${cap(s)}</option>`).join('')}${ev.status==='approved'?'<option value="approved" selected>Approved</option>':''}</select></div>
    <div class="fld full"><label>When</label>
      <div class="whenseg" id="f_when">
        <button type="button" data-when="exact" aria-pressed="${sched==='exact'}" ${dis}>Exact date</button>
        <button type="button" data-when="range" aria-pressed="${sched==='range'}" ${dis}>Date range</button>
        <button type="button" data-when="month" aria-pressed="${sched==='month'}" ${dis}>Whole month</button>
      </div>
    </div>
    <div class="fld full" id="whenFields"></div>
    <div class="fld"><label>Start time</label><input id="f_start" type="time" value="${ev.start||''}" ${dis}></div>
    <div class="fld"><label>End time</label><input id="f_end" type="time" value="${ev.end||''}" ${dis}></div>
    <div class="allday" style="grid-column:1/3"><input id="f_allday" type="checkbox" ${ev.allDay?'checked':''} ${dis}><label for="f_allday" style="text-transform:none;color:var(--muted);font-weight:500">All day (no set time)</label></div>
    <div class="fld full"><label>Location</label><input id="f_loc" value="${esc(ev.location||'')}" ${dis} placeholder="Venue or 'TBD'"></div>
    <div class="fld full"><label>Leads</label><div class="leadchips" id="f_leads">${PEOPLE.map(p=>`<button type="button" class="leadchip" data-p="${p}" aria-pressed="${ev.leads.includes(p)}" disabled>${p}</button>`).join('')}</div></div>
    <div class="fld full"><label>Description</label><textarea id="f_desc" ${dis} placeholder="What's the plan?">${esc(ev.description||'')}</textarea></div>
    ${(!canEdit)?`<div class="locknote">Sign in as a program lead to edit.</div>`:``}
    ${(canEdit&&!locked)?`<div class="locknote">Leads &amp; venue: set in Coda for now — pickers arrive next.</div>`:``}
    ${locked?`<div class="locknote">🔒 Approved &amp; locked. Detailed edits (ticketing, banner, promotion) happen in Coda. <a href="#" data-act="coda">Open in Mission Control ↗</a></div>`:''}
    ${ev.id?`<div class="meta"><span>Created by ${esc(ev.createdBy||'—')}</span><span>Last edited by ${esc(ev.editedBy||'—')}</span></div>`:''}`;

  // footer actions
  const foot=document.getElementById('mFoot');
  let acts='';
  if(ev.id && canEdit && !locked) acts+=`<button class="btn danger" data-act="delete">Delete</button>`;
  acts+=`<span class="push"></span>`;
  acts+=`<button class="btn" data-act="close">${canEdit&&!locked?'Cancel':'Close'}</button>`;
  if(canApprove){
    if(ev.status==='approved') acts+=`<button class="btn" data-act="reopen">Reopen</button>`;
    else acts+=`<button class="btn" data-act="approve">Approve${ev.id?'':' & save'}</button>`;
  }
  if(canEdit && !locked) acts+=`<button class="btn primary" data-act="save">${ev.id?'Save':'Create'}</button>`;
  foot.innerHTML=acts;

  // lead toggles
  body.querySelectorAll('.leadchip').forEach(b=>{
    if(!canEdit||locked) return;
    b.addEventListener('click',()=>b.setAttribute('aria-pressed', b.getAttribute('aria-pressed')==='true'?'false':'true'));
  });

  // when control
  whenType = sched;
  document.getElementById('whenFields').innerHTML = whenFieldsHTML(whenType, ev, dis);
  if(canEdit && !locked){
    document.getElementById('f_when').addEventListener('click',e=>{
      const b=e.target.closest('button[data-when]'); if(!b) return;
      const cur=collectWhen();
      whenType=b.dataset.when;
      [...b.parentElement.children].forEach(x=>x.setAttribute('aria-pressed', x===b));
      document.getElementById('whenFields').innerHTML=whenFieldsHTML(whenType, Object.assign({},ev,cur), '');
    });
  }
  show();
  const t=document.getElementById('f_title'); if(t && !ev.id) t.focus();
}

function readForm(){
  const g=id=>document.getElementById(id);
  const leads=[...document.querySelectorAll('#f_leads .leadchip')].filter(b=>b.getAttribute('aria-pressed')==='true').map(b=>b.dataset.p);
  const programs=[...document.querySelectorAll('#f_progs .leadchip')].filter(b=>b.getAttribute('aria-pressed')==='true').map(b=>b.dataset.p);
  const w=collectWhen();
  const o={
    program:programs[0]||'oth', programs, status:g('f_status').value, title:g('f_title').value.trim()||'Untitled',
    allDay:g('f_allday').checked, start:g('f_start').value, end:g('f_end').value,
    location:g('f_loc').value.trim(), description:g('f_desc').value.trim(), leads,
    scheduling:whenType, date:'', rangeStart:'', rangeEnd:'', targetMonth:''
  };
  if(whenType==='exact') o.date=w.date||'';
  else if(whenType==='range'){ o.rangeStart=w.rangeStart||''; o.rangeEnd=w.rangeEnd||w.rangeStart||''; }
  else if(whenType==='month') o.targetMonth=w.targetMonth||'';
  return o;
}

async function saveEditor(approve){
  const f=readForm();
  const base = editing.id ? editing : {source:'planning', eventbriteUrl:'', gcalId:''};
  const e = Object.assign({}, base, f);
  if(approve) e.status='approved';
  try {
    if(editing.id){ await DB.update(e); } else { await DB.create(e); }
    close(); await refresh();
  } catch(err){ alert(String(err && err.message || err)); }
}
async function deleteEditor(){
  try {
    if(editing && editing.id){ await DB.remove(editing.id); }
    close(); await refresh();
  } catch(err){ alert(String(err && err.message || err)); }
}

/* =========================================================================
   WIRING
   ========================================================================= */
function show(){ document.getElementById('scrim').classList.add('open'); }
function close(){ document.getElementById('scrim').classList.remove('open'); editing=null; }

document.getElementById('scrim').addEventListener('click',e=>{ if(e.target.id==='scrim') close(); });
document.addEventListener('keydown',e=>{ if(e.key==='Escape') close(); });

document.getElementById('mFoot').addEventListener('click',e=>{
  const act=e.target.closest('[data-act]')?.dataset.act; if(!act) return;
  if(act==='close') close();
  else if(act==='save') saveEditor(false);
  else if(act==='approve') saveEditor(true);
  else if(act==='reopen'){ const e=Object.assign({},editing,{status:'confirmed'}); DB.update(e).then(()=>{close();refresh();}).catch(err=>alert(String(err&&err.message||err))); }
  else if(act==='delete') deleteEditor();
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
  const badge=document.getElementById('mBadge'); badge.className='badge b-ref'; badge.textContent=list.length+' events';
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
  await loadPrograms();
  await loadEvents(); applyView(); layoutSticky();
  const rb = document.getElementById('refreshBtn'); if(rb) rb.addEventListener('click', refresh);
  document.addEventListener('visibilitychange', () => { if(!document.hidden) refresh(); }); // refetch on tab focus
  setInterval(() => { if(!document.hidden) refresh(); }, 60000);                            // light 60s poll while visible
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
