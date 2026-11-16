/* auth.js — Firebase sign-in: token lifecycle, /me identity + roles, the sign-in gate, account menu, editor role refresh.
   Owns: SUPPORT_EMAIL, sessionExpired, acctMenu, initAuth
   Reads: state (state.js); editing, activeSection (editor-tabs.js); _ctx (editor.js); _busy (save.js); #eventPage (index.html)
   Writes: state (state.js)
   Loaded after: shell.js (no load-time dependency; initAuth runs from init() in main.js) */

/* ---- Firebase sign-in (identity + role gating via the Worker /me) -------- */
// Token lifecycle is owned by Firebase (auth-firebase.js). We keep the latest
// ID token in memory for the Authorization header; Firebase persists the session
// and streams refreshed tokens via estAuth.init's onToken callback.
function jwtClaims(t){ try{ return JSON.parse(atob(String(t).split('.')[1].replace(/-/g,'+').replace(/_/g,'/'))); }catch(_){ return {}; } }
function initials(name){ return (String(name||'?').trim().split(/\s+/).map(w=>w[0]).slice(0,2).join('')||'?').toUpperCase(); }
function roleLabel(id){ return id.canApprove ? 'Tribal Council' : (id.canWrite ? 'Program Lead' : (id.matched ? 'Member' : 'Not a recognized lead')); }
function renderAuth(){
  const el = document.getElementById('authSlot'), menu = document.getElementById('menuAcct'); if(!el) return;
  const id = state.identity;
  if(id && id.signedIn){
    const claims = jwtClaims(state.idToken);
    const name = id.name || claims.name || claims.email || 'Account';
    const pic = claims.picture || '';
    el.innerHTML = `<div class="acct">
        <button class="avatar" id="avatarBtn" aria-haspopup="menu" aria-expanded="false" title="${esc(name)}">${pic ? `<img src="${esc(pic)}" alt="" referrerpolicy="no-referrer">` : esc(initials(name))}</button>
        <div class="acct-menu" id="acctMenu" role="menu" hidden>
          <div class="acct-who"><b>${esc(name)}</b><span class="role">${esc(roleLabel(id))}</span></div>
          ${id.canApprove?`<button class="btn ghost" id="refreshPeople" role="menuitem" title="Pull People + roles fresh from Coda now (after granting someone a role)">Refresh roles &amp; people</button>`:''}
          <button class="btn ghost" id="signOut" role="menuitem">Sign out</button>
        </div>
      </div>`;
    el.querySelector('#avatarBtn').addEventListener('click', e=>{ e.stopPropagation(); acctMenu(); });
    el.querySelector('#signOut').addEventListener('click', signOut);
    const rp=el.querySelector('#refreshPeople');
    if(rp) rp.addEventListener('click', ()=>refreshRoles(rp));
    // the phone ☰ menu shows the same account, flat (no avatar pop-up)
    menu.innerHTML = `<div class="menu-acct">
        <span class="avatar" aria-hidden="true">${pic ? `<img src="${esc(pic)}" alt="" referrerpolicy="no-referrer">` : esc(initials(name))}</span>
        <div class="acct-who"><b>${esc(name)}</b><span class="role">${esc(roleLabel(id))}</span></div>
      </div>
      <div class="menu-acct-acts">
        ${id.canApprove?`<button class="btn sm" id="menuRefreshPeople" type="button">Refresh roles &amp; people</button>`:''}
        <button class="btn sm" id="menuSignOut" type="button">Sign out</button>
      </div>`;
    menu.querySelector('#menuSignOut').addEventListener('click', ()=>{ phoneMenu(false); signOut(); });
    const mrp=menu.querySelector('#menuRefreshPeople');
    if(mrp) mrp.addEventListener('click', ()=>refreshRoles(mrp));
  } else if(state.authPending){
    // Gap between returning from Google and /me resolving — show progress.
    el.innerHTML = menu.innerHTML = `<span class="signingin"><span class="ndoc-spin"></span> Signing in…</span>`;
  } else {
    el.innerHTML = menu.innerHTML = '';   // signed out: the full-screen gate is the sign-in surface
  }
  updateGate();
}
async function refreshRoles(btn){
  btn.disabled=true; const prev=btn.textContent; btn.textContent='Refreshing…';
  try{ const j=await DB.refreshPeople(); toast(`Roles refreshed (${j.people} people)`,'ok'); loadPeople(); }
  catch(err){ toast(err.message||'Refresh failed','err'); }
  finally{ btn.disabled=false; btn.textContent=prev; acctMenu(false); }
}
// The app surface is members-only: a full-screen gate covers it until Firebase
// yields a signed-in identity (any verified account — roles still gate writes).
function updateGate(){
  const g=document.getElementById('authGate'); if(!g) return;
  const signedIn = !!(state.identity && state.identity.signedIn);
  g.hidden = signedIn;
  const busy = !state.authResolved || state.authPending;
  const card=document.getElementById('gateCard'), b=document.getElementById('gateBusy');
  if(card) card.hidden = busy;
  if(b) b.hidden = !busy;
}
const SUPPORT_EMAIL='eastsidetribenashville@gmail.com';
const LINK_SENDER='eastsidetribenashville@gmail.com';
function wireGate(){
  const gg=document.getElementById('gateGoogle');
  if(gg) gg.addEventListener('click', async ()=>{
    try{ await window.estAuth.signInWithGoogle(); }
    catch(err){ toast(/popup/i.test(String(err&&err.code||''))?'Pop-up blocked — allow pop-ups or use the email link':'Google sign-in didn’t work — try the email link','err'); }
  });
  const f=document.getElementById('gateEmailForm');
  if(f) f.addEventListener('submit', async e=>{
    e.preventDefault();
    const email=document.getElementById('gateEmailInput').value.trim(); if(!email) return;
    const btn=f.querySelector('button[type=submit]'); if(btn) btn.disabled=true;
    try{
      await window.estAuth.sendEmailLink(email);
      // persistent, spam-aware confirmation (mirrors gather)
      const sent=document.getElementById('gateSent'), form=document.getElementById('gateForm');
      sent.innerHTML=`<div class="signin-sent">
          <div class="sent-emoji">✉️</div><b>Check your email</b>
          <p>We sent a sign-in link to <b>${esc(email)}</b>. Open it on this device to finish.</p>
          <p class="sent-spam">Don’t see it within a minute? Check your <b>spam / junk</b> folder — it comes from <b>${esc(LINK_SENDER)}</b>.</p>
          <button type="button" class="btn ghost" id="gateAgain">Use a different email</button>
          <p class="contact-line">Still stuck? <a href="mailto:${SUPPORT_EMAIL}">Email us</a></p>
        </div>`;
      form.hidden=true; sent.hidden=false;
      document.getElementById('gateAgain').addEventListener('click', ()=>{ sent.hidden=true; form.hidden=false; if(btn) btn.disabled=false; });
    }
    catch(err){
      const quota=/quota/i.test(`${err&&err.code||''} ${err&&err.message||''}`);
      toast(quota?'Email links are temporarily at capacity — use “Continue with Google” instead.':'Could not send the link — check the address, or email us','err');
      if(btn) btn.disabled=false;
    }
  });
}
function acctMenu(open){
  const m=document.getElementById('acctMenu'), b=document.getElementById('avatarBtn'); if(!m||!b) return;
  const willOpen = open!==undefined ? open : m.hidden;
  m.hidden = !willOpen; b.setAttribute('aria-expanded', String(willOpen));
}


