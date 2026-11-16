/* help.js — the Help drawer: guides + What's new, legend embed, search, URL sync, the once-per-device Welcome.
   Owns: help, openHelp, loadNews, paintHelpDot
   Reads: state (state.js); REF_LAYERS (data.js); pageOpen (editor.js)
   Writes: nothing
   Loaded after: auth.js, which loads after shell.js (its Escape keydown listener keeps its place after preview.js, requestClose and the ⋮ menu; it registers before main.js's init()) */

/* =========================================================================
   HELP — the Help drawer. Guides live in web/help/guide.md and What's new in
   web/help/whats-new.md; HelpLib (web/help/help-lib.js) parses + renders them.
   Entry points: the header ?, the editor/create-form ?, the status badge, the
   sign-in gate link, ?help=<id>, and a once-per-device Welcome. App code names
   a guide ONLY via openHelp('<id>'), help:'<id>' or data-help="<id>" — the
   forms scripts/check-help.mjs verifies. Design:
   docs/superpowers/specs/2026-09-29-in-app-help-design.md
   ========================================================================= */
const HELP_WELCOMED_KEY='est-help-welcomed';   // set once the Welcome has auto-opened on this device
const HELP_SEEN_KEY='est-help-seen';           // newest What's-new date this device has seen
const HELP_RETURNING=!!cacheGet('rows-raw');   // used the app before? (read before init() refreshes the row cache).
                                               // A first visit that signs in by emailed link counts as returning — /rows is cached while signed out — so that user just keeps the What's new dot.
const help={ guides:null, news:null, view:'index', id:'', query:'', opener:null };
let _helpP=null, _newsP=null;

// localStorage for help state: undefined = storage unavailable (so never nag), null = unset.
function helpGet(k){ try{ return localStorage.getItem(k); }catch(_){ return undefined; } }
function helpSet(k,v){ try{ localStorage.setItem(k,v); return true; }catch(_){ return false; } }

async function fetchHelpFile(name){
  const r=await fetch(`help/${name}`, { cache:'no-cache' });   // revalidate: a deploy shows up on the next page load
  if(!r.ok) throw new Error(`help/${name}: ${r.status}`);
  return r.text();
}
function loadNews(){
  if(!_newsP) _newsP=fetchHelpFile('whats-new.md')
    .then(md=>{ help.news=HelpLib.parseWhatsNew(md).entries; return help.news; })
    .catch(err=>{ _newsP=null; throw err; });
  return _newsP;
}
function loadHelp(){
  if(!_helpP) _helpP=Promise.all([fetchHelpFile('guide.md'), loadNews().catch(()=>null)])
    .then(([md])=>{ help.guides=HelpLib.parseGuide(md).guides; })
    .catch(err=>{ _helpP=null; throw err; });
  return _helpP;
}

function latestNews(){ return (help.news && help.news[0] && help.news[0].date) || ''; }
function newsUnseen(){ const latest=latestNews(), seen=helpGet(HELP_SEEN_KEY); return !!latest && seen!==undefined && (!seen || latest>seen); }
function markNewsSeen(){ const latest=latestNews(); if(latest) helpSet(HELP_SEEN_KEY, latest); paintHelpDot(); }
function paintHelpDot(){
  const b=document.getElementById('helpBtn'); if(!b) return;
  const unseen=newsUnseen();
  b.classList.toggle('has-news', unseen);
  b.setAttribute('aria-label', unseen ? 'Help (new updates)' : 'Help');
  const mb=document.getElementById('menuBtn');   // phones: the dot rides on ☰ and on the menu's Help
  mb.classList.toggle('has-news', unseen); mb.setAttribute('aria-label', unseen ? 'Menu (new in Help)' : 'Menu');
  document.querySelector('#menuHelp .help-dot').hidden=!unseen;
}

function setHelpUrl(id){
  const u=new URL(location.href);
  if(id) u.searchParams.set('help', id);
  else if(u.searchParams.has('help')) u.searchParams.delete('help');
  else return;
  history.replaceState(null,'',u);
}
// The header ? and the editor's aria-modal track the drawer (the editor stays usable beside it).
function setHelpExpanded(open){
  const b=document.getElementById('helpBtn'); if(b) b.setAttribute('aria-expanded', String(open));
  const m=document.getElementById('modal'); if(m) m.setAttribute('aria-modal', open ? 'false' : 'true');
}

