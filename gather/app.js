/* EST gather — member sign-ups. Buildless vanilla JS.
 * Talks only to the shared Cloudflare Worker (same brain as the plan app); the
 * Worker holds the Coda token and returns member-projected JSON. Firebase (via
 * shared/auth-firebase.js -> window.estAuth) owns identity; we send the ID token
 * as a Bearer header. All member routes require that token. */

const PROXY_BASE = 'https://est-planning-proxy.eastsidetribe.workers.dev';

const state = {
  idToken: null,        // latest Firebase ID token (in memory only)
  member: null,         // { id, name } from /member/me, or null when signed out
  authResolved: false,  // has Firebase yielded its first token/signed-out signal?
  authPending: false,   // returning from sign-in, /member/me not yet resolved
  busy: new Set(),      // in-flight slot/claim ids (disable their controls)
};

/* ---------- tiny DOM helpers ---------- */
const $ = (sel, root = document) => root.querySelector(sel);
const view = () => document.getElementById('view');
function esc(s){ return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c])); }
function elFrom(html){ const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild; }
let _toastT;
function toast(msg, kind){
  const t = document.getElementById('toast');
  t.textContent = msg; t.className = 'toast' + (kind ? ' ' + kind : ''); t.hidden = false;
  clearTimeout(_toastT); _toastT = setTimeout(() => { t.hidden = true; }, 3200);
}

/* ---------- dates ---------- */
function fmtDate(ev){
  const d = ev.date || ev.windowStart;
  if (!d) return 'Date TBD';
  const dt = new Date(d);
  if (isNaN(dt)) return 'Date TBD';
  const day = dt.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  if (ev.allDay || ev.scheduling === 'Month') return day;
  const t = ev.start ? new Date(ev.start) : null;
  const time = (t && !isNaN(t)) ? t.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) : '';
  return time ? `${day} · ${time}` : day;
}

/* ---------- API ---------- */
function authHeaders(){ return { 'Content-Type': 'application/json', Authorization: `Bearer ${state.idToken || ''}` }; }
async function api(path, opts = {}){
  const r = await fetch(`${PROXY_BASE}${path}`, { ...opts, headers: { ...authHeaders(), ...(opts.headers || {}) } });
  if (r.status === 401){ sessionExpired(); throw new Error('unauthorized'); }
  const txt = await r.text();
  let j = {}; try { j = txt ? JSON.parse(txt) : {}; } catch (_) {}
  if (!r.ok) throw new Error((j && j.error) || `HTTP ${r.status}`);
  return j;
}

/* ---------- auth (mirrors the plan app's estAuth wiring) ---------- */
function jwtClaims(t){ try { return JSON.parse(atob(String(t).split('.')[1].replace(/-/g,'+').replace(/_/g,'/'))); } catch (_) { return {}; } }
function initials(name){ return (String(name || '?').trim().split(/\s+/).map((w) => w[0]).slice(0, 2).join('') || '?').toUpperCase(); }

async function fetchMember(){
  if (!state.idToken){ state.member = null; return; }
  try {
    const r = await fetch(`${PROXY_BASE}/member/me`, { headers: authHeaders() });
    if (r.ok){ state.member = await r.json(); }
    else { state.member = null; if (r.status === 401) state.idToken = null; }
  } catch (_) { state.member = null; }   // transient — keep token, retry on next render
}
async function onFirebaseToken(token){
  state.idToken = token || null; state.authResolved = true; state.authPending = !!token;
  renderAuth();
  await fetchMember();
  state.authPending = false;
  renderAuth(); route();
}
function onFirebaseSignedOut(){
  state.idToken = null; state.member = null; state.authResolved = true; state.authPending = false;
  renderAuth(); route();
}
function sessionExpired(){ toast('Session expired — please sign in again', 'err'); onFirebaseSignedOut(); }
async function signOut(){ try { await window.estAuth.signOut(); } catch (_) {} }

