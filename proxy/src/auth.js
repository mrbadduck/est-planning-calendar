// Firebase ID-token verification (RS256 via the securetoken JWKS).
// Same shape as the old Google Sign-In verify, different iss/aud/keys.

export function b64url(s) {
  s = String(s).replace(/-/g, '+').replace(/_/g, '/');
  s += '='.repeat((4 - s.length % 4) % 4);
  const bin = atob(s), u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return u;
}

// Pure claim validation — throws on any bad claim, else returns lowercased email.
export function firebaseClaims(payload, projectId, nowSec) {
  if (payload.iss !== `https://securetoken.google.com/${projectId}`) throw new Error('bad iss');
  if (payload.aud !== projectId) throw new Error('bad aud');
  if (!payload.exp || nowSec > payload.exp) throw new Error('expired');
  if (!payload.sub) throw new Error('no subject');
  const email = String(payload.email || '').toLowerCase();
  if (!email) throw new Error('no email');
  if (payload.email_verified !== true && payload.email_verified !== 'true') throw new Error('email unverified');
  return email;
}

// Firebase publishes RS256 public keys in JWK form here (importable directly).
let _jwks = null, _jwksExp = 0;
async function firebaseKeys() {
  if (_jwks && Date.now() < _jwksExp) return _jwks;
  const r = await fetch('https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com');
  const j = await r.json();
  _jwks = {}; for (const k of j.keys) _jwks[k.kid] = k;
  _jwksExp = Date.now() + 3600_000;                  // ~1h; keys rotate slowly
  return _jwks;
}

// Verifies signature + claims. Returns { email, name } from the VERIFIED token
// (never trust a client-sent name), or throws (-> 401). `name` may be '' — magic-
// link sign-ins have no display name.
export async function verifyFirebaseToken(token, projectId, now = Date.now()) {
  const p = String(token || '').split('.');
  if (p.length !== 3) throw new Error('malformed token');
  const header = JSON.parse(new TextDecoder().decode(b64url(p[0])));
  const payload = JSON.parse(new TextDecoder().decode(b64url(p[1])));
  const jwk = (await firebaseKeys())[header.kid];
  if (!jwk) throw new Error('unknown signing key');
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64url(p[2]), new TextEncoder().encode(`${p[0]}.${p[1]}`));
  if (!ok) throw new Error('bad signature');
  const email = firebaseClaims(payload, projectId, Math.floor(now / 1000));
  return { email, name: String(payload.name || '').trim() };
}

// Back-compat: the email-only shape the write/role path already uses.
export async function verifyFirebaseIdToken(token, projectId, now = Date.now()) {
  return (await verifyFirebaseToken(token, projectId, now)).email;
}
