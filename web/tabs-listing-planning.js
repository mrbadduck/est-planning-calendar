/* tabs-listing-planning.js — the Listing (id 'details') and Planning tab panels and the private-home address-default rules.
   Owns: pubDescHintText, renderDetails, wireDetails, renderPlanningTab, wirePlanningTab, formVenueRecord, paintAddrWarn, applyListingAddressDefault, setAddressVisibility, applyAddressDefault
   Reads: editing (editor-tabs.js); reference lists (data.js); _form (save.js)
   Writes: nothing
   Loaded after: fields.js (file-map order; no load-time dependency) */

/* Listing tab = the listing, in the order Eventbrite shows it: Title, Summary,
   Description, When, Where (with Address on listing), Ticketing (Free tickets). Every field shows
   and is editable at every stage (R27); the approval gate is on Add to Eventbrite /
   Publish, not on the fields. Cancelled and past events keep their locks.
   The listing card (#listingCard, a stable container repainted in place, with
   Preview listing, R26) sits in the panel, or on top of this tab where
   listingCardHome() says so (phones). The fields always show the event's own
   (Coda) values (D4). */
const pubDescHintText = linked => linked ? 'Editing here turns the description into plain text on Eventbrite (any bold, links or lists added there are removed).'
  : 'If you copy the internal description, take out planning notes first. This text goes public.';
function renderDetails(ev, canEdit, locked, canApprove){
  const dis = (!canEdit || locked) ? 'disabled' : '', relOK = relationsReady(ev), lab = fieldLab(ev);
  const linked = !!ev.eventbriteId;
  const card = listingCardHome()==='tab' ? `<div class="ebcard" id="listingCard">${listingCardHTML(ev)}</div>` : '';   // else it's in the panel
  const summary = `<div class="fld full"><label>${lab('publicSummary','Summary')} <span class="hint" id="f_sumcount">${String(ev.publicSummary||'').length} / 140</span></label><input id="f_pubsummary" maxlength="140" value="${esc(ev.publicSummary||'')}" ${dis} placeholder="One-line blurb for the listing">${fieldHintSlot('publicSummary')}</div>
    <div class="fld full"><label>${lab('publicDescription','Description')} <button type="button" class="btn xs" data-act="copy-internal" ${dis}>Copy internal description</button></label><textarea id="f_pubdesc" rows="4" ${dis} placeholder="What attendees see on Eventbrite">${esc(ev.publicDescription||'')}</textarea>${fieldHintSlot('publicDescription')}
      <span class="hint" id="f_pubdeschint">${pubDescHintText(linked)}</span></div>`;
  return card + titleFieldHTML(ev, dis, lab) + summary + whenGroupHTML(ev, dis)
    + whereGroupHTML(ev, dis, lab, relOK, true) + ticketingGroupHTML(ev, dis, lab)
    + lockNotesHTML(ev, canEdit, locked, relOK, REL_NOTE.where);
}
function wireDetails(panel, ev, canEdit, locked, canApprove){
  wireEventFields(panel, ev, canEdit, locked);
  const card=panel.querySelector('#listingCard');   // stable container: its inside repaints (here only on phones; the panel handles its own)
  if(card) card.addEventListener('click', e=>{ if(e.target.closest('[data-pv-open]')) openPreview(); });
}

/* Planning tab: the private fields — Program(s), Leads, Internal description — then the
   event's Google Doc. The fields take the Details lock (cancelled, or a past
   approved event); the notes doc only the cancelled one. */
function renderPlanningTab(ev, canEdit, fieldsLocked, docLocked){
  const dis = (!canEdit || fieldsLocked) ? 'disabled' : '', relOK = relationsReady(ev), lab = fieldLab(ev);
  return `<div class="frow2">${programsFieldHTML(ev, dis, lab, relOK)}${leadsFieldHTML(ev, dis, lab, relOK)}</div>`
    + internalNotesFieldHTML(ev, dis, lab)
    + `<div class="fld full ndoc-fld"><label>Planning notes doc <span class="fmk">${fmkIcon('', ICON_PRIVATE, TIP_PRIVATE, 'Private, never on Eventbrite')}</span></label>${renderNotes(ev, canEdit && !docLocked)}</div>`
    + lockNotesHTML(ev, canEdit, fieldsLocked, relOK, REL_NOTE.planning);
}
function wirePlanningTab(panel, ev, canEdit, fieldsLocked, docLocked){
  wireEventFields(panel, ev, canEdit, fieldsLocked);
  wireNotes(panel, ev, canEdit && !docLocked);
}

// The venue the form currently names: the picker's pick, else the event's own.
function formVenueRecord(){
  const box=document.getElementById('f_venue_box');
  if(!box) return venueRecord(editing);
  const v=VENUES.find(x=>x.id===box.dataset.venueId);
  return v ? { name:v.name, type:v.type||'', hasAddress:!!v.hasAddress } : null;
}
// R13: a private home with an explicit Public address visibility gets a warning,
// never an override.
function paintAddrWarn(){
  const w=document.getElementById('f_addrwarn'), seg=document.getElementById('f_addrvis'); if(!w || !seg) return;
  const pressed=seg.querySelector('button[aria-pressed="true"]'), venue=formVenueRecord();
  w.hidden = !(pressed && pressed.dataset.addrvis==='Public' && venue && venue.type==='Home');
}
// R14: an approved event at a private home whose address visibility was never set
// gets Registrants only when its listing shows (it overrides no choice), and the
// autosave writes it. Runs once the form's baseline exists, so the change saves.
// The toggle shows at every stage (R27), but opening a draft or proposal writes
// nothing: the default lands once it's approved (the Worker and the preview apply
// the same rule meanwhile).
function applyListingAddressDefault(){
  const seg=document.getElementById('f_addrvis');
  if(!seg || !editing || editing.status!=='approved' || !_form || _form.ev!==editing || seg.querySelector('button[aria-pressed="true"]')) return;
  const next=ListingRules.addressVisibilityDefault('', formVenueRecord());
  if(!next) return;
  setAddressVisibility(next);
  const hint=document.getElementById('f_addrhint'); if(hint) hint.hidden=false;
  paintAddrWarn(); scheduleAutosave();
}
function setAddressVisibility(val){
  const seg=document.getElementById('f_addrvis'); if(!seg) return false;
  [...seg.querySelectorAll('button[data-addrvis]')].forEach(x=>x.setAttribute('aria-pressed', String(x.dataset.addrvis===val)));
  return true;
}
// Picking a private-home venue while the address visibility is still unset sets it
// to Registrants only and says why (spec 5.7). Runs only when the venue picker
// changes, and never overrides a value someone chose — an explicit Public stays.
function applyAddressDefault(venBox){
  const seg=document.getElementById('f_addrvis'); if(!seg || !venBox) return;   // the toggle is on Details only
  const pressed=seg.querySelector('button[aria-pressed="true"]');
  const current=pressed ? pressed.dataset.addrvis : '';
  const next=ListingRules.addressVisibilityDefault(current, formVenueRecord());
  if(next===current){ paintAddrWarn(); return; }
  setAddressVisibility(next);
  const hint=document.getElementById('f_addrhint'); if(hint) hint.hidden=false;
  paintAddrWarn();
}
