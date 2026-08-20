/**
 * EST Planning Calendar - API proxy for Superhuman Docs (formerly Coda).
 *
 * Holds the Superhuman Docs API token server-side so it never reaches the
 * browser/embed. The calendar app calls this Worker; the Worker calls the
 * Superhuman Docs REST API with the secret token.
 *
 * Routes (relative to the Worker origin):
 *   GET    /rows        list planning rows (values keyed by column name)
 *   POST   /rows        create a row  (body: { rows: [{ cells: [...] }] })
 *   PUT    /rows/:id    update a row  (body: { row:  { cells: [...] } })
 *   DELETE /rows/:id    delete a row
 *   GET    /ref/:name   read a reference table (name ∈ programs|people|venues|venue-types)
 *   GET    /me          verify Google token -> { signedIn, name, canWrite, canApprove }
 *
 * Config (see wrangler.toml and .dev.vars.example):
 *   CODA_API_TOKEN   (secret)  doc/table-scoped token, read+write
 *   CODA_DOC_ID      (var)     Mission Control doc id
 *   CODA_TABLE_ID    (var)     planning table id
 *   CODA_API_BASE    (var)     default https://coda.io/apis/v1 (still resolves post-rename)
 *   ALLOWED_ORIGIN   (var)     optional; lock CORS to the app's deploy origin
 *   ALLOW_WRITES     (var)     'true' enables writes (also requires a write-authorized identity)
 *   GOOGLE_CLIENT_ID (var)     OAuth client id; verified as the JWT `aud` for sign-in
 *   APP_KEY          (secret)  optional shared secret required in X-App-Key header
 */
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const cors = corsHeaders(request.headers.get('Origin') || '', env);
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });

    if (env.APP_KEY && request.headers.get('X-App-Key') !== env.APP_KEY)
      return json({ error: 'unauthorized' }, 401, cors);

    const base = env.CODA_API_BASE || 'https://coda.io/apis/v1';
    const { CODA_DOC_ID: docId, CODA_TABLE_ID: tableId, CODA_API_TOKEN: token } = env;
    if (!docId || !tableId || !token)
      return json({ error: 'proxy not configured (CODA_DOC_ID, CODA_TABLE_ID, CODA_API_TOKEN)' }, 500, cors);

    const auth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    const parts = url.pathname.split('/').filter(Boolean); // ['rows'] | ['rows', id]

    try {
      if (parts[0] === 'rows') {
        const rowId = parts[1] ? decodeURIComponent(parts[1]) : null;
        const rowsUrl = `${base}/docs/${docId}/tables/${tableId}/rows`;
        const writing = request.method === 'POST' || request.method === 'PUT' || request.method === 'DELETE';

        if (writing) {
          // Writes require the ALLOW_WRITES master switch AND a verified,
          // write-authorized identity. Identity + attribution are derived HERE
          // from the Google token — never trusted from the client.
          if (env.ALLOW_WRITES !== 'true') return json({ error: 'writes disabled' }, 403, cors);
          let id;
          try { id = await authIdentity(request, env, base, docId, auth); }
          catch (e) { return json({ error: 'invalid token' }, 401, cors); }
          if (!id || !id.canWrite) return json({ error: 'not authorized' }, 403, cors);

          if (request.method === 'DELETE' && rowId)
            return pass(await fetch(`${rowsUrl}/${encodeURIComponent(rowId)}`, { method: 'DELETE', headers: auth }), cors);

          if ((request.method === 'POST' && !rowId) || (request.method === 'PUT' && rowId)) {
            let body;
            try { body = JSON.parse((await request.text()) || '{}'); }
            catch (e) { return json({ error: 'bad body' }, 400, cors); }
            const cellSets = request.method === 'POST'
              ? (body.rows || []).map(r => (r.cells = r.cells || []))
              : (body.row ? [body.row.cells = body.row.cells || []] : []);
            // Approve = setting Status to Approved. Double-gate on canApprove (server-side).
            const approving = cellSets.some(cells => cells.some(c => c.column === 'Status' && c.value === 'Approved'));
            if (approving && !id.canApprove) return json({ error: 'approval requires Tribal Council' }, 403, cors);
            const today = new Date().toISOString().slice(0, 10);
            for (const cells of cellSets) {
              setCell(cells, 'Edited by', [id.personId]);
              if (request.method === 'POST') setCell(cells, 'Created by', [id.personId]);
              if (approving) { setCell(cells, 'Approved by', [id.personId]); setCell(cells, 'Approved at', today); }
            }
            const target = request.method === 'POST' ? rowsUrl : `${rowsUrl}/${encodeURIComponent(rowId)}`;
            return pass(await fetch(target, { method: request.method, headers: auth, body: JSON.stringify(body) }), cors);
          }
          return json({ error: 'bad write request' }, 400, cors);
        }

        if (request.method === 'GET' && !rowId) {
          const out = await readAllRows(rowsUrl, auth);
          return out.ok ? json({ items: out.items }, 200, cors) : pass(out.resp, cors);
        }
      }
      if (parts[0] === 'ref' && request.method === 'GET') {
        // Read-only reference lists for the editor's relation pickers. Only the
        // allowlisted tables below are reachable — never arbitrary tables.
        const REF = { programs: 'grid-g87NFbtqN8', people: 'grid-X316Eql8dE', venues: 'grid-foC40iAOaX', 'venue-types': 'grid-idEVRQX7SL' };
        const refTable = REF[parts[1]];
        if (!refTable) return json({ error: 'unknown reference' }, 404, cors);
        const out = await readAllRows(`${base}/docs/${docId}/tables/${refTable}/rows`, auth);
        return out.ok ? json({ items: out.items }, 200, cors) : pass(out.resp, cors);
      }
      if (parts[0] === 'me' && request.method === 'GET') {
        let id = null;
        try { id = await authIdentity(request, env, base, docId, auth); }
        catch (e) { return json({ error: 'invalid token' }, 401, cors); }
        if (!id) return json({ signedIn: false }, 200, cors);
        return json({ signedIn: true, matched: id.matched, name: id.name || null, canWrite: id.canWrite, canApprove: id.canApprove }, 200, cors);
      }
      return json({ error: 'not found' }, 404, cors);
    } catch (e) {
      return json({ error: String((e && e.message) || e) }, 502, cors);
    }
  },
};