// {{legend}} in guide.md: the calendar key, drawn with the calendar's own chip
// classes and the live program list — so it can't drift from what's on screen.
function legendEmbedHTML(){
  const progs=PROGRAMS.filter(p=>p.id!=='oth' && p.active!==false);
  const hue=cssColor(progs[0] && progs[0].color, 'var(--accent)');
  const row=(cls,label,note)=>`<div class="help-legend-row"><div class="chip ${cls}" style="--c:${hue}"><span class="t">${label}</span></div><span>${note}</span></div>`;
  const ref=REF_LAYERS[0];
  return `<div class="help-legend">
      ${row('draft','Draft','Being planned')}
      ${row('proposed','Proposed','Waiting for Tribal Council')}
      ${row('approved','Approved','Confirmed by Tribal Council')}
      ${row('cancelled','Cancelled','Not happening')}
      <div class="help-legend-row"><div class="chip ref" style="--c:${cssColor(ref && ref.color, 'var(--faint)')}"><span class="t">${esc(ref?ref.name:'Holiday')}</span></div><span>Reference calendar (read-only)</span></div>
    </div>
    <div class="help-swatches">${progs.map(p=>`<span><span class="help-swatch" style="background:${cssColor(p.color, 'var(--faint)')}"></span>${esc(p.name)}</span>`).join('')}</div>`;
}
function helpEmbed(name){ return name==='legend' ? legendEmbedHTML() : ''; }

function helpResultsHTML(){
  const q=help.query.trim();
  const item=g=>`<li><a href="#" data-help-link="${esc(g.id)}">${esc(g.title)}</a>${q?` <span class="help-grp">${esc(g.group)}</span>`:''}</li>`;
  if(q){
    const hits=HelpLib.searchGuides(help.guides, q);
    return hits.length ? `<ul class="help-list">${hits.map(item).join('')}</ul>`
      : `<p class="help-empty">No guides match — try other words, or <a href="mailto:${SUPPORT_EMAIL}">email us</a>.</p>`;
  }
  const groups=[...new Set(help.guides.map(g=>g.group))];
  return groups.map(gr=>`<div class="help-grouph">${esc(gr)}</div><ul class="help-list">${help.guides.filter(g=>g.group===gr).map(item).join('')}</ul>`).join('')
    + `<ul class="help-list help-news"><li><a href="#" data-help-link="whats-new">What's new</a>${newsUnseen()?'<span class="help-dot" title="New since your last look"></span>':''}</li></ul>`;
}

async function renderHelp(){
  const d=document.getElementById('helpDrawer'), body=document.getElementById('helpBody'), title=document.getElementById('helpTitle'), back=document.getElementById('helpBack');
  if(!help.guides){
    title.textContent='Help'; back.hidden=true;
    body.innerHTML=`<p class="help-empty"><span class="ndoc-spin"></span> Loading help…</p>`;
    try{ await loadHelp(); }
    catch(_){
      body.innerHTML=`<p class="help-empty">Help couldn't load. Check your connection and try again.</p><button type="button" class="btn sm" data-help-retry>Retry</button>`;
      return;
    }
    if(d.hidden) return;   // closed while loading: don't re-add ?help= or mark What's new seen
  }
  if(help.view==='guide' && help.id==='whats-new' && !help.news){   // What's new failed earlier: try again now
    title.textContent="What's new"; back.hidden=false;
    body.innerHTML=`<p class="help-empty"><span class="ndoc-spin"></span> Loading…</p>`;
    try{ await loadNews(); }
    catch(_){
      if(d.hidden || help.id!=='whats-new') return;   // closed, or the user moved on while it retried
      body.innerHTML=`<p class="help-empty">What's new couldn't load. Check your connection and try again.</p><button type="button" class="btn sm" data-help-retry>Retry</button>`;
      return;
    }
    if(d.hidden || help.id!=='whats-new') return;
  }
  const guide=(help.view==='guide' && help.id!=='whats-new') ? help.guides.find(g=>g.id===help.id) : null;
  if(help.view==='guide' && help.id==='whats-new'){
    title.textContent="What's new";
    body.innerHTML=`<article class="help-article">${HelpLib.renderWhatsNew(help.news)}</article>`;
    markNewsSeen();
  } else if(guide){
    title.textContent=guide.title;
    body.innerHTML=`<article class="help-article">${HelpLib.renderGuide(guide.body, { embed:helpEmbed })}</article>`;
  } else {                                       // the index — also the fallback for an unknown id
    help.view='index'; help.id='';
    title.textContent='Help';
    body.innerHTML=`<input class="help-search" id="helpSearch" type="search" placeholder="Search help" aria-label="Search help" value="${esc(help.query)}"><div id="helpResults">${helpResultsHTML()}</div>`;
  }
  back.hidden = help.view==='index';
  setHelpUrl(help.view==='index' ? '' : help.id);
  body.scrollTop=0;
}
function openHelp(id, opener){
  const d=document.getElementById('helpDrawer'); if(!d) return;
  if(d.hidden || opener) help.opener=opener||document.activeElement;   // an explicit opener (editor ?, status badge) takes over even when already open
  help.view=id?'guide':'index'; help.id=id||'';
  d.hidden=false; document.body.classList.add('help-open'); setHelpExpanded(true);
  layoutSticky();   // the header narrows (or widens), so its height can change
  renderHelp();
  d.focus({ preventScroll:true });
}
function closeHelp(){
  const d=document.getElementById('helpDrawer'); if(!d || d.hidden) return;
  const ae=document.activeElement, hadFocus=!ae || ae===document.body || d.contains(ae);
  d.hidden=true; document.body.classList.remove('help-open'); setHelpExpanded(false); setHelpUrl(''); hideTip();
  layoutSticky();
  let o=help.opener; help.opener=null;
  if(!hadFocus) return;                                                     // the user moved on (e.g. into the editor)
  const scrim=document.getElementById('scrim');
  if(scrim.classList.contains('open') && !(o && scrim.contains(o))) o=document.getElementById('mClose');   // the opener is behind the modal
  if(o && o.isConnected && o.getClientRects().length) o.focus({ preventScroll:true });                    // skip hidden openers
}
// Navigate inside the drawer and keep keyboard focus in it (the clicked link is re-rendered away).
function showHelp(view, id){ help.view=view; help.id=id; renderHelp(); document.getElementById('helpDrawer').focus({ preventScroll:true }); }

