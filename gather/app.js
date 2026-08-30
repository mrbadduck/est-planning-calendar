/* EST gather — member sign-ups. Buildless vanilla JS.
 * Talks only to the shared Cloudflare Worker (same brain as the plan app); the
 * Worker holds the Coda token and returns member-projected JSON. Firebase (via
 * shared/auth-firebase.js -> window.estAuth) owns identity; we send the ID token
 * as a Bearer header. All member routes require that token. */

// Dev affordance: point the app at a different Worker (e.g. a `wrangler
// versions upload` preview) via localStorage.setItem('est-proxy-base', url).
const PROXY_BASE = (() => {
  const prod = 'https://est-planning-proxy.eastsidetribe.workers.dev';
  try { return localStorage.getItem('est-proxy-base') || prod; } catch (_) { return prod; }
})();

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
    // Signed out: header Sign in button + dropdown (same pattern as plan's).
    el.innerHTML = `<div class="acct">
      <button class="btn primary" id="signInBtn">Sign in</button>
      <div class="acct-menu signin-menu" id="signInMenu" role="menu" hidden>${signInFormHTML()}</div>
    </div>`;
    $('#signInBtn', el).addEventListener('click', (e) => { e.stopPropagation(); const m = $('#signInMenu', el); m.hidden = !m.hidden; });
    wireSignIn($('#signInMenu', el));
  }
}
document.addEventListener('click', (e) => {
  if (e.target.closest('.acct')) return;   // clicks inside the menu (e.g. the email field) keep it open
  for (const id of ['acctMenu', 'signInMenu']){ const m = document.getElementById(id); if (m) m.hidden = true; }
});

/* ---------- sign-in (shared wiring for the header menu + inline CTAs) ---------- */
const SUPPORT_EMAIL = 'eastsidetribenashville@gmail.com';
const LINK_SENDER = 'noreply@est-planning-calendar.firebaseapp.com';
const contactHTML = (label = 'Trouble signing in?') =>
  `<p class="contact-line">${label} <a href="mailto:${SUPPORT_EMAIL}">Email us</a></p>`;

function wireSignIn(root){
  const g = root.querySelector('[data-signin-google]');
  if (g) g.addEventListener('click', async () => {
    try { await window.estAuth.signInWithGoogle(); }
    catch (err) {
      // popup blocked / closed / not-allowed — tell them how to recover
      const msg = /popup/i.test(String(err && err.code || '')) ? 'Pop-up blocked — allow pop-ups or use the email link instead' : 'Google sign-in didn’t work — try the email link instead';
      toast(msg, 'err');
    }
  });
  const f = root.querySelector('form[data-signin-email]');
  if (f) f.addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = (f.querySelector('input[type=email]').value || '').trim(); if (!email) return;
    const btn = f.querySelector('button[type=submit]'); if (btn) btn.disabled = true;
    try {
      await window.estAuth.sendEmailLink(email);
      root.innerHTML = signInSentHTML(email);          // persistent confirmation, not a fleeting toast
      const again = root.querySelector('[data-signin-again]');
      if (again) again.addEventListener('click', () => { root.innerHTML = signInFormHTML(); wireSignIn(root); });
    }
    catch (err) {
      // Firebase caps email-link sends per day — steer to Google, which has no such limit.
      const quota = /quota/i.test(`${err && err.code || ''} ${err && err.message || ''}`);
      toast(quota ? 'Email links are temporarily at capacity — please use “Continue with Google” instead.' : 'Could not send the link — check the address, or email us', 'err');
      if (btn) btn.disabled = false;
    }
  });
}
function signInFormHTML(){
  return `<button class="btn primary block" data-signin-google>Continue with Google</button>
    <div class="signin-or">or</div>
    <form class="signin-email" data-signin-email>
      <input type="email" required placeholder="you@email.com" autocomplete="email">
      <button class="btn accent" type="submit">Email me a link</button>
    </form>
    <p class="muted" style="font-size:.78rem;margin:.75rem 0 .2rem">New here? Signing in adds you to the tribe — no account setup needed.</p>
    ${contactHTML()}`;
}
function signInSentHTML(email){
  return `<div class="signin-sent">
      <div class="sent-emoji">✉️</div>
      <b>Check your email</b>
      <p>We sent a sign-in link to <b>${esc(email)}</b>. Open it on this device to finish signing in.</p>
      <p class="sent-spam">Don’t see it within a minute? Check your <b>spam / junk</b> folder — the link comes from <b>${LINK_SENDER}</b>.</p>
      <button type="button" class="btn ghost sm" data-signin-again>Use a different email</button>
      ${contactHTML('Still stuck?')}
    </div>`;
}

