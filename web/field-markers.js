/* field-markers.js — the Eventbrite sync icons, hints and tags on field labels, and the listing card (in the panel, or atop Listing).
   Owns: ICON_PRIVATE, TIP_PRIVATE, ADDR_DEFAULT_HINT, ADDR_HOME_PUBLIC_WARN, fmkIcon, fieldMarkModel, fieldLabelHTML, fieldHintSlot, listingCardHome, listingCardHTML, paintFieldMarks
   Reads: state (state.js); editing (editor-tabs.js); _ctx (editor.js); _ebStatus, _conflictShown (eventbrite.js)
   Writes: _conflictShown (eventbrite.js; add/delete)
   Loaded after: notes-doc.js (file-map order; no load-time dependency) */

/* ---- Eventbrite listing on the Listing tab (spec 5.4, 5.7; D1, D4) -----------
   The form always shows the event's own (Coda) values. Nothing read from
   Eventbrite is ever put into the form or written to Coda: sync status compares
   the form with `ev.pushed`, the snapshot the Worker stores on each push (Last EB
   pushed values, read-only here). Every region that changes while the editor is
   open has a stable container, repainted with paintInner: the field markers
   ([data-fmk]), their hints ([data-fhint]) and the
   listing card (#listingCard, which Task 14 fills with the live status). */