function renderAuth(){
  const el = document.getElementById('authSlot'); if (!el) return;
  if (state.member){
    const claims = jwtClaims(state.idToken);
    const name = state.member.name || claims.name || claims.email || 'Account';
    const pic = claims.picture || '';
    el.innerHTML = `<div class="acct">
      <button class="avatar" id="avatarBtn" aria-haspopup="menu" aria-expanded="false" title="${esc(name)}">${pic ? `<img src="${esc(pic)}" alt="" referrerpolicy="no-referrer">` : esc(initials(name))}</button>
      <div class="acct-menu" id="acctMenu" role="menu" hidden>
        <div class="acct-who"><b>${esc(name)}</b><span class="role">${esc(claims.email || '')}</span></div>
        <button class="btn ghost block" id="signOut" role="menuitem">Sign out</button>
      </div></div>`;
    $('#avatarBtn', el).addEventListener('click', (e) => { e.stopPropagation(); const m = $('#acctMenu', el); m.hidden = !m.hidden; $('#avatarBtn', el).setAttribute('aria-expanded', String(!m.hidden)); });
    $('#signOut', el).addEventListener('click', signOut);
  } else if (state.authPending){
    el.innerHTML = `<span class="signingin"><span class="spinner"></span> Signing in…</span>`;
  } else {
    el.innerHTML = '';   // signed out: the sign-in gate (main content) is the CTA
  }
}
document.addEventListener('click', () => { const m = document.getElementById('acctMenu'); if (m) m.hidden = true; });

/* ---------- sign-in gate ---------- */
function renderGate(){
  document.getElementById('tabs').hidden = true;
  view().innerHTML = `
    <div class="gate">
      <h1>Welcome to gather</h1>
      <p>Sign in to see East Side Tribe events and sign up to bring a dish or lend a hand.</p>
      <div class="signin-card">
        <button class="btn primary block" id="googleBtn">Continue with Google</button>
        <div class="signin-or">or</div>
        <form id="emailForm" class="signin-email">
          <input id="emailInput" type="email" required placeholder="you@email.com" autocomplete="email">
          <button class="btn accent" type="submit">Email me a link</button>
        </form>
        <p class="muted" style="font-size:.78rem;margin:.75rem 0 0">New here? Signing in adds you to the tribe — no account setup needed.</p>
      </div>
    </div>`;
  $('#googleBtn').addEventListener('click', async () => { try { await window.estAuth.signInWithGoogle(); } catch (_) { toast('Google sign-in failed', 'err'); } });
  $('#emailForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = $('#emailInput').value.trim(); if (!email) return;
    try { await window.estAuth.sendEmailLink(email); toast('Check your email for a sign-in link'); }
    catch (_) { toast('Could not send sign-in link', 'err'); }
  });
}

