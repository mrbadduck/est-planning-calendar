/* calendar.js — the Calendar (months), Overview and List views, and the #listView click listener.
   Owns: buildWeekHead, chipHTML, renderMonths, renderOverview, renderList, sortEv
   Reads: state (state.js); editing (app.js, in chipHTML)
   Writes: nothing
   Loaded after: state.js (reads state, todayStr, eventsByDate, roughByMonth at call time) */


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
    const c=cssColor(REF[e.refLayer].color, 'var(--faint)');
    return `<div class="chip ref" style="--c:${c}" data-id="${e.id}" data-ref="1" title="${esc(e.title)}"><span class="t">${esc(e.title)}</span></div>`;
  }
  const c=progColor(e.program);
  const t = (!e.allDay && e.start) ? `<span class="time">${e.start}</span>` : '';
  // (No 🔒 on approved: approved isn't locked — leads keep editing it, decision 5.)
  return `<div class="chip ${e.status}" style="--c:${c}" data-id="${e.id}" title="${esc(e.title)} — ${cap(e.status)}">${t}<span class="t">${esc(e.title)}</span>${xMark(e)}</div>`;
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
      const ghead = w===0 ? `<div class="ghead"><span class="ghint">date TBD</span><button type="button" class="gadd" data-newidea="${mk}" aria-label="Add an idea for ${MONTHS[Number(mk.slice(5,7))-1]}" data-tip="Add an idea for this month">+</button></div>` : '';   // one + per month
      body += `<div class="gcell">${ghead}${ideas.map(e=>gchipHTML(e,mk)).join('')}</div>`;
      for(let k=0;k<7;k++){
        const dayNum=w*7+k-startWd+1;
        let cy=y,cm=m,dn=dayNum,other=false;
        if(dayNum<1){ other=true; cm=m-1; cy=m===0?y-1:y; dn=prevDays+dayNum; if(cm<0){cm=11;} }
        else if(dayNum>daysIn){ other=true; cm=m+1; cy=m===11?y+1:y; dn=dayNum-daysIn; if(cm>11){cm=0;} }
        const ds=ymd(cy,cm,dn);
        const isToday=ds===todayStr;
        const evs=(byDate[ds]||[]).slice().sort(sortEv);
        body += `<div class="cell ${other?'other':''} ${k===0||k===6?'we':''} ${isToday?'today':''}" data-date="${ds}" ${other?'data-other="1"':''}>
          ${other ? '' : `<button type="button" class="cell-add" data-add-date="${ds}" aria-label="Add an event on ${fmtDate(ds)}" data-tip="Add an event">+</button>`}
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
  if(e.source==='ref') return `<div class="qchip ref" style="--c:${cssColor(REF[e.refLayer].color, 'var(--faint)')}" data-id="${e.id}" title="${esc(e.title)}">${esc(e.title)}</div>`;
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
      const zone = (kind, list) => `<div class="qzone ${kind}">${list.map(qchipHTML).join('')||'<span class="zlbl">·</span>'}<button type="button" class="zone-add" data-add="${weekAddDate(y,m,dayNums,kind)}" aria-label="Add a ${kind==='wkn'?'weeknight':'weekend'} event, ${MONTHS[m]} ${lbl}" data-tip="Add an event">+</button></div>`;
      weeks += `<div class="qweek">
        <div class="qwk">${lbl}</div>
        ${zone('wkn', wkn)}
        ${zone('wknd', wknd)}
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
    <div class="legend" style="margin-top:14px"><span class="k" style="color:var(--faint)">Each week splits into <b style="color:var(--muted)">weeknight</b> (Mon–Thu) and <b style="color:var(--muted)">weekend</b> (Fri–Sun). Undated ideas sit in each month's footer. Point at a lane and click its + to add.</span></div>`;
}