function corsHeaders(origin, env) {
  const allow = env.ALLOWED_ORIGIN ? (origin === env.ALLOWED_ORIGIN ? origin : env.ALLOWED_ORIGIN) : (origin || '*');
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-App-Key, Authorization',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
}
const json = (obj, status, cors) =>
  new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', ...cors } });
const pass = async (r, cors) =>
  new Response(await r.text(), { status: r.status, headers: { 'Content-Type': 'application/json', ...cors } });

// Read every page of a table's rows (column names + simpleWithArrays), aggregated.
// Returns { ok:true, items } or { ok:false, resp } carrying the upstream error.
async function readAllRows(rowsUrl, auth) {
  const items = [];
  let pageToken = null, pages = 0;
  do {
    const u = new URL(rowsUrl);
    u.searchParams.set('useColumnNames', 'true');
    u.searchParams.set('valueFormat', 'simpleWithArrays');
    u.searchParams.set('limit', '200');
    if (pageToken) u.searchParams.set('pageToken', pageToken);
    const r = await fetch(u.toString(), { headers: auth });
    if (!r.ok) return { ok: false, resp: r };
    const j = await r.json();
    if (Array.isArray(j.items)) items.push(...j.items);
    pageToken = j.nextPageToken || null;
  } while (pageToken && ++pages < 6);
  return { ok: true, items };
}

// Replace (or append) a cell by column name in a Coda cells array.
function setCell(cells, column, value) {
  const c = cells.find(x => x.column === column);
  if (c) c.value = value; else cells.push({ column, value });
}

