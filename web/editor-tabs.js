/* editor-tabs.js — the editor's tab model: the open event (`editing`), SECTIONS, the tab list, the tab heading and renderSection.
   Owns: editing, whenType, SECTIONS, sectionId, activeSection, whenFieldsHTML, collectWhen, railHTML, setActiveRail, renderSection, wireScrollFade
   Reads: PageRules (page-rules.js, call time); paintInner (status-panel.js, call time)
   Writes: nothing (declares editing, whenType, activeSection; other files assign them)
   Loaded after: calendar.js (first editor file; chipHTML reads editing at call time) */

/* =========================================================================
   MODAL
   ========================================================================= */
let editing=null; // event being edited, or null
let whenType='exact';

// Editor workspace sections (left rail). `live` sections have real panels;
// the rest render a muted "coming soon" teaser. `help` = the guide (web/help/
// guide.md) the editor header's ? opens for that tab. No icon webfont — text labels.
// `foot`: the tab's one-line description, under its name in the main column's
// heading (#epHead). The first tab's id stays 'details' (old links, syncUrl).
// `fill`: a list tab that fills the viewport and scrolls inside (its filters, group
// headings and footer stay put) instead of scrolling the page (renderSection sets
// #eventPage.ep-fill; styles.css → "list tabs").
const SECTIONS = [
  { id:'details',   label:'Listing',              live:true,  help:'edit-details',
    foot:'What people see on Eventbrite. Edits save here first; send them to Eventbrite with the next-step button.' },
  { id:'planning',  label:'Planning',             live:true,  help:'planning-notes',
    foot:'Private planning space for leads and council; nothing here goes on Eventbrite.' },
  { id:'volunteers',label:'Potluck & Volunteers', live:true,  help:'signups', fill:true,
    foot:'Set up potluck dishes and volunteer shifts that members sign up for in gather.' },
  { id:'attendees', label:'Attendees',            live:true,  help:'attendees', fill:true,
    foot:"See who's coming, from Eventbrite registrations and gather sign-ups, and email them." },
  { id:'budget',    label:'Budget & expenses',    live:false, help:'feedback',
    foot:'Budget tracking is coming soon: vote on ideas or suggest your own.' },
  { id:'comms',     label:'Comms',                live:false, help:'feedback',
    foot:'Event emails and posts are coming soon: vote on ideas or suggest your own.' },
  { id:'feedback',  label:'Feedback',             live:false, help:'feedback',
    foot:'Post-event feedback is coming soon: vote on ideas or suggest your own.' },
];
// Back-compat: the Planning tab was 'notes' (Planning Notes, until 2026-11);
// Attendees was the 'attendance' stub; the Publish tab folded into Details (2026-09).
const sectionId = id => PageRules.sectionFromParam(id);
let activeSection = 'details';

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
  const fm=fieldMarkModel(editing||ev);
  return `<div class="fld"><label>${fieldLabelHTML('date','Date',fm)}</label>
      <div class="daterow">
        <input id="f_date" type="date" value="${ev.date||''}" ${dis}>
        <label class="allday-inline"><input id="f_allday" type="checkbox" ${allDay?'checked':''} ${dis}> All day</label>
      </div>${fieldHintSlot('date')}
    </div>` +
    (allDay ? '' : `<div class="timerow">
      <div class="fld"><label>${fieldLabelHTML('start','Start time',fm)}</label><input id="f_start" type="time" value="${ev.start||''}" ${dis}>${fieldHintSlot('start')}</div>
      <div class="fld"><label>${fieldLabelHTML('end','End time',fm)}</label><input id="f_end" type="time" value="${ev.end||''}" ${dis}>${fieldHintSlot('end')}</div>
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

/* ---- editor workspace: rail + section panels ------------------------------
   The planning editor is a rail of sections. The live ones are Listing, Planning,
   Potluck & Volunteers and Attendees;
   the rest render a muted "coming soon" teaser. Each section owns its own render
   (markup) + wire (post-render listeners) pair. Field ids stay globally unique
   within the open editor, so readForm()/collectWhen() still find them by id. */
function railHTML(){
  // A live tab carries a stable slot for its marker (Listing's red dot, painted by renderStatusPanel).
  const item = s=>`<button type="button" class="wrail-item${s.id===activeSection?' on':''}${s.live?'':' soon'}" data-sect="${s.id}">${esc(s.label)}${s.live?`<span class="tab-dot-slot" data-dot="${s.id}"></span>`:''}</button>`;
  const live=SECTIONS.filter(s=>s.live), soon=SECTIONS.filter(s=>!s.live);
  return live.map(item).join('') + `<div class="wrail-soon">Coming soon…</div>` + soon.map(item).join('');
}
function setActiveRail(id){ activeSection=id; document.querySelectorAll('#epTabs .wrail-item').forEach(b=>b.classList.toggle('on', b.dataset.sect===id)); }

// The main column's heading: the tab's name and its one-line description.
function tabHeadHTML(id){
  const s=SECTIONS.find(x=>x.id===id); if(!s) return '';
  return `<h2 class="ep-h">${esc(s.label)}</h2>${s.foot?`<p class="ep-hdesc">${esc(s.foot)}</p>`:''}`;
}
// Takes the editor's ctx (D2); the tabs still take positional args, adapted here.
function renderSection(id, ctx){
  const panel=document.getElementById('wpanel'); if(!panel) return;
  const head=document.getElementById('epHead'); if(head) paintInner(head, tabHeadHTML(id));
  const { ev, locked, past:pastLocked } = ctx, { canEdit, canApprove } = ctx.role;
  const sec=SECTIONS.find(s=>s.id===id);
  const page=document.getElementById('eventPage'); if(page) page.classList.toggle('ep-fill', !!(sec && sec.fill));
  if(sec && !sec.live){ panel.innerHTML=comingSoonHTML(sec); if(typeof wireFeedback==='function') wireFeedback(panel, id); return; }
  if(id==='volunteers'){ panel.innerHTML=renderSlots(ev, canEdit); wireSlots(panel, ev, canEdit); return; }
  if(id==='attendees'){ panel.innerHTML=renderAttendees(ev); wireAttendees(panel, ev); return; }
  const detailsLocked = locked || !!pastLocked;   // a past approved event's fields are history (decided when it opened); sign-ups, Attendees and the notes doc don't take this lock
  if(id==='planning'){ panel.innerHTML=renderPlanningTab(ev, canEdit, detailsLocked, locked); wirePlanningTab(panel, ev, canEdit, detailsLocked, locked); return; }
  panel.innerHTML=renderDetails(ev, canEdit, detailsLocked, canApprove); wireDetails(panel, ev, canEdit, detailsLocked, canApprove);
}

function comingSoonHTML(sec){
  return `<div class="soon-teaser"><div class="soon-h">${esc(sec.label)} — coming soon</div><div class="hint">On our roadmap. Tell us what you'd want here, or +1 an idea below.</div>${typeof feedbackBoardHTML==='function'?feedbackBoardHTML(sec.id):''}</div>`;
}

/* Horizontal-scroll edge fade: masks the overflowing edge(s) of a scroller so
   there's a visual "more →" hint (used by the mobile rail + roster segment
   chips). Recomputes on scroll/resize; returns an update fn the caller can call
   after changing the scroller's contents. Safe on non-overflowing / desktop
   (clears the mask when nothing overflows). */
function wireScrollFade(el){
  if(!el) return ()=>{};
  const upd=()=>{
    if(!el.isConnected){ window.removeEventListener('resize', upd); return; }   // self-clean once the modal is gone
    const max=el.scrollWidth-el.clientWidth;
    if(max<=1){ el.style.webkitMaskImage=el.style.maskImage=''; return; }
    const l=el.scrollLeft>1 ? 'transparent, #000 22px' : '#000';
    const r=el.scrollLeft<max-1 ? '#000 calc(100% - 22px), transparent' : '#000';
    el.style.webkitMaskImage=el.style.maskImage=`linear-gradient(90deg, ${l}, ${r})`;
  };
  el.addEventListener('scroll', upd, {passive:true});
  window.addEventListener('resize', upd);
  requestAnimationFrame(upd);
  return upd;
}
