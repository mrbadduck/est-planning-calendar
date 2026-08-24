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
