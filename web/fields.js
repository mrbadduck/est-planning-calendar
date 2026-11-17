/* fields.js — one HTML builder per event field, the Planning/create-form panels, wireEventFields and readForm.
   Owns: titleFieldHTML, internalNotesFieldHTML, programsFieldHTML, leadsFieldHTML, whenGroupHTML, whereGroupHTML, ticketingGroupHTML, REL_NOTE, lockNotesHTML, fieldLab, renderPlanning, wirePlanning, wireEventFields, readForm
   Reads: editing (editor-tabs.js); reference lists (data.js); venueSlotsHTML, wireVenueForm, openVenueAdd, paintVenueAddr (venue-form.js; call time)
   Writes: whenType (editor-tabs.js)
   Loaded after: editor.js (file-map order; no load-time dependency) */

/* Event fields, one builder each. The Listing tab, the Planning tab
   (the private fields) and the create form (openNewEventForm) each pick the ones
   they show. Field ids stay unique within the open editor, so readForm() finds
   whatever is rendered and falls back to the event's own values for the rest. */
// Until the reference lists load and this event's stored names all map, relations
// show as plain read-only text: a picker would show — and a save would write — a
// partial list. (readForm falls back to the event's own values for them.)
const roFieldHTML = v => `<input value="${esc(v||'—')}" disabled>`;
function titleFieldHTML(ev, dis, lab){
  return `<div class="fld full"><label>${lab('title','Title')}</label><input id="f_title" value="${esc(ev.title)}" ${dis} placeholder="e.g. Kabbalat Shabbat">${fieldHintSlot('title')}</div>`;
}
function internalNotesFieldHTML(ev, dis, lab){
  return `<div class="fld full"><label>${lab('description','Internal description')} <span class="hint">(planning team only, never shown publicly)</span></label><textarea id="f_desc" ${dis} placeholder="What's the plan?">${esc(ev.description||'')}</textarea></div>`;
}
function programsFieldHTML(ev, dis, lab, relOK){
  const progList = PROGRAMS.filter(p=>p.id!=='oth' && (p.active!==false || (ev.programs&&ev.programs.includes(p.id))));
  const progSel = (ev.programs&&ev.programs.length?ev.programs:[ev.program]).filter(Boolean);
  return `<div class="fld full"><label>${lab('programs','Program(s)')}</label>
      ${relOK ? `<div class="msel${dis?' dis':''}" id="f_progs" data-sel="${esc(progSel.join(','))}">
        <button type="button" class="msel-btn" ${dis} aria-haspopup="listbox" aria-expanded="false"><span class="msel-label"></span><span class="msel-caret">▾</span></button>
        <div class="msel-menu" role="listbox" hidden>${progList.map(p=>`<label class="msel-opt"><input type="checkbox" value="${p.id}" ${progSel.includes(p.id)?'checked':''} ${dis}><span>${esc(p.name)}</span></label>`).join('')}</div>
      </div>` : roFieldHTML((ev.programNames||[]).join(', '))}
    </div>`;
}
function leadsFieldHTML(ev, dis, lab, relOK){
  return `<div class="fld full"><label>${lab('leads','Leads')} <span class="hint">(program leads auto-added)</span></label>${relOK ? `<div class="typeahead${dis?' dis':''}" id="f_leads"><input class="ta-input" type="text" placeholder="Search leads…" autocomplete="off" ${dis}><div class="ta-menu" hidden></div></div>` : roFieldHTML((ev.leadNames||[]).join(', '))}</div>`;
}
// `#whenFields` is filled by wireEventFields after render.
function whenGroupHTML(ev, dis){
  const sched = ev.scheduling || 'exact';
  return `<div class="fieldgroup">
      <div class="fieldgroup-h">When <span class="fmk" data-fmk="when"></span></div>
      <div class="whenseg" id="f_when">
        <button type="button" data-when="exact" aria-pressed="${sched==='exact'}" ${dis}>Exact date</button>
        <button type="button" data-when="range" aria-pressed="${sched==='range'}" ${dis}>Date range</button>
        <button type="button" data-when="month" aria-pressed="${sched==='month'}" ${dis}>Whole month</button>
      </div>
      <div class="fld full" id="whenFields"></div>
    </div>`;
}
// Where: venue type + venue, the venue's address line (#venueAddr) and add/address
// form (#venueForm; venue-form.js), the street-address note and — on the Listing tab —
// the Address on listing toggle with its hints, all in one block.
function whereGroupHTML(ev, dis, lab, relOK, listing){
  const av = ev.addressVisibility || '';
  const addr = listing ? `<div class="fld full addrvis"><label>${lab('addressVisibility','Address on listing')}</label><div class="whenseg" id="f_addrvis"><button type="button" data-addrvis="Public" aria-pressed="${av==='Public'}" ${dis}>Public</button><button type="button" data-addrvis="Registrants only" aria-pressed="${av==='Registrants only'}" ${dis}>Registrants only</button></div>${fieldHintSlot('addressVisibility')}<span class="hint" id="f_addrhint" hidden>${esc(ADDR_DEFAULT_HINT)}</span><span class="hint warn" id="f_addrwarn" hidden>${esc(ADDR_HOME_PUBLIC_WARN)}</span></div>` : '';
  return `<div class="fieldgroup">
      <div class="fieldgroup-h">${lab('venue','Where')}</div>
      ${relOK ? `<div class="fld full"><label for="f_vtype">Venue type</label><select id="f_vtype" ${dis}>
        <option value="" ${!ev.venueType?'selected':''}>Any</option>
        ${VENUE_TYPES.map(t=>`<option value="${esc(t.id)}" ${t.id===ev.venueType?'selected':''}>${esc(t.name)}</option>`).join('')}
      </select></div>
      <div class="fld full"><div class="typeahead venuepick${dis?' dis':''}" id="f_venue_box"><input class="ta-input" type="text" placeholder="Search venues…" autocomplete="off" ${dis}><div class="ta-menu" hidden></div><div class="venue-other-wrap" hidden><input class="venue-other" type="text" placeholder="New venue name" ${dis}><button type="button" class="venue-clear" aria-label="Clear venue">×</button></div></div></div>
      ${venueSlotsHTML()}`
      : `<div class="fld full">${roFieldHTML([ev.venueTypeName, ev.venueName||ev.venueOther].filter(Boolean).join(' · '))}</div>`}
      <div class="fld full"><span class="hint">The street address is saved on the venue.</span>${fieldHintSlot('venue')}</div>
      ${addr}
    </div>`;
}
// Ticketing (R29): for now just the free General Admission ticket count (Coda
// column Capacity); paid tickets and discount codes will join it here.
function ticketingGroupHTML(ev, dis, lab){
  return `<div class="fieldgroup">
      <div class="fieldgroup-h">Ticketing</div>
      <div class="fld"><label for="f_capacity">${lab('capacity','Free tickets')}</label><input id="f_capacity" type="number" min="0" step="1" value="${ev.capacity!==''&&ev.capacity!=null?esc(ev.capacity):''}" ${dis} placeholder="e.g. 40">${fieldHintSlot('capacity')}<span class="hint">How many free General Admission tickets Eventbrite offers.</span></div>
      <div class="hint">Paid tickets and discount codes: coming later</div>
    </div>`;
}
// Why the fields can't be edited, if they can't.
// `relNote` names the relation fields this view shows ('' = none).
const REL_NOTE = { all:'Program(s), Leads and Where can’t be changed right now because their lists haven’t loaded.',
  where:'Where can’t be changed right now because its lists haven’t loaded.',
  planning:'Program(s) and Leads can’t be changed right now because their lists haven’t loaded.' };
