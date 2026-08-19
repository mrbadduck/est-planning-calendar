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
 *
 * Config (see wrangler.toml and .dev.vars.example):
 *   CODA_API_TOKEN  (secret)  doc/table-scoped token, read+write
 *   CODA_DOC_ID     (var)     Mission Control doc id
 *   CODA_TABLE_ID   (var)     planning table id
 *   CODA_API_BASE   (var)     default https://coda.io/apis/v1 (still resolves post-rename)
 *   ALLOWED_ORIGIN  (var)     optional; lock CORS to the app's deploy origin
 *   ALLOW_WRITES    (var)     optional; 'true' enables POST/PUT/DELETE (Phase 2)
 *   APP_KEY         (secret)  optional shared secret required in X-App-Key header
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

        // Phase 1 is read-only. Writes stay disabled unless ALLOW_WRITES==='true'
        // (Phase 2, alongside Google sign-in + allowlist). The token is also
        // read-scoped in Phase 1, so this is defense in depth.
        if (writing && env.ALLOW_WRITES !== 'true')
          return json({ error: 'writes disabled (Phase 1 is read-only)' }, 403, cors);

        if (request.method === 'GET' && !rowId) {
          // Aggregate all pages so date-relevant rows are never dropped by the
          // 200-row page cap (EST Events SRC spans more than one page).
          const items = [];
          let pageToken = null, pages = 0;
          do {
            const u = new URL(rowsUrl);
            u.searchParams.set('useColumnNames', 'true');
            u.searchParams.set('valueFormat', 'simpleWithArrays');
            u.searchParams.set('limit', '200');
            if (pageToken) u.searchParams.set('pageToken', pageToken);
            const r = await fetch(u.toString(), { headers: auth });
            if (!r.ok) return pass(r, cors);
            const j = await r.json();
            if (Array.isArray(j.items)) items.push(...j.items);
            pageToken = j.nextPageToken || null;
          } while (pageToken && ++pages < 6);
          return json({ items }, 200, cors);
        }
        if (request.method === 'POST' && !rowId)
          return pass(await fetch(rowsUrl, { method: 'POST', headers: auth, body: await request.text() }), cors);
        if (request.method === 'PUT' && rowId)
          return pass(await fetch(`${rowsUrl}/${encodeURIComponent(rowId)}`, { method: 'PUT', headers: auth, body: await request.text() }), cors);
        if (request.method === 'DELETE' && rowId)
          return pass(await fetch(`${rowsUrl}/${encodeURIComponent(rowId)}`, { method: 'DELETE', headers: auth }), cors);
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
    'Access-Control-Allow-Headers': 'Content-Type, X-App-Key',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
}
const json = (obj, status, cors) =>
  new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', ...cors } });
const pass = async (r, cors) =>
  new Response(await r.text(), { status: r.status, headers: { 'Content-Type': 'application/json', ...cors } });
