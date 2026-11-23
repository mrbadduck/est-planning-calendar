import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PEOPLE_COLS } from '../src/coda-columns.js';
import { PEOPLE_KV_KEY } from '../src/worker-io.js';

// A real RS256 Firebase token, verified against a stubbed JWKS, so the route's own
// canWrite gate runs unchanged.
const PROJ = 'est-test';
const keys = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
const jwk = { ...(await crypto.subtle.exportKey('jwk', keys.publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
const b64 = (s) => Buffer.from(s).toString('base64url');
async function token(email) {
  const head = b64(JSON.stringify({ alg: 'RS256', kid: 'k1' }));
  const body = b64(JSON.stringify({ iss: `https://securetoken.google.com/${PROJ}`, aud: PROJ, sub: email, email, email_verified: true, exp: Math.floor(Date.now() / 1000) + 3600 }));
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', keys.privateKey, new TextEncoder().encode(`${head}.${body}`));
  return `${head}.${body}.${Buffer.from(sig).toString('base64url')}`;
}
const person = (id, email, status) => ({ id, values: { [PEOPLE_COLS.fullName]: id, [PEOPLE_COLS.allEmails]: [email], [PEOPLE_COLS.leadershipStatus]: status } });
const kv = () => {
  const m = new Map([[PEOPLE_KV_KEY, JSON.stringify({ at: Date.now(), data: [person('i-lead', 'lead@x.org', ['Program Lead']), person('i-mem', 'mem@x.org', [])] })]]);
  return { m, get: async (k, t) => (m.has(k) ? (t === 'json' ? JSON.parse(m.get(k)) : m.get(k)) : null), put: async (k, v) => { m.set(k, v); }, delete: async (k) => { m.delete(k); } };
};
const doStub = (state) => {
  const calls = [];
  const obj = { fetch: async (u, init) => { calls.push({ path: new URL(u).pathname, body: JSON.parse(init.body) }); return new Response(JSON.stringify({ state }), { status: 200 }); } };
  return { calls, ns: { idFromName: (n) => n, get: () => obj } };
};
const env = (o = {}) => ({ CODA_DOC_ID: 'D', CODA_TABLE_ID: 'grid-plan', CODA_API_TOKEN: 't', FIREBASE_PROJECT_ID: PROJ, CACHE: kv(), ...o });

let coda = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (u) => {
  u = String(u);
  if (u.includes('/jwk/securetoken')) return new Response(JSON.stringify({ keys: [jwk] }), { status: 200 });
  coda.push(u);
  if (u.includes('/mutationStatus/')) return new Response(JSON.stringify({ completed: true }), { status: 200 });
  return new Response('{}', { status: 404 });
};
process.on('exit', () => { globalThis.fetch = realFetch; });
const { default: worker } = await import('../src/worker.js');
const get = async (e, email, id = 'mut-1') => {
  const r = await worker.fetch(new Request(`https://w/mutation/${id}`, { headers: { Authorization: `Bearer ${await token(email)}` } }), e, { waitUntil() {} });
  return { status: r.status, body: await r.json() };
};

test('/mutation asks the overlay first: pending, applied, failed answer with no Coda call', async () => {
  for (const [state, want] of [['pending', { completed: false }], ['applied', { completed: true }], ['failed', { completed: false, failed: true }]]) {
    coda = [];
    const d = doStub(state);
    const out = await get(env({ OVERLAY_MODE: 'live', OVERLAY: d.ns }), 'lead@x.org');
    assert.equal(out.status, 200); assert.deepEqual(out.body, want, state);
    assert.deepEqual(d.calls.map((c) => [c.path, c.body.requestId]), [['/status', 'mut-1']]);
    assert.equal(coda.length, 0, `${state}: no Coda call`);
  }
});

test('/mutation: a DO miss makes exactly one Coda call; overlay off never asks the DO', async () => {
  coda = [];
  let d = doStub(null);
  let out = await get(env({ OVERLAY_MODE: 'live', OVERLAY: d.ns }), 'lead@x.org');
  assert.deepEqual(out.body, { completed: true });
  assert.equal(coda.length, 1); assert.match(coda[0], /\/mutationStatus\/mut-1$/);
  coda = []; d = doStub('applied');
  out = await get(env({ OVERLAY_MODE: 'off', OVERLAY: d.ns }), 'lead@x.org');
  assert.deepEqual(out.body, { completed: true });
  assert.equal(d.calls.length, 0); assert.equal(coda.length, 1);
});

test('/mutation keeps its canWrite gate: a member without a write role gets 403 and no DO call', async () => {
  coda = [];
  const d = doStub('applied');
  const out = await get(env({ OVERLAY_MODE: 'live', OVERLAY: d.ns }), 'mem@x.org');
  assert.equal(out.status, 403);
  assert.equal(d.calls.length, 0); assert.equal(coda.length, 0);
});
