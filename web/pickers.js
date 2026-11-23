/* pickers.js — the Leads/Volunteers typeahead and the Venue picker widgets.
   Owns: initTypeahead, initVenuePicker
   Reads: VENUES, VENUE_TYPES, venueTypeIdByName, PEOPLE_LIST, peopleById (data.js); esc (util.js); VenueAddress.offerAdd (venue-address.js)
   Writes: nothing
   Loaded after: data.js (reads its reference lists) */

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
   Venue Type select, closed hidden). With opts.onAdd, the last row is
   + Add "<typed>" as a venue whenever no venue has exactly that name
   (VenueAddress.offerAdd); it hands the text to onAdd (the Add a venue dialog,
   venue-form.js), which returns falsy when the form can't open (the typed text stays). Without onAdd, "＋ New venue" drops the text into other-mode (an
   editable field with a clear ✕ that returns to select mode) — other-mode still
   shows an event's stored Venue (other). State lives on container.dataset.venueId /
   the visible other input. container.pickVenue(id) selects a venue from outside
   (a just-added one) and fires onChange like a pick; pendVenue(name)/unpendVenue() show
   and drop a venue still being added (nothing fires). */
function initVenuePicker(container, ev, opts){
  opts = opts || {};
  const input = container.querySelector('.ta-input');
  const menu  = container.querySelector('.ta-menu');
  const otherWrap = container.querySelector('.venue-other-wrap');
  const otherInput = container.querySelector('.venue-other');
  const disabled = input.disabled;
  let ready = false;
  const fire = () => { if(ready && opts.onChange) opts.onChange(); };   // user edits only (not initial state)
  const selTypeId = () => { const s=document.getElementById('f_vtype'); return s ? s.value : ''; };
  const typeName = () => (VENUE_TYPES.find(x=>x.id===selTypeId())||{}).name;
  const pool = () => { const tn=typeName(); return VENUES.filter(v=>!v.closed && (!tn || v.type===tn)).slice().sort((a,b)=>a.name.localeCompare(b.name)); };
  let active = -1;
  const clearPill = () => [...container.querySelectorAll('.ta-chip')].forEach(c=>c.remove());
  function showSelect(){ container.dataset.venueId=''; clearPill(); otherWrap.hidden=true; otherInput.value=''; input.hidden=false; input.value=''; menu.hidden=true; if(!disabled) input.focus(); fire(); }
  function selectVenue(v){
    container.dataset.venueId=v.id; clearPill(); otherWrap.hidden=true; input.hidden=true; menu.hidden=true;
    const tid=venueTypeIdByName[v.type], sel=document.getElementById('f_vtype');   // sync the type picker to the venue
    if(sel && tid) sel.value=tid;
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
    const typed=input.value.trim();
    let html = ms.map((v,i)=>`<div class="ta-opt${i===0?' active':''}" data-id="${esc(v.id)}">${esc(v.name)}</div>`).join('');
    if(!opts.onAdd) html += `<div class="ta-opt ta-new${ms.length?'':' active'}" data-new="1">＋ New venue: "${esc(typed)}"</div>`;
    else if(VenueAddress.offerAdd(typed, VENUES)) html += `<div class="ta-opt ta-new" data-add="1">+ Add "${esc(typed)}" as a venue</div>`;
    if(!html) html = '<div class="ta-empty">No match</div>';   // the name exists, but closed or of another type
    menu.innerHTML=html; active = 0; menu.hidden=false; paint();
  }
  // initial state
  if(ev.venue && VENUES.some(v=>v.id===ev.venue)) selectVenue(VENUES.find(v=>v.id===ev.venue));
  else if(ev.venueOther) enterOther(ev.venueOther);
  else showSelect();
  container.pickVenue = id => { const v=VENUES.find(x=>x.id===id); if(v) selectVenue(v); return !!v; };
  // A venue being added (venue-form.js): shown as picked, with a spinner and no ×, while
  // the picker's state (dataset.venueId, the other text) stays as it was, so nothing
  // fires and a save meanwhile writes the event's Venue as it stands.
  container.pendVenue = name => {
    container.unpendVenue(); container.classList.add('venue-pending'); menu.hidden=true;
    const chip=document.createElement('span'); chip.className='ta-chip venue-pick venue-pend';
    chip.innerHTML=`<span class="ndoc-spin" aria-hidden="true"></span>${esc(name)}`;
    container.insertBefore(chip, container.firstChild);
  };
  container.unpendVenue = () => { container.classList.remove('venue-pending'); container.querySelectorAll('.venue-pend').forEach(c=>c.remove()); };
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
    if(o.dataset.add){ const t=input.value.trim(); closeMenu(); if(opts.onAdd(t)) input.value=''; }   // kept when the form can't open (an add still in flight)
    else if(o.dataset.new){ enterOther(input.value.trim()); } else { const v=VENUES.find(x=>x.id===o.dataset.id); if(v) selectVenue(v); }
  });
}