/* ---------- router ---------- */
function setTab(name){
  document.querySelectorAll('#tabs a').forEach((a) => {
    if (a.dataset.tab === name) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  });
}
function route(){
  if (!state.authResolved){ view().innerHTML = `<div class="loading"><span class="spinner"></span> Loading…</div>`; return; }
  if (!state.member){ renderGate(); return; }
  document.getElementById('tabs').hidden = false;
  const h = (location.hash || '#/').replace(/^#/, '') || '/';
  const m = h.match(/^\/event\/(.+)$/);
  if (m){ setTab(null); renderDetail(decodeURIComponent(m[1])); return; }
  if (h === '/mine'){ setTab('mine'); renderMine(); return; }
  setTab('events'); renderHome();
}
window.addEventListener('hashchange', route);

/* ---------- home (published upcoming events) ---------- */
function slotSummary(ev){
  const slots = ev.slots || [];
  if (!slots.length) return `<span class="pill">RSVP on Eventbrite</span>`;
  const open = slots.reduce((n, s) => n + (s.remaining || 0), 0);
  const kinds = [...new Set(slots.map((s) => s.kind).filter(Boolean))];
  const kindTxt = kinds.length ? kinds.join(' & ') : 'Sign-ups';
  const mine = slots.some((s) => s.mineClaimed);
  const spot = open > 0
    ? `<span class="pill open">${open} ${open === 1 ? 'spot' : 'spots'} open</span>`
    : `<span class="pill full">All spots filled</span>`;
  return `<span class="pill">${esc(kindTxt)}</span>${spot}${mine ? '<span class="pill open">You\'re in ✓</span>' : ''}`;
}
async function renderHome(){
  view().innerHTML = `<div class="loading"><span class="spinner"></span> Loading events…</div>`;
  let items;
  try { items = (await api('/events')).items || []; }
  catch (e){ view().innerHTML = `<div class="empty"><h2>Couldn’t load events</h2><p>${esc(e.message)}</p></div>`; return; }
  if (!items.length){ view().innerHTML = `<div class="empty"><h2>Nothing published yet</h2><p>Check back soon — new events show up here as they’re announced.</p></div>`; return; }
  const cards = items.map((ev) => `
    <a class="card" href="#/event/${encodeURIComponent(ev.id)}">
      <div class="when">${esc(fmtDate(ev))}</div>
      <h2>${esc(ev.title || 'Untitled event')}</h2>
      ${ev.location ? `<div class="where">${esc(ev.location)}</div>` : ''}
      <div class="slotline">${ev.preview ? '<span class="pill preview">Unpublished — planner preview</span>' : ''}${slotSummary(ev)}</div>
    </a>`).join('');
  view().innerHTML = `<div class="stack">${cards}</div>`;
}

/* ---------- event detail + sign-up sheet ---------- */
async function renderDetail(id){
  view().innerHTML = `<div class="loading"><span class="spinner"></span> Loading…</div>`;
  let ev;
  try { ev = await api(`/events/${encodeURIComponent(id)}`); }
  catch (e){ view().innerHTML = `<a class="back" href="#/">← All events</a><div class="empty"><h2>Couldn’t load this event</h2><p>${esc(e.message)}</p></div>`; return; }
  const slots = (ev.slots || []).slice().sort((a, b) => (a.sortOrder - b.sortOrder));
  const byKind = {};
  for (const s of slots){ const k = s.kind || 'Sign-ups'; (byKind[k] = byKind[k] || []).push(s); }
  const kindOrder = ['Potluck', 'Volunteer'];
  const kinds = Object.keys(byKind).sort((a, b) => (kindOrder.indexOf(a) + 1 || 99) - (kindOrder.indexOf(b) + 1 || 99));

  const sheet = slots.length ? kinds.map((k) => `
    <div class="kind-group">
      <div class="kind-label">${esc(k)}</div>
      <div class="sheet">${byKind[k].map((s) => slotHTML(s)).join('')}</div>
    </div>`).join('') : `<p class="muted">No sign-up sheet for this event — just register on Eventbrite.</p>`;

  view().innerHTML = `
    <a class="back" href="#/">← All events</a>
    <div class="detail">
      <div class="when" style="color:var(--brand);font-size:.8rem;font-weight:600;letter-spacing:.06em;text-transform:uppercase">${esc(fmtDate(ev))}</div>
      <h1>${esc(ev.title || 'Untitled event')}</h1>
      ${ev.preview ? `<div class="preview-note"><span class="pill preview">Unpublished — planner preview</span> Members can’t see this yet; it goes live when the event is published.</div>` : ''}
      <div class="meta">${ev.location ? `📍 ${esc(ev.location)}` : ''}</div>
      ${ev.summary ? `<p class="desc">${esc(ev.summary)}</p>` : ''}
      ${ev.description && ev.description !== ev.summary ? `<p class="desc">${esc(ev.description)}</p>` : ''}
      ${ev.eventbriteUrl ? `<div class="eb-cta"><a class="btn primary block" href="${esc(ev.eventbriteUrl)}" target="_blank" rel="noopener">Register on Eventbrite ↗</a></div>` : ''}
      ${slots.length ? `<div class="section-title">Sign-up sheet</div>` : ''}
      <div id="sheet">${sheet}</div>
    </div>`;
  wireSheet(id);
}

function slotHTML(s){
  const claims = s.claims || [];
  const filled = claims.reduce((n, c) => n + (c.qty || 1), 0);
  const list = claims.length ? `<ul class="claimants">${claims.map((c) => `
    <li class="${c.mine ? 'mine' : ''}"><span class="who">${esc(c.name || 'Someone')}${c.mine ? ' (you)' : ''}</span>${c.contribution ? ` <span class="contrib">— ${esc(c.contribution)}</span>` : ''}</li>`).join('')}</ul>` : `<div class="muted" style="font-size:.85rem;margin-top:.4rem">No one yet — be the first.</div>`;

  let action = '';
  if (s.mineClaimed){
    const mineClaim = claims.find((c) => c.mine);
    action = `<div class="slot-actions"><button class="btn danger sm" data-unclaim="${esc((mineClaim && mineClaim.claimId) || '')}" data-slot="${esc(s.id)}">Remove my sign-up</button></div>`;
  } else if ((s.remaining || 0) > 0){
    const ph = s.kind === 'Potluck' ? 'What are you bringing? (optional)' : 'Note (optional)';
    action = `<form class="claim-form" data-claim="${esc(s.id)}">
        <input type="text" name="contribution" placeholder="${esc(ph)}" maxlength="120">
        <button class="btn accent sm" type="submit">I’m in</button>
      </form>`;
  } else {
    action = `<div class="slot-actions muted" style="font-size:.85rem">This one’s full — thanks!</div>`;
  }
  return `<div class="slot" data-slot-row="${esc(s.id)}">
      <div class="slot-head"><span class="lbl">${esc(s.label || 'Slot')}</span><span class="cnt">${filled} of ${s.neededQty || filled} filled</span></div>
      ${list}
      ${action}
    </div>`;
}

function wireSheet(eventId){
  view().querySelectorAll('form[data-claim]').forEach((f) => {
    f.addEventListener('submit', async (e) => {
      e.preventDefault();
      const slot = f.getAttribute('data-claim');
      const contribution = (f.contribution.value || '').trim();
      const btn = f.querySelector('button'); btn.disabled = true;
      try {
        await api('/claims', { method: 'POST', body: JSON.stringify({ slot, contributionDetail: contribution, qty: 1 }) });
        toast('You’re signed up!');
        await renderDetail(eventId);
      } catch (err){ toast(err.message || 'Could not sign up', 'err'); btn.disabled = false; }
    });
  });
  view().querySelectorAll('button[data-unclaim]').forEach((b) => {
    b.addEventListener('click', async () => {
      const claimId = b.getAttribute('data-unclaim');
      if (!claimId){ toast('Can’t find your sign-up to remove', 'err'); return; }
      b.disabled = true;
      try {
        await api(`/claims/${encodeURIComponent(claimId)}`, { method: 'DELETE' });
        toast('Removed');
        await renderDetail(eventId);
      } catch (err){ toast(err.message || 'Could not remove', 'err'); b.disabled = false; }
    });
  });
}

/* ---------- my sign-ups ---------- */
async function renderMine(){
  view().innerHTML = `<div class="loading"><span class="spinner"></span> Loading your sign-ups…</div>`;
  let items;
  try { items = (await api('/me/claims')).items || []; }
  catch (e){ view().innerHTML = `<div class="empty"><h2>Couldn’t load your sign-ups</h2><p>${esc(e.message)}</p></div>`; return; }
  if (!items.length){ view().innerHTML = `<div class="empty"><h2>No sign-ups yet</h2><p>Browse <a href="#/" style="color:var(--brand);font-weight:600">events</a> and claim a spot.</p></div>`; return; }
  const rows = items.map((c) => `
    <div class="mine-item" data-claim-row="${esc(c.claimId)}">
      <div class="what">
        <b>${esc(c.slotLabel || c.kind || 'Sign-up')}${c.contribution ? ` — ${esc(c.contribution)}` : ''}</b>
        <span class="sub">${c.eventId ? `<a href="#/event/${encodeURIComponent(c.eventId)}" style="color:var(--muted)">${esc(c.eventTitle || 'Event')}</a>` : esc(c.eventTitle || 'Event')}${c.date ? ` · ${esc(new Date(c.date).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }))}` : ''}</span>
      </div>
      <button class="btn danger sm" data-unclaim-mine="${esc(c.claimId)}">Remove</button>
    </div>`).join('');
  view().innerHTML = `<div class="stack">${rows}</div>`;
  view().querySelectorAll('button[data-unclaim-mine]').forEach((b) => {
    b.addEventListener('click', async () => {
      const claimId = b.getAttribute('data-unclaim-mine'); b.disabled = true;
      try {
        await api(`/claims/${encodeURIComponent(claimId)}`, { method: 'DELETE' });
        toast('Removed'); renderMine();
      } catch (err){ toast(err.message || 'Could not remove', 'err'); b.disabled = false; }
    });
  });
}

/* ---------- boot ---------- */
function start(){
  window.estAuth.init({ onToken: onFirebaseToken, onSignedOut: onFirebaseSignedOut });
  window.estAuth.completeEmailLinkIfPresent().catch(() => {});
}
route();   // show the loading state until Firebase resolves
if (window.estAuth) start();
else window.addEventListener('estauth:ready', start, { once: true });
