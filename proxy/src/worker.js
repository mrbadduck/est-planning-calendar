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
 *   POST   /notes-doc   push the row's notes-doc button by id (body: { rowId }) — role-gated
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
import { parseVEvents } from './ical.js';
import { zonedToUtcISO, eventToEventbritePayload, ticketClassPayload, structuredContentBody, venuePayload, eventbriteWebUrl } from './eventbrite.js';

const REF_CACHE = new Map();   // per-isolate cache for /ref/* { name -> {items, exp} }
let REFERENCES_CACHE = null;   // per-isolate { data:{layers,events}, exp } — one global key (config is one table)
const REFERENCES_TABLE = 'grid-vg-fRbtoyr';   // Reference Calendars SRC (council-managed)

// Resolve a column's CURRENT name from its stable id (cached per isolate) so the
// app can read a value by id even after the column is renamed in Coda.
const COL_NAME_CACHE = new Map();   // colId -> { name, exp }
async function columnName(base, docId, tableId, colId, auth){
  const hit = COL_NAME_CACHE.get(colId);
  if (hit && hit.exp > Date.now()) return hit.name;
  // List columns (limit high enough to cover all of them — the notes column was
  // added last) and find ours by stable id. The list endpoint is the same family
  // the /ref reads use; the single-column GET proved unreliable with this token.
  const r = await fetch(`${base}/docs/${docId}/tables/${tableId}/columns?limit=200`, { headers: auth });
  if (!r.ok) return null;
  const j = await r.json();
  const col = (j.items || []).find(c => c.id === colId);
  const name = (col && col.name) || null;
  if (name) COL_NAME_CACHE.set(colId, { name, exp: Date.now() + 5 * 60 * 1000 });
  return name;
}
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
          if (!out.ok) return pass(out.resp, cors);
          // Anchor the notes URL to its stable column id, not its (renameable) name.
          const nm = env.CODA_NOTES_COL_ID ? await columnName(base, docId, tableId, env.CODA_NOTES_COL_ID, auth) : null;
          if (nm) for (const it of out.items) { it.notesDocUrl = (it.values || {})[nm] || null; }
          return json({ items: out.items }, 200, cors);
        }
      }
      if (parts[0] === 'ref' && request.method === 'GET') {
        // Read-only reference lists for the editor's relation pickers. Only the
        // allowlisted tables below are reachable — never arbitrary tables.
        const REF = { programs: 'grid-g87NFbtqN8', people: 'grid-X316Eql8dE', venues: 'grid-foC40iAOaX', 'venue-types': 'grid-idEVRQX7SL' };
        const name = parts[1];
        const refTable = REF[name];
        if (!refTable) return json({ error: 'unknown reference' }, 404, cors);
        // Per-isolate cache — ref data changes rarely and /ref/people is very slow
        // to fetch (1128 rows over 6 Coda pages). Warm isolates serve it instantly.
        const hit = REF_CACHE.get(name);
        if (hit && hit.exp > Date.now()) return json({ items: hit.items }, 200, cors);
        const out = await readAllRows(`${base}/docs/${docId}/tables/${refTable}/rows`, auth);
        if (!out.ok) return pass(out.resp, cors);
        // People is ~1128 rows x ~50 cols — project to just what the editor's
        // pickers need: {id, name, lead}. `lead` = write-authorized leadership,
        // so one fetch powers both the Leads chip list and the Volunteers
        // typeahead. Other ref tables (small) pass through whole.
        let items;
        if (name === 'people') {
          items = out.items.map(r => {
            const v = r.values || {};
            const st = v['Leadership Status'];
            const roles = (st == null || st === '') ? [] : (Array.isArray(st) ? st : [st]);
            return { id: r.id, name: r.name || v['Full Name'] || '', lead: roles.some(s => WRITE_STATUSES.includes(s)) };
          }).filter(p => p.name);
        } else {
          items = out.items;
        }
        REF_CACHE.set(name, { items, exp: Date.now() + 5 * 60 * 1000 });
        return json({ items }, 200, cors);
      }
      if (parts[0] === 'references' && request.method === 'GET') {
        // Public reference calendars: read the config table, fetch + parse each
        // enabled .ics server-side (browser fetch is CORS-blocked). No auth (public
        // data), GET only — same posture as /rows and /ref. Cached ~1h per isolate.
        if (REFERENCES_CACHE && REFERENCES_CACHE.exp > Date.now())
          return json(REFERENCES_CACHE.data, 200, cors);
        const data = await buildReferences(base, docId, auth);
        REFERENCES_CACHE = { data, exp: Date.now() + 3600_000 };
        return json(data, 200, cors);
      }
      if (parts[0] === 'me' && request.method === 'GET') {
        let id = null;
        try { id = await authIdentity(request, env, base, docId, auth); }
        catch (e) { return json({ error: 'invalid token' }, 401, cors); }
        if (!id) return json({ signedIn: false }, 200, cors);
        return json({ signedIn: true, matched: id.matched, name: id.name || null, canWrite: id.canWrite, canApprove: id.canApprove }, 200, cors);
      }
      if (parts[0] === 'publish' && parts[1] === 'eventbrite' && request.method === 'POST') {
        // Publish an Approved planning row out to Eventbrite: create-once (idempotent
        // via the stored Eventbrite Event ID), venue, ticket class, structured-content
        // description, then publish — writing status/ids back to the row and appending
        // to the Publish Log at each significant step. Same write gate as row writes.
        if (env.ALLOW_WRITES !== 'true') return json({ error: 'writes disabled' }, 403, cors);
        if (!env.EVENTBRITE_TOKEN || !env.EVENTBRITE_ORG_ID) return json({ error: 'eventbrite not configured' }, 500, cors);
        let id; try { id = await authIdentity(request, env, base, docId, auth); }
        catch (e) { return json({ error: 'invalid token' }, 401, cors); }
        if (!id || !id.canWrite) return json({ error: 'not authorized' }, 403, cors);

        let body; try { body = JSON.parse((await request.text()) || '{}'); } catch (e) { return json({ error: 'bad body' }, 400, cors); }
        const rowId = body.rowId;
        if (!rowId) return json({ error: 'rowId required' }, 400, cors);

        const rowsUrl = `${base}/docs/${docId}/tables/${tableId}/rows`;
        const one = await fetch(`${rowsUrl}/${encodeURIComponent(rowId)}?useColumnNames=true&valueFormat=simpleWithArrays`, { headers: auth });
        if (!one.ok) return json({ error: 'row not found' }, 404, cors);
        const row = await one.json();
        const V = row.values || {};
        if (String(V['Status'] || '').toLowerCase() !== 'approved') return json({ error: 'event must be Approved before publishing' }, 409, cors);
        if (String(V['Scheduling'] || 'Exact').toLowerCase() !== 'exact' || !V['Date'] || !V['Start'])
          return json({ error: 'publish needs an exact date and start time' }, 409, cors);

        const setRow = (cells) => fetch(`${rowsUrl}/${encodeURIComponent(rowId)}`, { method: 'PUT', headers: auth, body: JSON.stringify({ row: { cells } }) });
        const fail = async (action, r) => {
          const msg = (r.body && (r.body.error_description || r.body.error)) || `HTTP ${r.status}`;
          await setRow([{ column: 'Publish status', value: 'Error' }, { column: 'Last publish error', value: String(msg) }]);
          await logPublish(env, base, docId, auth, { rowId, actorId: id.personId, action, ok: false, status: r.status, message: String(msg) });
          return json({ error: msg, step: action }, 502, cors);
        };

        const ev = {
          title: V['Title'] || '', date: String(V['Date']).slice(0, 10),
          start: (String(V['Start']).match(/(?:T|^)(\d{2}:\d{2})/) || [])[1] || '',
          end:   (String(V['End']  || '').match(/(?:T|^)(\d{2}:\d{2})/) || [])[1] || '',
          capacity: Number(V['Capacity']) || undefined,
          description: V['Event Description'] || '',
          addressVisibility: V['Address visibility'] || 'Public',
          ebId: V['Eventbrite Event ID'] || '', tcId: V['Eventbrite Ticket Class ID'] || '',
        };
        const tz = env.EVENTBRITE_TZ || 'America/Chicago';
        await setRow([{ column: 'Publish status', value: 'Publishing' }]);

        // 1. create-once (store id immediately so a retry never duplicates)
        let ebId = ev.ebId;
        if (!ebId) {
          const r = await ebCreateEvent(env, eventToEventbritePayload(ev, tz));
          if (!r.ok) return fail('create', r);
          ebId = r.body.id;
          await setRow([{ column: 'Eventbrite Event ID', value: ebId }, { column: 'Eventbrite URL', value: eventbriteWebUrl(ebId) }]);
          await logPublish(env, base, docId, auth, { rowId, actorId: id.personId, action: 'create', ok: true, status: r.status, ebId, ebUrl: eventbriteWebUrl(ebId) });
        } else {
          const r = await ebUpdateEvent(env, ebId, eventToEventbritePayload(ev, tz));
          if (!r.ok) return fail('update', r);
        }

        // 2. venue (empty -> online; named -> resolve/create + attach)
        const venueRes = await ensureEbVenue(env, base, docId, auth, V, ev.addressVisibility, ebId);
        if (venueRes && venueRes.error) return fail('venue', venueRes.error);

        // 3. ticket class (free v1)
        if (!ev.tcId) {
          const r = await ebCreateTicket(env, ebId, ticketClassPayload(ev));
          if (!r.ok) return fail('ticket', r);
          await setRow([{ column: 'Eventbrite Ticket Class ID', value: r.body.id }]);
        } else {
          const r = await ebUpdateTicket(env, ebId, ev.tcId, ticketClassPayload(ev));
          if (!r.ok) return fail('ticket', r);
        }

        // 4. structured content (description body) — read version, write version+1
        const sc = await ebGetStructuredContent(env, ebId);
        const ver = ((sc.body && sc.body.page_version_number) || 0) + 1;
        const { _version, ...scBody } = structuredContentBody(ev.description, ver);
        const scr = await ebSetStructuredContent(env, ebId, ver, scBody);
        if (!scr.ok) return fail('structured-content', scr);

        // 5. publish
        const pub = await ebPublish(env, ebId);
        if (!pub.ok) return fail('publish', pub);

        // 6. success write-back + log
        await setRow([
          { column: 'Publish status', value: 'Published' }, { column: 'Published?', value: true },
          { column: 'Last published at', value: new Date().toISOString() }, { column: 'Last publish error', value: '' },
        ]);
        await logPublish(env, base, docId, auth, { rowId, actorId: id.personId, action: 'publish', ok: true, status: pub.status, ebId, ebUrl: eventbriteWebUrl(ebId) });
        return json({ ok: true, eventbriteId: ebId, url: eventbriteWebUrl(ebId) }, 200, cors);
      }
      if (parts[0] === 'notes-doc' && request.method === 'POST') {
        // Provision a Planning-Notes Google Doc by pushing the row's notes-doc
        // button (by id) via the Coda API. Same write gate as row writes; reuses
        // the doc-scoped token (no new secret). The button itself runs the Google
        // Drive pack's Copy file and writes the URL back into the Notes Doc column.
        if (env.ALLOW_WRITES !== 'true') return json({ error: 'writes disabled' }, 403, cors);
        const buttonId = env.CODA_NOTES_BUTTON_ID;
        if (!buttonId) return json({ error: 'proxy not configured (CODA_NOTES_BUTTON_ID)' }, 500, cors);
        let id;
        try { id = await authIdentity(request, env, base, docId, auth); }
        catch (e) { return json({ error: 'invalid token' }, 401, cors); }
        if (!id || !id.canWrite) return json({ error: 'not authorized' }, 403, cors);
        let body;
        try { body = JSON.parse((await request.text()) || '{}'); }
        catch (e) { return json({ error: 'bad body' }, 400, cors); }
        const rowId = body.rowId;
        if (!rowId) return json({ error: 'rowId required' }, 400, cors);
        const btnUrl = `${base}/docs/${docId}/tables/${tableId}/rows/${encodeURIComponent(rowId)}/buttons/${encodeURIComponent(buttonId)}`;
        return pass(await fetch(btnUrl, { method: 'POST', headers: auth }), cors);
      }
      return json({ error: 'not found' }, 404, cors);
    } catch (e) {
      return json({ error: String((e && e.message) || e) }, 502, cors);
    }
  },
};

