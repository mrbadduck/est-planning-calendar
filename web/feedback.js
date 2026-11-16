/* feedback.js — the votable Feedback / Ideas board and the Feedback & ideas modal.
   Owns: feedbackBoardHTML, _fbStatusLabel, fbItemHTML, wireFeedback, openFeedback
   Reads: state (state.js); DB (data.js)
   Writes: editing (editor-tabs.js, in openFeedback)
   Loaded after: tab-potluck.js (file-map order; no load-time dependency) */

function feedbackBoardHTML(context){
  const signedIn = !!(state.identity && state.identity.matched);
  return `<div class="fbboard" data-ctx="${context}">
    ${signedIn ? `<div class="fbform"><textarea class="fbtext" rows="2" placeholder="Suggest an idea…"></textarea><button type="button" class="btn sm primary" data-act="fb-submit">Submit</button></div>` : `<div class="hint">Sign in to add or +1 ideas.</div>`}
    <div class="fblist" aria-live="polite"><div class="hint">Loading ideas…</div></div>
  </div>`;
}
// Ideas of every status show (New included) so newly-submitted, un-triaged ideas
// are visible + differentiable from ones the council has Planned/Shipped.
const _fbStatusLabel = s => ({New:'New',Planned:'Planned',Shipped:'Shipped',Declined:'Declined'}[s]||'New');
function fbItemHTML(it){
  const canVote = !!(state.identity && state.identity.matched);
  const st = it.status||'New';
  return `<div class="fbitem"><button type="button" class="fbvote${it.votedByMe?' on':''}" data-vote="${esc(it.id)}" ${canVote?'':'disabled'} aria-label="Upvote">▲ ${it.votes||0}</button>`
    + `<span class="fbidea">${esc(it.idea)}</span><span class="fbstatus fbst-${st.toLowerCase()}">${esc(_fbStatusLabel(st))}</span></div>`;
}
async function wireFeedback(root, context){
  const board=root.querySelector('.fbboard'); if(!board) return;
  const list=board.querySelector('.fblist');
  let items=[];
  const paint=()=>{ list.innerHTML = items.length ? items.map(fbItemHTML).join('') : `<div class="hint">No ideas yet — be the first.</div>`; };
  const reload=async()=>{ items=await DB.listFeedback(context); paint(); };
  await reload();
  board.addEventListener('click', async e=>{
    const sb=e.target.closest('[data-act="fb-submit"]');
    if(sb){
      const ta=board.querySelector('.fbtext'); const val=(ta.value||'').trim();
      if(!val){ toast('Write an idea first','err'); return; }
      try{
        await DB.submitFeedback(val, context); ta.value='';
        // Optimistic: show it immediately (Coda's read-after-write lag can hide it
        // from an instant re-fetch). Reconcile shortly after.
        items.unshift({ id:'_tmp'+Date.now(), idea:val, context, votes:0, votedByMe:false, status:'New', submittedByName:(state.identity&&state.identity.name)||'' });
        paint(); toast('Idea submitted','ok');
        setTimeout(reload, 2500);
      }catch(err){ toast(err.message||'Submit failed','err'); }
      return;
    }
    const vb=e.target.closest('[data-vote]');
    if(vb){
      const id=vb.dataset.vote; if(id.startsWith('_tmp')){ toast('Just a sec — saving…','busy'); return; }
      try{ const r=await DB.voteFeedback(id); const it=items.find(x=>x.id===id); if(it){ it.votes=r.votes; it.votedByMe=r.votedByMe; paint(); } }
      catch(err){ if(err.status===401&&typeof sessionExpired==='function') sessionExpired(); else toast(err.message||'Vote failed','err'); }
    }
  });
}

/* feedback / ideas modal */
function openFeedback(){
  if(leaveGuard(()=>openFeedback())) return;
  leaveForm();   // (reachable by keyboard while an event is open — its edits must not be lost or misfiled)
  editing={id:'__feedback__'};
  document.getElementById('modal').classList.remove('ws'); document.getElementById('mBody').classList.remove('ws');
  document.getElementById('mStripe').style.setProperty('--c','var(--accent)');
  document.getElementById('mTitle').textContent='Feedback & ideas';
  document.getElementById('mBadges').innerHTML=''; clearHeadMeta(); document.getElementById('mActions').innerHTML=''; document.getElementById('mFoot').innerHTML=`<span class="push"></span><button class="btn" data-act="close">Close</button>`;
  const body=document.getElementById('mBody'); body.innerHTML=`<div class="fld full"><div class="hint">Suggest anything, or +1 an idea. For section-specific ideas, open an event and visit that section.</div>${feedbackBoardHTML('General')}</div>`;
  wireFeedback(body,'General'); show();
}