// --- Google ID-token verification (RS256 via JWKS) ---
let _jwks = null, _jwksExp = 0;
async function googleKeys() {
  if (_jwks && Date.now() < _jwksExp) return _jwks;
  const r = await fetch('https://www.googleapis.com/oauth2/v3/certs');
  const j = await r.json();
  _jwks = {}; for (const k of j.keys) _jwks[k.kid] = k;
  _jwksExp = Date.now() + 3600_000;                 // ~1h; Google keys rotate slowly
  return _jwks;
}
function b64url(s) {
  s = String(s).replace(/-/g, '+').replace(/_/g, '/');
  s += '='.repeat((4 - s.length % 4) % 4);
  const bin = atob(s), u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return u;
}
async function verifyGoogleIdToken(token, clientId) {
  const p = String(token || '').split('.');
  if (p.length !== 3) throw new Error('malformed token');
  const header = JSON.parse(new TextDecoder().decode(b64url(p[0])));
  const payload = JSON.parse(new TextDecoder().decode(b64url(p[1])));
  const jwk = (await googleKeys())[header.kid];
  if (!jwk) throw new Error('unknown signing key');
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64url(p[2]), new TextEncoder().encode(`${p[0]}.${p[1]}`));
  if (!ok) throw new Error('bad signature');
  if (payload.iss !== 'accounts.google.com' && payload.iss !== 'https://accounts.google.com') throw new Error('bad iss');
  if (payload.aud !== clientId) throw new Error('bad aud');
  if (!payload.exp || Date.now() / 1000 > payload.exp) throw new Error('expired');
  if (payload.email_verified !== true && payload.email_verified !== 'true') throw new Error('email unverified');
  return String(payload.email || '').toLowerCase();
}

// --- email -> EST People SRC person + role (Program Lead/Tribal Council) ---
const PEOPLE_TABLE = 'grid-X316Eql8dE';
const WRITE_STATUSES = ['Program Lead', 'Tribal Council'];
const APPROVE_STATUSES = ['Tribal Council'];
// Coda's `query` param doesn't match formula columns like `All Emails`, so we
// fetch the People table (cached per isolate) and filter in the Worker.
let _people = null, _peopleExp = 0;
async function peopleRows(base, docId, auth) {
  if (_people && Date.now() < _peopleExp) return _people;
  const out = await readAllRows(`${base}/docs/${docId}/tables/${PEOPLE_TABLE}/rows`, auth);
  _people = out.ok ? out.items : [];
  _peopleExp = Date.now() + 300_000;                 // 5-min cache
  return _people;
}
async function resolvePerson(email, base, docId, auth) {
  const rows = await peopleRows(base, docId, auth);
  const row = rows.find(r => {
    const em = r.values['All Emails'];
    const list = (em == null || em === '') ? [] : (Array.isArray(em) ? em : [em]);
    return list.some(x => String(x).toLowerCase() === email);
  });
  if (!row) return null;
  const st = row.values['Leadership Status'];
  const roles = (st == null || st === '') ? [] : (Array.isArray(st) ? st : [st]);
  return {
    personId: row.id,
    name: row.values['Full Name'] || email,
    canWrite: roles.some(s => WRITE_STATUSES.includes(s)),
    canApprove: roles.some(s => APPROVE_STATUSES.includes(s)),
  };
}
// null = no Bearer token; throws = invalid token (-> 401); else identity object.
async function authIdentity(request, env, base, docId, auth) {
  const m = (request.headers.get('Authorization') || '').match(/^Bearer\s+(.+)$/i);
  if (!m) return null;
  const email = await verifyGoogleIdToken(m[1], env.GOOGLE_CLIENT_ID);
  const person = await resolvePerson(email, base, docId, auth);
  if (!person) return { matched: false, email, canWrite: false, canApprove: false };
  return { matched: true, ...person };
}