function corsHeaders(origin, env) {
  // ALLOWED_ORIGIN may be a comma-separated allowlist (e.g. the deploy origin
  // plus http://localhost:8080 for local dev). Reflect the request's Origin when
  // it's on the list; otherwise fall back to the first (canonical) entry.
  const list = (env.ALLOWED_ORIGIN || '').split(',').map(s => s.trim()).filter(Boolean);
  const allow = list.length ? (list.includes(origin) ? origin : list[0]) : (origin || '*');
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

// Coerce a Coda cell that may be a plain URL string or a { url } urlref object.
function cellUrl(v) {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return cellUrl(v[0]);
  if (typeof v === 'object' && v.url) return String(v.url);
  return '';
}

// Slug a calendar name into a stable, url-safe layer id.
function slugId(name) {
  return String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'ref';
}

// Read the config table, fetch + parse each enabled feed, return {layers, events}.
// One bad feed is skipped (logged) so it can't break the rest. Events are bounded
// to ~6 months back .. ~18 months ahead to keep payloads sane.
async function buildReferences(base, docId, auth) {
  const out = await readAllRows(`${base}/docs/${docId}/tables/${REFERENCES_TABLE}/rows`, auth);
  if (!out.ok) throw new Error('references config read failed');

  const now = new Date();
  const lo = new Date(now.getFullYear(), now.getMonth() - 6, 1).toISOString().slice(0, 10);
  const hi = new Date(now.getFullYear(), now.getMonth() + 18, 1).toISOString().slice(0, 10);

  const layers = [];
  const events = [];
  const seen = new Set();
  for (const row of out.items) {
    const v = row.values || {};
    if (v['Enabled'] !== true) continue;
    const name = row.name || v['Name'] || '';
    const url = cellUrl(v['iCal URL']);
    if (!name || !url) continue;
    let id = slugId(name);
    while (seen.has(id)) id = `${id}-x`;
    seen.add(id);
    layers.push({ id, name, color: v['Color'] || '#888', defaultOn: v['Default on'] === true });
    try {
      const r = await fetch(url);
      if (!r.ok) { console.log(`references: ${name} feed HTTP ${r.status}, skipped`); continue; }
      const parsed = parseVEvents(await r.text(), { expandUntil: hi, descriptionMax: 2000 });
      for (const ev of parsed) {
        if (ev.date < lo || ev.date > hi) continue;
        events.push({
          id: `${id}-${ev.date}-${slugId(ev.title).slice(0, 8)}`,
          source: 'ref', refLayer: id, program: 'oth',
          title: ev.title, date: ev.date, allDay: ev.allDay,
          start: ev.start, end: ev.end,
          description: ev.description, location: ev.location, url: ev.url,
          readOnly: true, status: 'ref', leads: [],
        });
      }
    } catch (e) {
      console.log(`references: ${name} feed error ${(e && e.message) || e}, skipped`);
    }
  }
  return { layers, events };
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
// Match the verified email against `All Emails` (a formula column, so it can't be
// server-side queried — a query on the Leadership Status relation returned an
// incomplete set). Fetch the People table once (5-min per-isolate cache) and filter
// here. Same read /ref/people already does, so it's proven + cheap after warm-up.
let _people = null, _peopleExp = 0;
async function peopleRows(base, docId, auth) {
  if (_people && Date.now() < _peopleExp) return _people;
  const out = await readAllRows(`${base}/docs/${docId}/tables/${PEOPLE_TABLE}/rows`, auth);
  _people = out.ok ? out.items : [];
  _peopleExp = Date.now() + 300_000;                   // 5-min cache
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

// --- Eventbrite v3 I/O client -------------------------------------------------
// Thin wrappers over the Eventbrite REST API. Each returns {ok,status,body}; the
// route inspects those and never lets a non-2xx pass silently. The pure payload
// builders live in ./eventbrite.js (imported above) — this file only does I/O.
const EB_BASE = 'https://www.eventbriteapi.com/v3';
async function ebFetch(env, path, method = 'GET', body) {
  const r = await fetch(`${EB_BASE}${path}`, {
    method,
    headers: { Authorization: `Bearer ${env.EVENTBRITE_TOKEN}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  let j = null; try { j = await r.json(); } catch (_) {}
  return { ok: r.ok, status: r.status, body: j };
}
const ebCreateEvent = (env, payload) => ebFetch(env, `/organizations/${env.EVENTBRITE_ORG_ID}/events/`, 'POST', payload);
const ebUpdateEvent = (env, id, payload) => ebFetch(env, `/events/${id}/`, 'POST', payload);
const ebCreateVenue = (env, payload) => ebFetch(env, `/organizations/${env.EVENTBRITE_ORG_ID}/venues/`, 'POST', payload);
const ebCreateTicket = (env, id, payload) => ebFetch(env, `/events/${id}/ticket_classes/`, 'POST', payload);
const ebUpdateTicket = (env, id, tcId, payload) => ebFetch(env, `/events/${id}/ticket_classes/${tcId}/`, 'POST', payload);
const ebGetStructuredContent = (env, id) => ebFetch(env, `/events/${id}/structured_content/`, 'GET');
const ebSetStructuredContent = (env, id, version, body) => ebFetch(env, `/events/${id}/structured_content/${version}/`, 'POST', body);
const ebPublish = (env, id) => ebFetch(env, `/events/${id}/publish/`, 'POST');

// Append one row to the Publish Log table. Logging must NEVER throw — a failed
// log write can't be allowed to break (or falsely fail) the publish path.
async function logPublish(env, base, docId, auth, rec) {
  if (!env.CODA_PUBLISH_LOG_TABLE) return;
  const cells = [
    { column: 'When', value: new Date().toISOString() },
    { column: 'Planning Event', value: rec.rowId ? [rec.rowId] : [] },
    { column: 'Actor', value: rec.actorId ? [rec.actorId] : [] },
    { column: 'Target', value: 'Eventbrite' },
    { column: 'Action', value: rec.action },
    { column: 'Result', value: rec.ok ? 'ok' : 'error' },
    { column: 'Eventbrite ID', value: rec.ebId || '' },
    { column: 'Eventbrite URL', value: rec.ebUrl || '' },
    { column: 'HTTP status', value: rec.status || 0 },
    { column: 'Message', value: rec.message || '' },
  ];
  try {
    await fetch(`${base}/docs/${docId}/tables/${env.CODA_PUBLISH_LOG_TABLE}/rows`,
      { method: 'POST', headers: auth, body: JSON.stringify({ rows: [{ cells }] }) });
  } catch (_) { /* logging must never break the publish path */ }
}

// Resolve the planning row's venue to an Eventbrite venue and attach it to the
// event. `V['Venue']` is an array of venue display-name strings (or empty).
//   - empty -> mark the event online, return null (or {error:r} if that update fails)
//   - named -> look the venue up in EST Venues SRC; reuse its cached Eventbrite
//     Venue ID if present, else create the venue on Eventbrite (passing
//     addressVisibility through so registrants-only never leaks an address) and
//     cache the id back into the row (non-fatal if that write fails). Then set
//     venue_id on the event.
// Returns null on success, or {error:<{ok,status,body}>} to let the caller fail().
const EB_VENUES_TABLE = 'grid-foC40iAOaX';   // EST Venues SRC
async function ensureEbVenue(env, base, docId, auth, V, addressVisibility, ebId) {
  const names = Array.isArray(V['Venue']) ? V['Venue'] : (V['Venue'] ? [V['Venue']] : []);
  const name = names[0];
  if (!name) {
    const r = await ebUpdateEvent(env, ebId, { event: { online_event: true } });
    return r.ok ? null : { error: r };
  }
  const out = await readAllRows(`${base}/docs/${docId}/tables/${EB_VENUES_TABLE}/rows`, auth);
  const found = out.ok ? out.items.find(row => String((row.values || {})['Venue Name'] || '') === String(name)) : null;
  let venueId = found && (found.values || {})['Eventbrite Venue ID'];
  if (!venueId) {
    const r = await ebCreateVenue(env, venuePayload({ name, address: (found && found.values['Address']) || '' }, addressVisibility));
    if (!r.ok) return { error: r };
    venueId = r.body.id;
    if (found) {
      try {
        await fetch(`${base}/docs/${docId}/tables/${EB_VENUES_TABLE}/rows/${encodeURIComponent(found.id)}`,
          { method: 'PUT', headers: auth, body: JSON.stringify({ row: { cells: [{ column: 'Eventbrite Venue ID', value: venueId }] } }) });
      } catch (_) { /* caching the id back is best-effort; still use it below */ }
    }
  }
  const u = await ebUpdateEvent(env, ebId, { event: { venue_id: venueId } });
  return u.ok ? null : { error: u };
}