function lockNotesHTML(ev, canEdit, locked, relOK, relNote){
  return `${(relNote && !relOK && canEdit && !locked)?`<div class="locknote">${relNote} Close and reopen the event in a moment, or reload the page.</div>`:``}
    ${(!canEdit)?`<div class="locknote">Sign in as a program lead to edit.</div>`:``}
    ${locked ? (isHistory(ev) ? `<div class="locknote">🔒 This event has happened, so its details are locked.</div>`
      : ev.status==='cancelled' ? `<div class="locknote">🔒 This event is cancelled, so its details are locked.</div>` : '') : ''}`;
}
const fieldLab = ev => { const fm=fieldMarkModel(ev); return (k, t) => fieldLabelHTML(k, t, fm); };

/* The create form (openNewEventForm): every field a new event starts with, in the
   order it always had. */
function renderPlanning(ev, canEdit, locked, canApprove){
  const dis = (!canEdit || locked) ? 'disabled' : '', relOK = relationsReady(ev), lab = fieldLab(ev);
  return titleFieldHTML(ev, dis, lab) + internalNotesFieldHTML(ev, dis, lab)
    + programsFieldHTML(ev, dis, lab, relOK) + leadsFieldHTML(ev, dis, lab, relOK)
    + whenGroupHTML(ev, dis) + whereGroupHTML(ev, dis, lab, relOK, false)
    + lockNotesHTML(ev, canEdit, locked, relOK, REL_NOTE.all);
}
function wirePlanning(panel, ev, canEdit, locked, canApprove){ wireEventFields(panel, ev, canEdit, locked); }

