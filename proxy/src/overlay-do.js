// The write overlay: a Durable Object that remembers the Worker's own Coda writes until
// Coda applies them (~28 s, decision 0008), so reads through the Worker can lay them on top.
// Coda is the truth; this only covers the apply gap (0012).
//
// Paths (all POST, JSON): /record {entries} -> {ok:true}
//                         /read {tableId}   -> {entries}  (every stored entry, with state)
//                         /status {requestId} -> {state: 'pending'|'applied'|'failed'|null}
// States: pending (Coda accepted it) -> applied (mutationStatus completed; appliedAt = now)
//         or failed (not applied within FAIL_AFTER_MS; no longer polled).
// Constants: APPLY_MARGIN_MS, FAIL_AFTER_MS, SWR_HARD_MS, KEEP_MS (everything is deleted by
// then), ALARM_EVERY_MS, POLLS_PER_ALARM. The merge (overlay.js) decides what is live.
// The alarm never busts a cache and never writes the Publish Log.
// Fetch-style on purpose: no `cloudflare:workers` import, so node tests can import worker.js.
import { mutationResult } from './publish.js';

export const APPLY_MARGIN_MS = 30_000;
export const FAIL_AFTER_MS = 120_000;
export const SWR_HARD_MS = 300_000;
export const KEEP_MS = SWR_HARD_MS + APPLY_MARGIN_MS;
export const ALARM_EVERY_MS = 5_000;
export const POLLS_PER_ALARM = 10;

const entryKey = (e) => `e:${e.tableId}:${e.rowId}:${e.key}:${e.writtenAt}`;
// Why an entry can't be stored, or null. A bad writtenAt would never fail or age out.
const nonEmpty = (v) => typeof v === 'string' && v !== '';
export function entryProblem(e) {
  if (!e || typeof e !== 'object') return 'not an object';
  for (const f of ['tableId', 'rowId', 'requestId']) if (!nonEmpty(e[f])) return `${f} must be a non-empty string`;
  if (typeof e.key !== 'string') return 'key must be a string';
  if (!Number.isFinite(e.writtenAt)) return 'writtenAt must be a finite number';
  if (!['set', 'insert', 'delete'].includes(e.op)) return 'op must be set|insert|delete';
  if (!['name', 'id'].includes(e.keying)) return 'keying must be name|id';
  return null;
}
const deleteAt = (x) => (x.state === 'applied' ? x.appliedAt : x.writtenAt) + KEEP_MS;

export class OverlayCore {
  constructor(storage, env, fetchFn, now) {
    this.storage = storage; this.env = env; this.fetch = fetchFn; this.now = now;
  }

  // The whole batch or nothing: {ok:false, error} when any entry is malformed.
  async record(entries) {
    if (!Array.isArray(entries)) return { ok: false, error: 'entries must be an array' };
    for (let i = 0; i < entries.length; i++) {
      const why = entryProblem(entries[i]);
      if (why) return { ok: false, error: `entry ${i}: ${why}` };
    }
    for (const e of entries) {
      const qk = `q:${e.requestId}`;
      let q = await this.storage.get(qk);
      if (!q) { q = { state: 'pending', writtenAt: e.writtenAt, appliedAt: null }; await this.storage.put(qk, q); }
      // A requestId already applied or failed: its new entries inherit that, so none is stuck pending.
      await this.storage.put(entryKey(e), { ...e, state: q.state, appliedAt: q.appliedAt });
    }
    // Pull the alarm forward: after an apply it sits at a far-off cleanup time, and a new write must be polled in seconds.
    const a = await this.storage.getAlarm(), soon = this.now() + ALARM_EVERY_MS;
    // An overdue alarm (a < now) is re-set too: never trust one that should already have run.
    if (a == null || a > soon || a < this.now()) await this.storage.setAlarm(soon);
    return { ok: true };
  }

  async read(tableId) {
    return [...(await this.storage.list({ prefix: `e:${tableId}:` })).values()];
  }

  async status(requestId) {
    const q = await this.storage.get(`q:${requestId}`);
    return q ? q.state : null;
  }