// One sync icon per public field (R20): a gray clock before the event is on
// Eventbrite; once it is, a green check (matches), an amber sync arrow (changed
// here) or a gray sync arrow (not compared yet). Private fields: the crossed eye.
const ICON_PENDING = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7.5V12l3 2"/></svg>`;
const ICON_MATCH = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M8 12.5l2.7 2.7L16.5 9"/></svg>`;
const ICON_SYNC = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 11a8 8 0 0 0-14.5-4.5L4 8"/><path d="M4 3.5V8h4.5"/><path d="M4 13a8 8 0 0 0 14.5 4.5L20 16"/><path d="M20 20.5V16h-4.5"/></svg>`;
const ICON_PRIVATE = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 3l18 18"/><path d="M10.6 5.1A10.9 10.9 0 0 1 12 5c6 0 9.5 7 9.5 7a17.6 17.6 0 0 1-3 3.9"/><path d="M6.1 6.1A17.4 17.4 0 0 0 2.5 12S6 19 12 19a9.6 9.6 0 0 0 5.1-1.4"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/></svg>`;
const TIP_PRIVATE = 'Private: only leads and council see this. Never sent to Eventbrite.';
const TIP_PENDING = 'Goes on the Eventbrite listing once this event is added to Eventbrite.';
const TIP_MATCH = 'Matches the Eventbrite listing.';
const TIP_CHANGED = 'Changed here. Not on Eventbrite yet.';
const TIP_UNKNOWN = 'Not compared with Eventbrite yet.';
// The one sync icon for a public field, by state (pending | match | changed | unknown).
const SYNC_ICON = {
  pending: ['pend', ICON_PENDING, TIP_PENDING, 'Goes on the Eventbrite listing'],
  match:   ['ok',   ICON_MATCH,   TIP_MATCH,   'Matches Eventbrite'],
  changed: ['chg',  ICON_SYNC,    TIP_CHANGED, 'Changed here, not on Eventbrite yet'],
  unknown: ['unk',  ICON_SYNC,    TIP_UNKNOWN, 'Not compared with Eventbrite yet'],
};
const ADDR_DEFAULT_HINT = 'Set to Registrants only because this venue is a private home. The public sees just "Nashville, TN".';
const ADDR_HOME_PUBLIC_WARN = 'This is a private home. Its full street address will be public on Eventbrite.';
const fmkIcon = (cls, icon, tip, aria) => `<span class="fic${cls?' '+cls:''}" role="img" data-tip="${esc(tip)}" aria-label="${esc(aria)}">${icon}</span>`;
// What the markers show for the open editor: sync status per public field (only
// once the event is on Eventbrite) and the fields the next action is waiting on —
// the same set as the footer's links.
function fieldMarkModel(ev){
  const R=ListingRules, linked=!!ev.eventbriteId;
  const sync = linked ? R.syncStatus(ev, ev.pushed || null) : {};
  const needed = {};
  if(_ctx && _ctx.ev===ev) for(const l of editorFooterModel(ev, _ctx).links) if(l.field) (needed[l.field] = needed[l.field] || []).push(l.label);
  return { linked, pushed: linked ? (ev.pushed || null) : null, sync, needed };
}
// A field label's marker (spec 5.7, R20): exactly one icon. Eye-off for private
// fields; for public ones the sync icon (SYNC_ICON) for its state. Tags: amber
// "● Not on Eventbrite yet" when it differs; red "Needed for Eventbrite" when the
// next step is waiting on it.
function fieldSyncState(key, m){
  if(!m.linked) return 'pending';
  return m.sync[key] || 'unknown';
}
function fieldMarksHTML(key, m){
  const F=ListingRules.FIELDS[key];
  if(!F) return '';
  if(!F.public) return fmkIcon('', ICON_PRIVATE, TIP_PRIVATE, 'Private, never on Eventbrite');
  const st = fieldSyncState(key, m);
  let h = fmkIcon(...SYNC_ICON[st]);
  if(m.needed[key]) h += `<span class="ftag req">Needed for Eventbrite</span>`;
  if(st==='changed') h += `<span class="ftag chg">● Not on Eventbrite yet</span>`;
  return h;
}
// How a pushed value reads in the "Eventbrite: …" hint.
function pushedText(key, v){
  const s = v==null ? '' : String(v).trim();
  if(key==='date') return s ? fmtDate(s) : '(no date)';
  if(key==='start' || key==='end') return s ? ListingRules.fmtTime(s) : '(no time)';   // "6:00 PM", as in changeNotice
  if(key==='venue') return s || 'Online';
  if(key==='addressVisibility') return s || 'Public';
  if(!s) return '(empty)';
  return s.length>90 ? s.slice(0,90)+'…' : s;
}
function fieldHintHTML(key, m){
  let h='';
  if(key==='venue' && m.needed.venue) h += m.needed.venue.map(t=>`<div class="hint err">${esc(t)}</div>`).join('');
  if(m.sync[key]==='changed' && m.pushed){
    const F=ListingRules.FIELDS[key];
    h += `<div class="hint">Eventbrite: ${esc(pushedText(key, m.pushed[F.pushedKey]))}</div>`;
  }
  return h;
}
// Label text + its marker container (the label never moves; only the markers repaint).
function fieldLabelHTML(key, labelText, m){
  return `${labelText} <span class="fmk" data-fmk="${key}">${fieldMarksHTML(key, m || fieldMarkModel(editing || {}))}</span>`;
}
const fieldHintSlot = key => `<div class="fhint" data-fhint="${key}"></div>`;
// Where the listing card (#listingCard) lives: 'panel' (the Status & next step panel,
// under the status card, spec 5.3) or 'tab' (the top of the Listing tab, phones,
// spec 5.6). The one switch: statusPanelHTML and renderDetails both ask it, so only
// one #listingCard is ever in the DOM. (Task 12 flips it to 'tab' by PHONE_MQ.)
function listingCardHome(){ return 'panel'; }
// The listing card, at every stage, with Preview listing (R26). Before
// the event is on Eventbrite it is one modest row ("Not on Eventbrite yet" + the
// button; the preview is built from the form). Once it is, the registered
// count comes from the live status (refreshEbStatus) and is left out until it
// loads. Counts and the tickets line show what was pushed (what Eventbrite has),
// never the form's Free tickets. The conflict notice (D8) shows when Eventbrite was
// edited since our last push; once it has been shown, the next push overwrites.
// Everyone gets Preview listing; Eventbrite's own copy (the Worker route,
// write-role gated) only for leads and council — read-only viewers see the
// version built from the fields (openPreview).
const PREVIEW_BTN = `<button type="button" class="btn xs" data-pv-open>Preview listing</button>`;
function listingCardHTML(ev){
  if(!ev.eventbriteId){
    const ended = ev.status==='cancelled' || !!(_ctx && _ctx.past);   // never going on Eventbrite now
    return `<div class="ebrow"><span class="ftag pre lg">Not on Eventbrite yet</span>${ended?'':`<span class="hint">Nobody sees it until it's added and published.</span>`}<span class="ebacts">${PREVIEW_BTN}</span></div>`;
  }
  const pub = ev.publishStatus==='Published';
  const pill = pub ? `<span class="ftag ok lg">Public</span>` : `<span class="ftag chg lg">Private draft</span>`;
  const st = _ebStatus.get(ev.id), sold = st && st.sold!=null ? Number(st.sold) : null;
  const cap = ebCapacity(ev);
  const count = sold==null ? '' : cap ? ` · ${sold} of ${cap} registered` : ` · ${sold} registered`;
  const line = pub ? 'Registration open' + count : 'Nobody can see this listing or register yet.';
  const view = pub && /^https?:\/\//i.test(String(ev.eventbriteUrl||'')) ? `<a class="ebview" href="${esc(ev.eventbriteUrl)}" target="_blank" rel="noopener">View on Eventbrite ↗</a>` : '';
  const qty = ev.pushed && Number(ev.pushed.capacity) > 0 ? ` · ${Number(ev.pushed.capacity)}` : '';
  const err = ev.publishStatus==='Error' && ev.lastPublishError ? `<div class="ndoc-warn">${esc(ev.lastPublishError)}</div>` : '';
  // In the panel the status card's sentence right above already carries the conflict notice.
  const conflict = ebConflict(ev.id) && listingCardHome()==='tab' ? `<div class="ndoc-warn">${esc(EB_CONFLICT_NOTICE)}</div>` : '';
  return `<div class="ebrow">${pill}<b>${esc(line)}</b><span class="ebacts">${view}${PREVIEW_BTN}</span></div>
    <div class="ebrow hint"><span>Tickets: General Admission · free${qty}</span></div>${conflict}${err}`;
}
// Repaint every marker, hint and the card from the open editor's event.
// Called with the footer (open, tab switch, every save-state change), so markers
// follow the same event state the footer reads.
function paintFieldMarks(){
  const panel=document.getElementById('wpanel');
  if(!panel || !editing || !_ctx || _ctx.ev!==editing) return;
  const m=fieldMarkModel(editing);
  panel.querySelectorAll('[data-fmk]').forEach(el=>{
    let key=el.dataset.fmk;
    if(key==='when'){   // the When heading carries the date's tag while there is no Date field
      paintInner(el, m.needed.date && !document.getElementById('f_date') ? `<span class="ftag req">Needed for Eventbrite</span>` : '');
      return;
    }
    paintInner(el, fieldMarksHTML(key, m));
  });
  panel.querySelectorAll('[data-fhint]').forEach(el=>paintInner(el, fieldHintHTML(el.dataset.fhint, m)));
  const c=document.getElementById('listingCard');
  if(c){
    paintInner(c, listingCardHTML(editing));
    // The next push may overwrite only right after a real notice was seen (D8).
    if(editing.eventbriteId && ebConflict(editing.id)) _conflictShown.add(editing.id); else _conflictShown.delete(editing.id);
  }
  const dh=document.getElementById('f_pubdeschint'); if(dh) paintInner(dh, esc(pubDescHintText(!!editing.eventbriteId)));
}