// Wires whichever event fields are rendered (each one is optional).
function wireEventFields(panel, ev, canEdit, locked){
  const sched = ev.scheduling || 'exact';
  // leads (leadership cohort) + venue typeaheads
  const resolveIds = (ids, names) => (ids && ids.length) ? ids : (names||[]).map(n=>peopleIdByName[n]).filter(Boolean);
  const leadsBox=document.getElementById('f_leads'); if(leadsBox) initTypeahead(leadsBox, { selected:resolveIds(ev.leads, ev.leadNames), pool:()=>LEADS_LIST, onChange:scheduleAutosave });
  const venBox=document.getElementById('f_venue_box');
  if(venBox){
    const venEdit=canEdit && !locked;   // add a venue / fix its address: editors of an unlocked event only
    initVenuePicker(venBox, ev, { onChange:()=>{ applyAddressDefault(venBox); paintVenueAddr(); scheduleAutosave(); }, onAdd: venEdit ? openVenueAdd : null });
    wireVenueForm(ev, venEdit);
  }

  // program(s): dropdown multiselect — checking a program appends its Current Leads
  const prog=document.getElementById('f_progs');
  if(prog){
    const btn=prog.querySelector('.msel-btn'), menu=prog.querySelector('.msel-menu'), label=prog.querySelector('.msel-label');
    const syncLabel=()=>{ const on=[...prog.querySelectorAll('input:checked')]; label.textContent = on.length ? on.map(i=>(PROG[i.value]||{}).name||i.value).join(', ') : 'Select programs…'; label.classList.toggle('placeholder', !on.length); };
    syncLabel();
    if(canEdit && !locked){
      btn.addEventListener('click', e=>{ e.stopPropagation(); const open=menu.hidden; document.querySelectorAll('.msel-menu').forEach(m=>m.hidden=true); menu.hidden=!open; btn.setAttribute('aria-expanded', String(open)); });
      menu.addEventListener('click', e=>e.stopPropagation());
      menu.addEventListener('change', e=>{
        const cb=e.target.closest('input[type=checkbox]'); if(!cb) return;
        if(cb.checked && leadsBox && leadsBox.addPerson){
          const p=PROG[cb.value];
          (p && p.currentLeadNames || []).forEach(nm=>{ const id=peopleIdByName[nm]; if(id) leadsBox.addPerson(id); });
        }
        syncLabel(); paintHeadMeta(); scheduleAutosave();
      });
    }
  }
  // The header's title, program tag and subtitle follow the form as you type.
  const tEl=document.getElementById('f_title'), dEl=document.getElementById('f_desc');
  if(tEl) tEl.addEventListener('input', paintHeadMeta);
  if(dEl) dEl.addEventListener('input', paintHeadMeta);

  // Where: venue type — filters the venue search; saves like any field
  const vtSel=document.getElementById('f_vtype');   // absent while the relations show read-only (relationsReady)
  if(vtSel && canEdit && !locked) vtSel.addEventListener('change', scheduleAutosave);

  // when control: mode switch + all-day toggle both re-render the time fields
  const wf=document.getElementById('whenFields');
  if(wf){
    whenType = sched;
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

  // Listing fields (an approved event's Listing tab)
  const sumEl=document.getElementById('f_pubsummary'), sumCount=document.getElementById('f_sumcount');
  if(sumEl && sumCount) sumEl.addEventListener('input', ()=>{ sumCount.textContent=`${sumEl.value.length} / 140`; });
  const ci=panel.querySelector('[data-act="copy-internal"]');
  if(ci) ci.addEventListener('click', ()=>{ const t=panel.querySelector('#f_pubdesc'); if(t){ t.value=(editing&&editing.description)||''; t.dispatchEvent(new Event('input',{bubbles:true})); scheduleAutosave(); } });
  const av=panel.querySelector('#f_addrvis');
  if(av){
    if(canEdit && !locked) av.addEventListener('click', e=>{ const b=e.target.closest('button[data-addrvis]'); if(!b) return; setAddressVisibility(b.dataset.addrvis); const hint=document.getElementById('f_addrhint'); if(hint) hint.hidden=true; paintAddrWarn(); scheduleAutosave(); });
    paintAddrWarn();
  }
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
    ? [...document.querySelectorAll('#f_progs .msel-opt input:checked')].map(b=>b.value)
    : ((editing&&editing.programs&&editing.programs.length) ? editing.programs.slice() : ((editing&&editing.program)?[editing.program]:[]));
  const leads=g('f_leads') ? chipIds('#f_leads .ta-chip') : ((editing&&editing.leads)||[]);
  const volunteers=(editing&&editing.volunteers)||[];   // no editor field — slots/claims supersede it; value round-trips untouched
  const venBox=g('f_venue_box'), venOther=venBox && venBox.querySelector('.venue-other-wrap');
  const venue=venBox ? (venBox.dataset.venueId||'') : ((editing&&editing.venue)||'');
  const venueOther=venBox ? ((venOther && !venOther.hidden) ? venBox.querySelector('.venue-other').value.trim() : '') : ((editing&&editing.venueOther)||'');
  const vtSel=g('f_vtype');
  const venueType=vtSel ? (vtSel.value||'') : ((editing&&editing.venueType)||'');
  const venueName=venBox ? (venue ? ((VENUES.find(v=>v.id===venue)||{}).name||'') : '') : ((editing&&editing.venueName)||'');   // readiness/sync compare by name
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
    leads, volunteers, venueType, venue, venueOther, venueName,
    location: venBox ? ((venue ? ((VENUES.find(v=>v.id===venue)||{}).name||'') : '') || venueOther) : ((editing&&editing.location)||''),   // display fallback
    description:g('f_desc') ? g('f_desc').value.trim() : ((editing&&editing.description)||''),
    planningNotes:(editing && editing.planningNotes)||'',
    capacity: capEl ? (capEl.value.trim()!=='' ? Number(capEl.value) : '') : ((editing&&editing.capacity!=null)?editing.capacity:''),
    addressVisibility: g('f_addrvis') ? ((document.querySelector('#f_addrvis button[aria-pressed="true"]')?.dataset.addrvis) || '') : ((editing && editing.addressVisibility) || ''),
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