  // true | false (not completed yet) | null (could not tell; stays pending)
  async completed(requestId) {
    const base = this.env.CODA_API_BASE || 'https://coda.io/apis/v1';
    try {
      const r = await this.fetch(`${base}/mutationStatus/${encodeURIComponent(requestId)}`,
        { headers: { Authorization: `Bearer ${this.env.CODA_API_TOKEN}` } });
      let body = null;
      try { body = await r.json(); } catch (_) {}
      const out = mutationResult(r.status, body);
      if (out.httpStatus === 200) return out.json.completed;
      console.error(`overlay: mutationStatus ${requestId} answered ${r.status}; left pending`);
    } catch (e) {
      console.error(`overlay: mutationStatus ${requestId} failed (${String((e && e.message) || e)}); left pending`);
    }
    return null;
  }

  async setState(requestId, q, state, now) {
    const appliedAt = state === 'applied' ? now : null;
    await this.storage.put(`q:${requestId}`, { ...q, state, appliedAt });
    for (const [k, e] of await this.storage.list({ prefix: 'e:' }))
      if (e.requestId === requestId) await this.storage.put(k, { ...e, state, appliedAt });
  }

  async alarm() {
    const now = this.now();
    const pending = [...(await this.storage.list({ prefix: 'q:' }))]
      .filter(([, q]) => q.state === 'pending')
      .sort((a, b) => a[1].writtenAt - b[1].writtenAt)
      .slice(0, POLLS_PER_ALARM);
    for (const [k, q] of pending) {
      const requestId = k.slice(2);
      const done = await this.completed(requestId);
      if (done === true) await this.setState(requestId, q, 'applied', now);
      else if (now - q.writtenAt >= FAIL_AFTER_MS) {
        console.error(`overlay: ${requestId} not applied within ${FAIL_AFTER_MS / 1000} s; failed`);
        await this.setState(requestId, q, 'failed', now);
      }
    }
    let anyPending = false, earliest = Infinity;
    const all = await this.storage.list({ prefix: '' });
    for (const [k, stored] of all) {
      if (!k.startsWith('e:') && !k.startsWith('q:')) continue;
      let x = stored;
      if (k.startsWith('e:') && x.state === 'pending') {
        // An entry whose q: record isn't pending (or is gone) can never resolve: age it out.
        const q = all.get(`q:${x.requestId}`);
        if (!q || q.state !== 'pending') x = { ...x, state: q ? q.state : 'failed', appliedAt: q ? q.appliedAt : null };
      }
      const at = deleteAt(x);
      if (x.state !== 'pending' && now >= at) { await this.storage.delete(k); continue; }
      if (x.state === 'pending') anyPending = true;
      else earliest = Math.min(earliest, at);
    }
    if (anyPending) await this.storage.setAlarm(now + ALARM_EVERY_MS);
    else if (earliest !== Infinity) await this.storage.setAlarm(earliest);
  }
}

const reply = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

export class WriteOverlay {
  constructor(state, env) {
    this.core = new OverlayCore(state.storage, env, (...a) => fetch(...a), Date.now);
  }

  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (request.method !== 'POST' || !['/record', '/read', '/status'].includes(path)) return reply({ error: 'not found' }, 404);
    let body;
    try { body = await request.json(); } catch (_) {
      console.error(`overlay: ${path} body is not JSON`);
      return reply({ error: 'body is not JSON' }, 400);
    }
    try {
      if (path === '/record') {
        const out = await this.core.record(body && body.entries);
        if (!out.ok) {
          console.error(`overlay: /record refused (${out.error})`);
          return reply({ error: out.error }, 400);
        }
        return reply(out);
      }
      const field = path === '/read' ? 'tableId' : 'requestId';
      if (!nonEmpty(body && body[field])) {
        console.error(`overlay: ${path} without ${field}`);
        return reply({ error: `${field} must be a non-empty string` }, 400);
      }
      if (path === '/read') return reply({ entries: await this.core.read(body.tableId) });
      return reply({ state: await this.core.status(body.requestId) });
    } catch (e) {
      console.error(`overlay: ${path} failed (${String((e && e.message) || e)})`);
      return reply({ error: String((e && e.message) || e) }, 500);
    }
  }

  alarm() { return this.core.alarm(); }
}
