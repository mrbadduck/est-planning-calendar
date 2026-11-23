/**
 * Google service-account access token for the Calendar API. WebCrypto only,
 * so it runs in the Worker and in Node 20+. Never log the key, JWT or token.
 */
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/calendar.events';
const KV_KEY = 'gcal-token';
const KV_TTL = 3300;     // seconds; Google tokens last 3600

function b64url(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
const enc = (str) => new TextEncoder().encode(str);

function pemToDer(pem) {
  const b64 = String(pem).replace(/\\n/g, '\n')
    .replace(/-----BEGIN [^-]+-----/, '').replace(/-----END [^-]+-----/, '').replace(/\s+/g, '');
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function signServiceJwt(saKey, scope, nowSec) {
  const key = await crypto.subtle.importKey('pkcs8', pemToDer(saKey.private_key),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const header = b64url(enc(JSON.stringify({ alg: 'RS256', typ: 'JWT' })));
  const claims = b64url(enc(JSON.stringify({
    iss: saKey.client_email, scope, aud: TOKEN_URL, iat: nowSec, exp: nowSec + 3600,
  })));
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, enc(`${header}.${claims}`));
  return `${header}.${claims}.${b64url(new Uint8Array(sig))}`;
}

export async function googleAccessToken(env) {
  const now = Math.floor(Date.now() / 1000);
  const kv = env.CACHE;
  if (kv) {
    try {
      const hit = await kv.get(KV_KEY, 'json');
      if (hit && hit.token && hit.exp > now + 60) return hit.token;
    } catch { /* cache miss; fall through to a fresh exchange */ }
  }
  if (!env.GOOGLE_SA_KEY) throw new Error('GOOGLE_SA_KEY not set');
  let saKey;
  try { saKey = JSON.parse(env.GOOGLE_SA_KEY); } catch { throw new Error('GOOGLE_SA_KEY is not valid JSON'); }
  const assertion = await signServiceJwt(saKey, SCOPE, now);
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }).toString(),
  });
  let data = null;
  try { data = await res.json(); } catch { /* non-JSON body */ }
  if (!res.ok || !data || !data.access_token) {
    throw new Error(`Google token exchange failed: HTTP ${res.status} ${(data && data.error) || 'unknown_error'}`);
  }
  if (kv) {
    try { await kv.put(KV_KEY, JSON.stringify({ token: data.access_token, exp: now + (data.expires_in || 3600) }), { expirationTtl: KV_TTL }); }
    catch { /* caching is best-effort */ }
  }
  return data.access_token;
}