/* ---------- router ---------- */
function setTab(name){
  document.querySelectorAll('#tabs a').forEach((a) => {
    if (a.dataset.tab === name) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  });
}
function route(){
  if (!state.authResolved){ view().innerHTML = `<div class="loading"><span class="spinner"></span> Loading…</div>`; return; }
  // Public entry: anyone can browse events + details; the sign-up sheet and
  // "My sign-ups" are member-only (the Worker strips slot details anonymously).
  document.getElementById('tabs').hidden = false;
  const mineTab = document.querySelector('#tabs a[data-tab="mine"]');
  if (mineTab) mineTab.hidden = !state.member;
  const h = (location.hash || '#/').replace(/^#/, '') || '/';
  const m = h.match(/^\/event\/(.+)$/);
  if (m){ setTab(null); renderDetail(decodeURIComponent(m[1])); return; }
  _detail = null;   // leaving the detail view cancels its optimistic state + reconcile
  if (h === '/mine'){
    if (!state.member){ location.hash = '#/'; return; }
    setTab('mine'); renderMine(); return;
  }
  setTab('events'); renderHome();
}
window.addEventListener('hashchange', route);

/* ---------- home (published upcoming events) ---------- */
function slotSummary(ev){
  const slots = ev.slots || [];
  if (!state.member) return ev.hasSlots ? `<span class="pill open">Sign in to volunteer &amp; potluck</span>` : `<span class="pill">RSVP on Eventbrite</span>`;
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
  catch (e){ view().innerHTML = `<div class="empty"><h2>Couldn’t load events</h2><p>Try refreshing in a moment.</p>${contactHTML('Still down?')}</div>`; return; }
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
/* Coda reads are eventually consistent: refetching right after a claim write
   usually misses the new row. So the detail view is stateful — claim/unclaim
   mutate the local copy and repaint instantly, `recent` remembers those ops for
   15s, and a delayed reconcile pulls server truth and re-applies any op the
   server hasn't caught up to yet. */
let _detail = null;   // { id, ev, recent:Map, reconT }
async function renderDetail(id){
  view().innerHTML = `<div class="loading"><span class="spinner"></span> Loading…</div>`;
  let ev;
  try { ev = await api(`/events/${encodeURIComponent(id)}`); }
  catch (e){ view().innerHTML = `<a class="back" href="#/">← All events</a><div class="empty"><h2>Couldn’t load this event</h2><p>Try refreshing in a moment.</p>${contactHTML('Still down?')}</div>`; return; }
  _detail = { id, ev, recent: new Map(), reconT: 0 };
  paintDetail();
}

function paintDetail(){
  if (!_detail) return;
  const ev = _detail.ev;
  const slots = (ev.slots || []).slice().sort((a, b) => (a.sortOrder - b.sortOrder));
  const byKind = {};
  for (const s of slots){ const k = s.kind || 'Sign-ups'; (byKind[k] = byKind[k] || []).push(s); }
  const kindOrder = ['Potluck', 'Volunteer'];
  const kinds = Object.keys(byKind).sort((a, b) => (kindOrder.indexOf(a) + 1 || 99) - (kindOrder.indexOf(b) + 1 || 99));

  const grpId = (k) => `grp-${k.replace(/[^A-Za-z]/g, '')}`;
  const kindIcon = (k) => (k === 'Potluck' ? '🍲' : k === 'Volunteer' ? '🙌' : '📋');

  const sheet = (!state.member && ev.hasSlots)
    ? `<div class="signin-card" id="sheetCta">
        <p style="margin:0 0 .9rem;font-weight:600;text-align:center">Sign in to volunteer and contribute to the potluck!</p>
        ${signInFormHTML()}
      </div>`
    : slots.length ? kinds.map((k) => `
    <div class="kind-group" id="${grpId(k)}">
      <div class="kind-label">${esc(k)}</div>
      <div class="sheet">${byKind[k].map((s) => slotHTML(s)).join('')}</div>
    </div>`).join('') : `<p class="muted">No sign-up sheet for this event — just register on Eventbrite.</p>`;

  // Sticky sheet header: when a member sees BOTH potluck and volunteer sections,
  // a jump bar with per-kind counts so the volunteer roles below a long potluck
  // list are discoverable (and one tap scrolls to each section).
  const showSheet = state.member ? slots.length : ev.hasSlots;
  const jump = (state.member && kinds.length > 1)
    ? `<div class="sheet-jump">${kinds.map((k) => `<button type="button" class="sheet-jump-btn" data-jump="${grpId(k)}">${kindIcon(k)} ${esc(k)} <b>${byKind[k].length}</b></button>`).join('')}</div>`
    : '';

  view().innerHTML = `
    <a class="back" href="#/">← All events</a>
    ${ev.preview ? `<div class="preview-banner"><span class="pill preview">Unpublished</span> Planner preview — members can’t see this yet; it goes live when the event is published.</div>` : ''}
    <div class="detail">
      <div class="when" style="color:var(--brand);font-size:.8rem;font-weight:600;letter-spacing:.06em;text-transform:uppercase">${esc(fmtDate(ev))}</div>
      <h1>${esc(ev.title || 'Untitled event')}</h1>
      <div class="meta">${ev.location ? `📍 ${esc(ev.location)}` : ''}</div>
      ${ev.summary ? `<p class="desc">${esc(ev.summary)}</p>` : ''}
      ${ev.eventbriteUrl ? `<div class="eb-cta"><a class="btn primary block" href="${esc(ev.eventbriteUrl)}">Register on Eventbrite ↗</a></div>` : ''}
      ${showSheet ? `<div class="sheet-head"><div class="section-title">Sign-up sheet</div>${jump}</div>` : ''}
      <div id="sheet">${sheet}</div>
    </div>`;
  const cta = document.getElementById('sheetCta');
  if (cta) wireSignIn(cta);
  view().querySelectorAll('[data-jump]').forEach((b) => b.addEventListener('click', () => {
    const el = document.getElementById(b.getAttribute('data-jump'));
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }));
  wireSheet();
  checkRegistration();
}

// Ask the Worker whether the signed-in member is already registered on
// Eventbrite for this event (matched across ALL their known emails, since
// people often register with a different address). Fills in lazily — the page
// never waits on it, and a lookup failure just leaves the plain CTA.
function checkRegistration(){
  const d = _detail;
  if (!d || !state.member || !d.ev.eventbriteUrl) return;
  api(`/events/${encodeURIComponent(d.id)}/registration`).then((r) => {
    if (_detail !== d || !r || !r.registered) return;
    const cta = view().querySelector('.eb-cta');
    if (cta && !cta.querySelector('.reg-pill')){
      cta.insertAdjacentHTML('afterbegin', `<div class="reg-pill">✓ You’re registered${r.qty > 1 ? ` · ${r.qty} tickets` : ''}</div>`);
      const btn = cta.querySelector('a.btn'); if (btn) btn.textContent = 'View on Eventbrite ↗';
    }
  }).catch(() => {});
}

function rememberOp(key, rec){ if (_detail) _detail.recent.set(key, Object.assign({ until: Date.now() + 15000 }, rec)); }
function scheduleDetailReconcile(){
  if (!_detail) return;
  clearTimeout(_detail.reconT);
  _detail.reconT = setTimeout(reconcileDetail, 4000);   // let Coda index, then pull server truth
}
async function reconcileDetail(){
  const d = _detail; if (!d) return;
  let fresh; try { fresh = await api(`/events/${encodeURIComponent(d.id)}`); } catch (_) { return; }
  if (_detail !== d) return;                            // navigated away meanwhile
  const now = Date.now();
  for (const [k, rec] of [...d.recent]) if (rec.until <= now) d.recent.delete(k);
  for (const [k, rec] of d.recent){
    if (rec.added){                                     // server missing my just-added claim -> keep it
      const s = (fresh.slots || []).find((x) => x.id === rec.added.slot);
      if (s && !(s.claims || []).some((c) => c.claimId === k)){
        (s.claims = s.claims || []).push(rec.added.claim);
        s.remaining = Math.max(0, (s.remaining || 0) - (rec.added.claim.qty || 1));
        s.mineClaimed = true;
      }
    }
    if (rec.removed){                                   // server still showing my just-removed claim -> drop it
      for (const s of (fresh.slots || [])){
        if (!s.claims) continue;
        const before = s.claims.length;
        s.claims = s.claims.filter((c) => c.claimId !== k);
        if (s.claims.length < before){
          s.remaining = (s.remaining || 0) + 1;
          s.mineClaimed = s.claims.some((c) => c.mine);
        }
      }
    }
  }
  d.ev = fresh;
  paintDetail();
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

function wireSheet(){
  view().querySelectorAll('form[data-claim]').forEach((f) => {
    f.addEventListener('submit', async (e) => {
      e.preventDefault();
      const slotId = f.getAttribute('data-claim');
      const contribution = (f.contribution.value || '').trim();
      const btn = f.querySelector('button'); btn.disabled = true;
      try {
        const res = await api('/claims', { method: 'POST', body: JSON.stringify({ slot: slotId, contributionDetail: contribution, qty: 1 }) });
        const s = _detail && _detail.ev.slots.find((x) => x.id === slotId);
        if (s){                                          // show it NOW — the server read lags the write
          const c = { name: (state.member && state.member.name) || 'You', contribution, qty: 1, mine: true, claimId: (res && res.id) || `tmp-${Date.now()}` };
          (s.claims = s.claims || []).push(c);
          s.remaining = Math.max(0, (s.remaining || 0) - 1);
          s.mineClaimed = true;
          rememberOp(c.claimId, { added: { slot: s.id, claim: c } });
        }
        toast('You’re signed up!');
        paintDetail(); scheduleDetailReconcile();
      } catch (err){ toast(err.message || 'Could not sign up', 'err'); btn.disabled = false; }
    });
  });
  view().querySelectorAll('button[data-unclaim]').forEach((b) => {
    b.addEventListener('click', async () => {
      const claimId = b.getAttribute('data-unclaim');
      const slotId = b.getAttribute('data-slot');
      if (!claimId){ toast('Can’t find your sign-up to remove', 'err'); return; }
      b.disabled = true;
      try {
        await api(`/claims/${encodeURIComponent(claimId)}`, { method: 'DELETE' });
        const s = _detail && _detail.ev.slots.find((x) => x.id === slotId);
        if (s && s.claims){
          s.claims = s.claims.filter((c) => c.claimId !== claimId);
          s.remaining = (s.remaining || 0) + 1;
          s.mineClaimed = s.claims.some((c) => c.mine);
          rememberOp(claimId, { removed: true });
        }
        toast('Removed');
        paintDetail(); scheduleDetailReconcile();
      } catch (err){ toast(err.message || 'Could not remove', 'err'); b.disabled = false; }
    });
  });
}

/* ---------- my sign-ups ---------- */
async function renderMine(){
  view().innerHTML = `<div class="loading"><span class="spinner"></span> Loading your sign-ups…</div>`;
  let items;
  try { items = (await api('/me/claims')).items || []; }
  catch (e){ view().innerHTML = `<div class="empty"><h2>Couldn’t load your sign-ups</h2><p>Try refreshing in a moment.</p>${contactHTML('Still down?')}</div>`; return; }
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
        toast('Removed');
        // drop the row locally — an immediate refetch would still show it (Coda read lag)
        const row = b.closest('.mine-item'); if (row) row.remove();
        if (!view().querySelector('.mine-item')) view().innerHTML = `<div class="empty"><h2>No sign-ups yet</h2><p>Browse <a href="#/" style="color:var(--brand);font-weight:600">events</a> and claim a spot.</p></div>`;
      } catch (err){ toast(err.message || 'Could not remove', 'err'); b.disabled = false; }
    });
  });
}

/* ---------- boot ---------- */
function start(){
  window.estAuth.init({ onToken: onFirebaseToken, onSignedOut: onFirebaseSignedOut });
  // A magic-link click that fails (expired, already used, wrong email) used to
  // dead-end silently on the signed-out app. Tell them how to recover.
  window.estAuth.completeEmailLinkIfPresent().catch(() => {
    toast('That sign-in link didn’t work — it may have expired. Tap “Sign in” to get a fresh one.', 'err');
  });
}
route();   // show the loading state until Firebase resolves
if (window.estAuth) start();
else window.addEventListener('estauth:ready', start, { once: true });
