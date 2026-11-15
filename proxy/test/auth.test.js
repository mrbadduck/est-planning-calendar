import { test } from 'node:test';
import assert from 'node:assert/strict';
import { firebaseClaims } from '../src/auth.js';

const PROJ = 'est-demo';
const NOW = 1_760_000_000;                 // fixed "now" in seconds
const good = () => ({
  iss: `https://securetoken.google.com/${PROJ}`,
  aud: PROJ,
  sub: 'uid123',
  exp: NOW + 3600,
  email: 'Leah@example.org',
  email_verified: true,
});

test('firebaseClaims returns the lowercased email for a valid token', () => {
  assert.equal(firebaseClaims(good(), PROJ, NOW), 'leah@example.org');
});
test('firebaseClaims rejects a wrong issuer', () => {
  assert.throws(() => firebaseClaims({ ...good(), iss: 'https://securetoken.google.com/other' }, PROJ, NOW), /bad iss/);
});
test('firebaseClaims rejects a wrong audience', () => {
  assert.throws(() => firebaseClaims({ ...good(), aud: 'other' }, PROJ, NOW), /bad aud/);
});
test('firebaseClaims rejects an expired token', () => {
  assert.throws(() => firebaseClaims({ ...good(), exp: NOW - 1 }, PROJ, NOW), /expired/);
});
test('firebaseClaims rejects a missing subject', () => {
  assert.throws(() => firebaseClaims({ ...good(), sub: '' }, PROJ, NOW), /no subject/);
});
test('firebaseClaims rejects an unverified email', () => {
  assert.throws(() => firebaseClaims({ ...good(), email_verified: false }, PROJ, NOW), /unverified/);
});
test('firebaseClaims rejects a missing email', () => {
  assert.throws(() => firebaseClaims({ ...good(), email: '' }, PROJ, NOW), /no email/);
});

import { authErrorStatus, verifyFirebaseToken } from '../src/auth.js';
test('authErrorStatus: 401 only for a bad/expired token, else 503', () => {
  assert.equal(authErrorStatus(Object.assign(new Error('expired'), { authError: true })), 401);
  assert.equal(authErrorStatus(new Error('people read failed (500)')), 503);
  assert.equal(authErrorStatus(Object.assign(new Error('signing keys unavailable'), { transient: true })), 503);
  assert.equal(authErrorStatus(null), 503);
});
test('verifyFirebaseToken: Google key endpoint down is transient, not a bad token', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('network down'); };
  try {
    const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
    const tok = `${b64({ alg: 'RS256', kid: 'k1' })}.${b64({ sub: 'x' })}.sig`;
    await assert.rejects(verifyFirebaseToken(tok, 'p'), e => e.transient === true && /signing keys unavailable/.test(e.message));
    await assert.rejects(verifyFirebaseToken('not-a-token', 'p'), e => !e.transient && /malformed/.test(e.message));
  } finally { globalThis.fetch = realFetch; }
});