async function fetchMe(){
  if(!PROXY_BASE || !state.idToken){ state.identity=null; state.authPending=false; renderAuth(); return; }
  try{
    const r = await fetch(`${PROXY_BASE}/me`, { headers:{ 'Authorization':`Bearer ${state.idToken}` } });
    if(r.ok){ state.identity = await r.json(); }
    else { state.identity = null; if(r.status===401){ state.idToken=null; } } // token rejected -> drop it; Firebase re-yields on next refresh
  }catch(_){ state.identity=null; }               // transient network error: keep the token, try again later
  state.authPending=false;
  renderAuth(); applyView();
  refreshEditorRole();
  document.dispatchEvent(new CustomEvent('est:identity'));   // panels opened before sign-in resolved (deep links) re-fetch on this
}
// An editor opened before the role loaded (a ?event= deep link) was built read-only.
// When the role arrives and grants more than that editor was built with, rebuild it
// in place: openEditor first queues any edit in an open form (leaveForm), so nothing
// typed is lost. Losing a permission (sign-out, a /me blip) doesn't rebuild: the
// Worker refuses the writes, and a network blip mustn't yank the form mid-edit.
function refreshEditorRole(){
  if(!editing || !_ctx || _ctx.ev!==editing || !editing.id || _busy.has(editing.id)) return;
  const page=document.getElementById('eventPage');
  if(page.hidden || page.classList.contains('loading')) return;   // not the event page (or it's still loading)
  const now=editorCtx(editing).role, was=_ctx.role;
  if((now.canEdit && !was.canEdit) || (now.canApprove && !was.canApprove)) openEditor(editing, activeSection);
}
// Called by estAuth whenever Firebase yields a (refreshed) ID token.
async function onFirebaseToken(token){ state.idToken = token || null; state.authResolved = true; state.authPending = !!token; renderAuth(); await fetchMe(); }
function onFirebaseSignedOut(){ state.idToken=null; state.identity=null; state.authResolved=true; state.authPending=false; renderAuth(); applyView(); }
function sessionExpired(){ toast('Session expired — please sign in again','err'); onFirebaseSignedOut(); }
async function signOut(){ try{ await window.estAuth.signOut(); }catch(_){} }   // onFirebaseSignedOut clears state

function initAuth(){
  wireGate(); updateGate();
  const start = () => {
    window.estAuth.init({ onToken: onFirebaseToken, onSignedOut: onFirebaseSignedOut });
    window.estAuth.completeEmailLinkIfPresent().catch(()=>{ toast('That sign-in link didn’t work — it may have expired. Request a fresh one.','err'); });   // finish a magic-link return, if any
  };
  if(window.estAuth) start();
  else window.addEventListener('estauth:ready', start, { once:true });   // module may load after app.js
}
