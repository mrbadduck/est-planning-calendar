/* main.js — startup: refresh (fetch + render), init (wiring, first load), and the final init() call.
   Owns: refresh
   Reads: state (state.js)
   Writes: state (state.js)
   Loaded after: help.js (init() must be the last top-level statement, after every listener registration) */

let _refreshing = false;
async function refresh(){
  if(_refreshing) return;                    // don't stack overlapping polls/clicks
  _refreshing = true;
  try { await loadEvents(); applyView(); layoutSticky(); } finally { _refreshing = false; }
}
async function init(){
  buildWeekHead(); renderLayers(); updateNavLabel(); initAuth();
  document.querySelectorAll('#viewSeg button').forEach(b=>b.setAttribute('aria-pressed', String(b.dataset.view===state.view)));   // the saved view
  { const hp=new URL(location.href).searchParams.get('help'); if(hp!==null) openHelp(hp); }   // ?help=<id> opens that guide (works signed out)
  document.getElementById('ovfBtn').addEventListener('click', e=>{ e.stopPropagation(); ovfMenu(); });
  wirePhoneMenu();
  layoutSticky();
  // Wire refresh/focus/poll up front so they work immediately (never dead while loading).
  const rb = document.getElementById('refreshBtn'); if(rb) rb.addEventListener('click', refresh);
  document.addEventListener('visibilitychange', () => { if(!document.hidden){ refresh(); } }); // refetch on tab focus
  setInterval(() => { if(!document.hidden){ refresh(); } }, 60000);    // light 60s poll while visible

  // Kick off ref loads — each hydrates its maps synchronously from cache, then
  // refreshes in the background. They are NOT awaited: the calendar paints without
  // them, events whose relations can't be mapped yet stay `_lossy` (mapRelations)
  // and re-map as each list lands (onRefsLoaded), and an editor opened meanwhile
  // waits for them (openEditor) — for at most 10s, then shows them read-only.
  const refLoads = [loadPrograms(), loadVenues(), loadPeople()];
  Promise.race([Promise.allSettled(refLoads), new Promise(r=>setTimeout(r, 10000))]).then(settleRefs);
  // Instant paint from the last cached events (maps are hydrated above).
  const cachedRows = cacheGet('rows-raw');
  const cachedRefs = cacheGet('references');
  if(cachedRefs && cachedRefs.layers){ rebuildRefs(cachedRefs.layers); renderLayers(); }
  if(cachedRows && cachedRows.length){ state.events = [...cachedRows.map(planningRowToEvent), ...((cachedRefs&&cachedRefs.events)||[])]; applyView(); layoutSticky(); }
  loadNews().then(paintHelpDot, ()=>{});   // What's new dot on the header ? — doesn't wait on the (slower) rows load
  // Fresh events (renders as soon as /rows returns).
  await refresh();
  openFromUrl();                 // deep-link: ?event=<id>&section=<id> opens that event
  setTimeout(scrollCalendarToToday, 60);   // (skipped while a deep-linked page is open: leaving it runs it)
}

// Back/Forward between the calendar and event pages (spec 5.1). The app restores the
// calendar's scroll itself (leaveEventPage), so the browser's own restoration is off.
if('scrollRestoration' in history) history.scrollRestoration='manual';
window.addEventListener('popstate', onPopState);

init();
