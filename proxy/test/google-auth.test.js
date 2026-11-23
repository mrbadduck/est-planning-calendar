import { test } from 'node:test';
import assert from 'node:assert/strict';
import { signServiceJwt, googleAccessToken } from '../src/google-auth.js';

const subtle = globalThis.crypto.subtle;
const SCOPE = 'https://www.googleapis.com/auth/calendar.events';
const b64 = (buf) => Buffer.from(buf).toString('base64');
const unb64url = (s) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');

async function makeKey() {
  const pair = await subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true, ['sign', 'verify']);
  const pkcs8 = await subtle.exportKey('pkcs8', pair.privateKey);
  const pem = `-----BEGIN PRIVATE KEY-----\n${b64(pkcs8).match(/.{1,64}/g).join('\n')}\n-----END PRIVATE KEY-----\n`;
  return { pair, pem };
}

function fakeKv(initial = {}) {
  const store = { ...initial }; const puts = [];
  return {
    store, puts,
    async get(k, type) { const v = store[k]; if (v == null) return null; return type === 'json' ? JSON.parse(v) : v; },
    async put(k, v, opts) { store[k] = v; puts.push({ k, v, opts }); },
  };
}

test('signServiceJwt: RS256 JWT with claims, verifiable signature', async () => {
  const { pair, pem } = await makeKey();
  const jwt = await signServiceJwt({ client_email: 'sa@x.iam.gserviceaccount.com', private_key: pem }, SCOPE, 1000);
  const parts = jwt.split('.');
  assert.equal(parts.length, 3);
  assert.ok(!/[+/=]/.test(jwt), 'base64url, no padding');
  assert.deepEqual(JSON.parse(unb64url(parts[0]).toString()), { alg: 'RS256', typ: 'JWT' });
  const claims = JSON.parse(unb64url(parts[1]).toString());
  assert.equal(claims.iss, 'sa@x.iam.gserviceaccount.com');
  assert.equal(claims.scope, SCOPE);
  assert.equal(claims.aud, 'https://oauth2.googleapis.com/token');
  assert.equal(claims.iat, 1000);
  assert.equal(claims.exp - claims.iat, 3600);
  const ok = await subtle.verify('RSASSA-PKCS1-v1_5', pair.publicKey, unb64url(parts[2]),
    new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
  assert.ok(ok);
});

async function envWith(kv) {
  const { pem } = await makeKey();
  // the secret holds the PEM with literal \n escapes
  const key = JSON.stringify({ client_email: 'sa@x.iam.gserviceaccount.com', private_key: pem.replace(/\n/g, '\\n') });
  return { GOOGLE_SA_KEY: key, CACHE: kv };
}

test('googleAccessToken: cache hit makes no fetch', async () => {
  const kv = fakeKv({ 'gcal-token': JSON.stringify({ token: 'cached', exp: Math.floor(Date.now() / 1000) + 600 }) });
  const orig = globalThis.fetch; let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error('no'); };
  try { assert.equal(await googleAccessToken({ CACHE: kv }), 'cached'); } finally { globalThis.fetch = orig; }
  assert.equal(calls, 0);
});

test('googleAccessToken: miss posts the form, caches the token for 3300 s', async () => {
  const kv = fakeKv();
  const env = await envWith(kv);
  const orig = globalThis.fetch; let seen;
  globalThis.fetch = async (url, init) => { seen = { url, init }; return new Response(JSON.stringify({ access_token: 'tok', expires_in: 3599 }), { status: 200 }); };
  try { assert.equal(await googleAccessToken(env), 'tok'); } finally { globalThis.fetch = orig; }
  assert.equal(seen.url, 'https://oauth2.googleapis.com/token');
  assert.equal(seen.init.method, 'POST');
  const body = new URLSearchParams(String(seen.init.body));
  assert.equal(body.get('grant_type'), 'urn:ietf:params:oauth:grant-type:jwt-bearer');
  assert.equal(body.get('assertion').split('.').length, 3);
  assert.equal(kv.puts.length, 1);
  assert.equal(kv.puts[0].k, 'gcal-token');
  assert.equal(kv.puts[0].opts.expirationTtl, 3300);
  const cached = JSON.parse(kv.puts[0].v);
  assert.equal(cached.token, 'tok');
  assert.ok(cached.exp > Date.now() / 1000 + 3500);
});

test('googleAccessToken: expiring cache entry is refreshed', async () => {
  const kv = fakeKv({ 'gcal-token': JSON.stringify({ token: 'old', exp: Math.floor(Date.now() / 1000) + 30 }) });
  const env = await envWith(kv);
  const orig = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ access_token: 'new', expires_in: 3600 }), { status: 200 });
  try { assert.equal(await googleAccessToken(env), 'new'); } finally { globalThis.fetch = orig; }
});

test('googleAccessToken: failed exchange throws status + error, never the assertion or key', async () => {
  const kv = fakeKv();
  const env = await envWith(kv);
  const orig = globalThis.fetch; let assertion;
  globalThis.fetch = async (u, init) => {
    assertion = new URLSearchParams(String(init.body)).get('assertion');
    return new Response(JSON.stringify({ error: 'invalid_grant', error_description: 'bad' }), { status: 400 });
  };
  let err;
  try { await googleAccessToken(env); } catch (e) { err = e; } finally { globalThis.fetch = orig; }
  assert.ok(err);
  assert.match(err.message, /400/);
  assert.match(err.message, /invalid_grant/);
  assert.ok(!err.message.includes(assertion));
  assert.ok(!err.message.includes('PRIVATE KEY'));
  assert.equal(kv.puts.length, 0);
});

test('googleAccessToken: missing GOOGLE_SA_KEY throws', async () => {
  await assert.rejects(googleAccessToken({ CACHE: fakeKv() }), { message: 'GOOGLE_SA_KEY not set' });
});