/* =========================================================================
   LIST VIEW — the program year as a scrolling agenda: one row per day that has
   something on it, planning events first, the day's reference dates collapsed
   into one muted line. Undated ideas close out their month under "Date TBD".
   The only view on phones (curView); an option beside Overview/Calendar above.
   ========================================================================= */
function hm12(hm){
  const [h,m]=String(hm||'').split(':').map(Number); if(isNaN(h)) return '';
  return `${h%12||12}${m?':'+pad(m):''} ${h<12?'am':'pm'}`;
}
function listWhen(e){
  if(e.scheduling==='month') return `Sometime in ${MONTHS[Number((e.targetMonth||'').slice(5,7))-1]||'the month'}`;
  if(e.scheduling==='range'){
    const f=ds=>ds?`${MONTHS[Number(ds.slice(5,7))-1].slice(0,3)} ${Number(ds.slice(8,10))}`:'';
    return [f(e.rangeStart), f(e.rangeEnd)].filter(Boolean).join('–');
  }
  if(e.allDay || !e.start) return 'All day';
  return e.end ? `${hm12(e.start)}–${hm12(e.end)}` : hm12(e.start);
}
function lrowHTML(e){
  const si=statusInfo(e);
  const meta=[listWhen(e), si.label, e.venueName||e.venueOther||e.location].filter(Boolean).map(esc).join(' · ');
  return `<button type="button" class="lev ${e.status}" style="--c:${progColor(e.program)}" data-id="${e.id}">
      <span class="lt">${esc(e.title)||'(untitled)'}${xMark(e)}</span><span class="lm">${meta}</span>
    </button>`;
}
function renderList(){
  const box=document.getElementById('listView');
  const byDate=eventsByDate(), roughMap=roughByMonth();
  let html='', anchored=false;
  for(const {y,m} of monthsOfYear()){
    const mk=monthKey(y,m), daysIn=new Date(y,m+1,0).getDate();
    let days='';
    for(let d=1; d<=daysIn; d++){
      const ds=ymd(y,m,d), evs=byDate[ds]; if(!evs) continue;
      const plans=evs.filter(e=>e.source==='planning').sort(sortEv), refs=evs.filter(e=>e.source!=='planning');
      const cls=[ds===todayStr?'today':'', ds<todayStr?'past':''];
      if(!anchored && ds>=todayStr){ anchored=true; cls.push('lnow'); }   // where the list opens: today, or the next day with anything on it
      days += `<div class="lday ${cls.join(' ')}">
        <div class="ldate"><span class="lwd">${WD[new Date(y,m,d).getDay()]}</span><span class="ldn">${d}</span></div>
        <div class="litems">${plans.map(lrowHTML).join('')}${refs.length ? `<div class="lrefs">${refs.map(r=>`<button type="button" class="lref" style="--c:${cssColor(REF[r.refLayer].color,'var(--faint)')}" data-id="${r.id}">${esc(r.title)}</button>`).join('')}</div>` : ''}</div>
      </div>`;
    }
    const rough=roughMap[mk]||[];
    if(rough.length) days += `<div class="lday ltbd">
        <div class="ldate"><span class="lwd">Date</span><span class="ldn">TBD</span></div>
        <div class="litems">${rough.map(lrowHTML).join('')}</div>
      </div>`;
    html += `<section class="lmonth" data-mk="${mk}"><h2 class="lmhead">${MONTHS[m]}<span class="ly">${y}</span></h2>${days || '<p class="lempty">Nothing on the calendar</p>'}</section>`;
  }
  box.innerHTML=html;
}
document.getElementById('listView').addEventListener('click',e=>{
  const row=e.target.closest('.lev,.lref'); if(!row) return;
  const ev=state.events.find(x=>x.id===row.dataset.id); if(ev) openEditor(ev);
});

function sortEv(a,b){
  if(a.source!==b.source) return a.source==='planning'?-1:1;      // plans above refs
  const at=a.allDay?'':(a.start||''), bt=b.allDay?'':(b.start||'');
  return at.localeCompare(bt);
}