document.getElementById('helpClose').addEventListener('click', closeHelp);
document.getElementById('helpBack').addEventListener('click', ()=>showHelp('index',''));
document.getElementById('helpDrawer').addEventListener('click', e=>{
  const l=e.target.closest('[data-help-link]');
  if(l){ e.preventDefault(); showHelp('guide', l.dataset.helpLink); return; }
  if(e.target.closest('[data-help-retry]')) showHelp(help.view, help.id);
});
document.getElementById('helpBody').addEventListener('input', e=>{
  if(e.target.id!=='helpSearch') return;
  help.query=e.target.value;
  const r=document.getElementById('helpResults'); if(r) r.innerHTML=helpResultsHTML();
});
// Any [data-help="<id>"] opens that guide ("" = the index); the header ? toggles.
document.addEventListener('click', e=>{
  const t=e.target.closest('[data-help]'); if(!t) return;
  e.preventDefault();
  const d=document.getElementById('helpDrawer');
  if(t.id==='helpBtn' && d && !d.hidden){ closeHelp(); return; }
  openHelp(t.dataset.help, t);
});
// Esc peels the drawer first: the capture phase runs before the modal's Esc-to-close.
document.addEventListener('keydown', e=>{
  if(e.key!=='Escape') return;
  const d=document.getElementById('helpDrawer');
  if(d && !d.hidden){ e.preventDefault(); e.stopImmediatePropagation(); closeHelp(); }
}, true);
// Welcome: auto-opens once per device, the first time a signed-in identity resolves.
let _welcomeChecked=false;
function maybeWelcome(){
  if(_welcomeChecked || !(state.identity && state.identity.signedIn)) return;
  _welcomeChecked=true;   // first signed-in identity of this page load only — est:identity re-fires on every token refresh
  const p=new URL(location.href).searchParams;
  if(p.has('event') || p.has('help')){ if(!document.getElementById('helpDrawer').hidden) helpSet(HELP_WELCOMED_KEY,'1'); return; }   // arrived via a shared link — don't cover it (reading a guide already counts as welcomed)
  if(!document.getElementById('helpDrawer').hidden){ helpSet(HELP_WELCOMED_KEY,'1'); return; }   // already reading help (e.g. from the sign-in screen)
  if(document.getElementById('scrim').classList.contains('open') || pageOpen()) return;   // something is already open
  if(helpGet(HELP_WELCOMED_KEY)!==null) return;                             // welcomed before, or storage unavailable
  if(!helpSet(HELP_WELCOMED_KEY,'1')) return;
  if(!HELP_RETURNING) loadNews().then(markNewsSeen, ()=>{});                // brand-new here: nothing is "new" to them
  openHelp('welcome');
}
document.addEventListener('est:identity', maybeWelcome);
