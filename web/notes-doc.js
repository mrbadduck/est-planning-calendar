/* notes-doc.js — the Planning tab's Google Doc notes block: embed/create button, polling and the Coda button push.
   Owns: _ndocGen, renderNotes, wireNotes
   Reads: state (state.js); editing (editor-tabs.js)
   Writes: editing.notesDocUrl and the matching state.events row (in pollForNotesDoc)
   Loaded after: editor-tabs.js (reads editing at call time) */

/* ---- Google Doc notes panel ----------------------------------------------
   A Google Doc holds internal planning notes; Coda provisions it and stores the
   URL in the `Notes Doc` column (-> ev.notesDocUrl). We embed a read-only
   /preview iframe (renders only for a viewer signed into Google with access)
   and link out to /edit for real editing. An empty state offers a "Create notes
   doc" button that pushes the Coda button via the proxy; we then poll until the
   URL lands and swap in the read-only /preview embed. */
const _gdocId = u => { const m=String(u||'').match(/\/document\/d\/([A-Za-z0-9_-]+)/); return m?m[1]:''; };
const gdocPreviewUrl = u => { const id=_gdocId(u); return id?`https://docs.google.com/document/d/${id}/preview`:''; };
const gdocEditUrl    = u => { const id=_gdocId(u); return id?`https://docs.google.com/document/d/${id}/edit`:(u||''); };
function notesDocEmbedHTML(url){
  const pv=gdocPreviewUrl(url);
  if(!pv) return `<div class="ndoc-warn">That doesn't look like a Google Doc link.</div>`;
  // Edit button on TOP; the preview fills the remaining panel height and scrolls
  // internally (the .ndoc-full wrapper is a height-bound flex column).
  return `<div class="ndoc-bar">
      <a class="btn sm primary" href="${esc(gdocEditUrl(url))}" target="_blank" rel="noopener">Edit in Google Docs ↗</a>
      <span class="hint">Preview needs you signed into Google with access to the doc.</span>
    </div>
    <iframe class="ndoc-frame" src="${esc(pv)}" title="Planning notes (Google Doc)" loading="lazy"></iframe>`;
}
let _ndocGen = 0;   // bumped when the editor closes / a new create starts — cancels stale notes-doc polls
const NDOC_CREATE_HTML = `<div class="ndoc-empty">
  <button type="button" class="btn sm primary" data-act="ndoc-create">Create notes doc</button>
  <span class="hint">Generates a Google Doc from the planning template.</span>
</div>`;
// The Planning tab's Google Doc block (under the private fields; see renderPlanningTab).
function renderNotes(ev, canEdit){
  let inner;
  if(ev.notesDocUrl)          inner = notesDocEmbedHTML(ev.notesDocUrl);
  else if(canEdit && ev.id)   inner = NDOC_CREATE_HTML;
  else if(canEdit && !ev.id)  inner = `<div class="ndoc-empty"><span class="hint">Save the event first, then add a notes doc.</span></div>`;
  else                        inner = `<div class="ndoc-empty"><span class="hint">No notes doc yet.</span></div>`;
  const legacy = ev.planningNotes ? `<div class="fld full"><label>Legacy notes</label><div class="legacynotes">${esc(ev.planningNotes)}</div></div>` : '';
  return `<div class="ndoc-full ${ev.notesDocUrl?'has-doc':''}" id="f_ndoc">${inner}</div>${legacy}`;
}
function wireNotes(panel, ev, canEdit){
  // "Create notes doc" → push the Coda button via the proxy, then poll for the URL.
  const ndoc=panel.querySelector('#f_ndoc');
  if(!ndoc || !canEdit) return;
  ndoc.addEventListener('click', async e=>{
    const b=e.target.closest('[data-act="ndoc-create"]'); if(!b) return;
    if(!editing || !editing.id){ toast('Save the event first','err'); return; }
    ndoc.classList.remove('has-doc');
    ndoc.innerHTML=`<div class="ndoc-loading"><span class="ndoc-spin"></span> Setting up your notes doc… <span class="hint">(this can take up to a minute)</span></div>`;
    const gen = ++_ndocGen;
    const rowId = editing.id;
    const pushed = await pushNotesDocButton(rowId, gen);   // retries past Coda's row-settle lag
    if(pushed==='cancelled') return;                       // editor closed / superseded
    if(pushed!=='ok'){ toast('Could not start — try again in a moment','err'); if(panel.querySelector('#f_ndoc')) ndoc.innerHTML=NDOC_CREATE_HTML; return; }
    pollForNotesDoc(rowId, 0, gen);
  });
}

// Poll the server rows (bypassing the _recent optimistic overlay via listPlanning)
// until the Copy file button has written the URL into the Notes Doc column, then
// swap the panel to the embed. ~3s cadence, ~40-tick (~3 min) ceiling — the
// pack-action URL write-back can lag ~50s in Coda's list-rows API.
async function pollForNotesDoc(rowId, tries, gen){
  const el = () => document.getElementById('f_ndoc');
  if(tries >= 40){
    const e=el(); if(e && (!editing || editing.id===rowId))
      e.innerHTML=`<div class="ndoc-warn">Still setting up — this can take a minute. Reopen the event to check.</div>`;
    return;
  }
  await new Promise(r=>setTimeout(r, 3000));
  if(gen !== _ndocGen) return;                 // editor closed or a newer create started — stop
  let ev=null;
  try{ const rows=await DB.listPlanning({fresh:true}); ev=rows.find(x=>x.id===rowId); }catch(_){}
  if(ev && ev.notesDocUrl){
    if(editing && editing.id===rowId) editing.notesDocUrl=ev.notesDocUrl;
    const item=state.events.find(x=>x.id===rowId); if(item) item.notesDocUrl=ev.notesDocUrl;
    const e=el(); if(e && (!editing || editing.id===rowId)){ e.innerHTML=notesDocEmbedHTML(ev.notesDocUrl); e.classList.add('has-doc'); }
    toast('Notes doc ready','ok');
    return;
  }
  pollForNotesDoc(rowId, tries+1, gen);
}

// Push the row's notes-doc button, retrying past Coda's read-after-write lag: a
// just-created row 404s from the buttons API for ~20-30s until Coda settles it.
// Returns 'ok' | 'failed' | 'cancelled'. Runs under the spinner; the gen token
// cancels it if the editor closes or a newer create starts.
async function pushNotesDocButton(rowId, gen){
  const deadline = performance.now() + 60000;   // Coda row-settle lag observed 25-45s; budget past it
  for(;;){
    if(gen !== _ndocGen) return 'cancelled';
    try{ await DB.createNotesDoc(rowId); return 'ok'; }
    catch(err){
      if(err && err.status===404 && performance.now() < deadline){ await new Promise(r=>setTimeout(r, 4000)); continue; }
      console.warn('notes-doc push failed:', err && err.status, err && err.message);
      return 'failed';
    }
  }
}
