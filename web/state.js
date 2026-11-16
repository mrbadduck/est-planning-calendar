/* state.js — per-device prefs, the `state` object, program-year dates, loadEvents,
   the _recent/_unsaved local-copy guards, refs settling and date bucketing.
   Owns: prefs, savePrefs, savedLayer, state, MONTHS, WD, pad, ymd, todayStr, _recent, markRecent, _unsaved, loadEvents, onRefsLoaded, relationsReady, _refsSettled, settleRefs, afterRefs, eventsByDate, monthKey, roughByMonth
   Reads: _live (data.js, in relationsReady); editing, _applying (app.js)
   Writes: _unconfirmed (app.js; deletes entries), state (declares it)
   Loaded after: pickers.js (file-map order; no load-time dependency beyond data.js) */

/* =========================================================================
   STATE + RENDER
   ========================================================================= */
// Per-device view settings — the calendar layers and (above phone width) the view —
// so a lead's choices survive reloads. Only layers someone has switched are stored:
// a reference calendar they never touched keeps following its Coda `Default on`.
// (Layer ids are slugs of the calendar's name, so renaming one resets it to default.)
const PREFS_KEY = 'est-view-prefs';
const prefs = (()=>{ try{ const p=JSON.parse(localStorage.getItem(PREFS_KEY)||'null'); return (p && typeof p==='object') ? p : {}; }catch(_){ return {}; } })();
if(!prefs.layers || typeof prefs.layers!=='object') prefs.layers={};
function savePrefs(){ try{ localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); }catch(_){} }
function savedLayer(id){ const v=prefs.layers[id]; return typeof v==='boolean' ? v : undefined; }

const state = {
  startYear: 2026,           // program year = Sep(startYear) .. Aug(startYear+1)
  view: ['overview','year','list'].includes(prefs.view) ? prefs.view : 'overview',   // 'overview' (default) | 'year' (Calendar) | 'list' — phones always get 'list' (curView)
  role: 'vp',                // legacy; superseded by identity from /me
  currentUser: 'Eric',
  idToken: null,
  identity: null,            // { signedIn, matched, name, canWrite, canApprove }
  authResolved: false,       // has Firebase yielded its first token / signed-out signal?
  layers: { planning: savedLayer('planning') ?? true },   // ref-layer keys added dynamically from /references
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
// Events with edits the save queue hasn't written yet: id -> { ev: the edited
// object, before: the saved values of the fields it changed }. A re-fetch keeps
// showing the edited object until it saves; if it can't be saved, `before` puts
// it back (dropFailedEdits).
const _unsaved = new Map();
async function loadEvents(){
  const [p,r] = await Promise.all([DB.listPlanning(), DB.listReferences()]);
  const now = Date.now();
  for(const [id,rec] of [..._recent]) if(rec.until <= now && !((_applying.get(id)||0) > 0)) _recent.delete(id);   // held while a write to it is still applying
  const local = id => (_unsaved.get(id)||{}).ev || (_recent.get(id)||{}).e;
  const planning = p.filter(ev => !(_recent.get(ev.id)||{}).deleted)   // hide just-deleted
                    .map(ev => local(ev.id) || ev);                      // keep just-edited / not yet saved
  for(const id of new Set([..._unsaved.keys(), ..._recent.keys()])){ const e=local(id); if(e && !p.some(x=>x.id===id)) planning.push(e); }   // keep just-created
  for(const e of planning) if(e._lossy && e!==editing) mapRelations(e);   // a list may have landed while these rows were loading
  state.events = [...planning, ...r];
  // An insert Coda never confirmed is confirmed once its row is in /rows.
  for(const id of [..._unconfirmed.keys()]) if(p.some(x=>x.id===id)){ _unconfirmed.delete(id); if(editing && editing.id===id) paintSaveStatus(); }
}
// A reference list just arrived: map the events that were waiting on it (colors,
// relation ids) and repaint. The open editor's event is left alone — it re-maps
// when it's next opened, never under a form that's showing it.
function onRefsLoaded(){
  let changed=false;
  for(const e of state.events) if(e.source==='planning' && e._lossy && e!==editing && mapRelations(e)) changed=true;
  if(changed) rerender();
  document.dispatchEvent(new CustomEvent('est:refs'));
}
// May the editor offer this event's Program(s)/Leads/Venue pickers? Only once every
// list is loaded and its stored names all map — otherwise a picker would show, and
// a save would write, a partial list.
function relationsReady(ev){ return _live.programs && _live.people && _live.venues && _live.venueTypes && !(ev && ev._lossy); }
// Set once the first reference-list loads have finished (or after 10s) — see init.
// An editor waiting on the lists stops waiting then and shows them read-only.
let _refsSettled=false;
function settleRefs(){ _refsSettled=true; document.dispatchEvent(new CustomEvent('est:refs')); }
function afterRefs(fn){ document.addEventListener('est:refs', fn, { once:true }); }   // next list update: one landed, or all settled

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
