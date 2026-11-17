// web/venue-address.js is a plain script attaching `VenueAddress` to globalThis.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../../web/venue-address.js';

const V = globalThis.VenueAddress;
const addr = (o = {}) => ({ street: '12 Main St', unit: '', city: 'Nashville', state: 'TN', zip: '37206', ...o });

test('normalize trims, collapses spaces, uppercases state', () => {
  assert.deepEqual(V.normalize({ street: '  12   Main  St ', unit: ' Apt  2', city: ' Nashville ', state: ' tn ', zip: ' 37206 ' }),
    { street: '12 Main St', unit: 'Apt 2', city: 'Nashville', state: 'TN', zip: '37206' });
  assert.deepEqual(V.normalize({}), { street: '', unit: '', city: '', state: '', zip: '' });
  assert.deepEqual(V.normalize(null), { street: '', unit: '', city: '', state: '', zip: '' });
});

test('compose omits empty parts', () => {
  assert.equal(V.compose(addr()), '12 Main St, Nashville, TN 37206');
  assert.equal(V.compose(addr({ unit: 'Apt 2' })), '12 Main St, Apt 2, Nashville, TN 37206');
  assert.equal(V.compose(addr({ zip: '' })), '12 Main St, Nashville, TN');
  assert.equal(V.compose(addr({ state: '', zip: '37206' })), '12 Main St, Nashville, 37206');
  assert.equal(V.compose({}), '');
});

test('validate: complete address is ok', () => {
  assert.deepEqual(V.validate(addr(), {}), { ok: true, errors: {} });
  assert.equal(V.validate(addr({ zip: '' }), {}).ok, true);
  assert.equal(V.validate(addr({ zip: '37206-1234' }), {}).ok, true);
});

test('validate: blank only when allowBlank and every field empty', () => {
  assert.equal(V.validate({}, { allowBlank: true }).ok, true);
  const r = V.validate({}, {});
  assert.equal(r.ok, false);
  assert.equal(r.errors.street, 'Add the street');
  assert.equal(r.errors.city, 'Add the city');
  assert.equal(r.errors.state, 'Use the 2-letter state (e.g. TN)');
  const partial = V.validate({ street: '12 Main St' }, { allowBlank: true });
  assert.equal(partial.ok, false);
  assert.equal(partial.errors.city, 'Add the city');
  assert.equal(partial.errors.street, undefined);
});

test('validate: state and zip rules', () => {
  assert.equal(V.validate(addr({ state: 'ZZ' }), {}).errors.state, 'Use the 2-letter state (e.g. TN)');
  assert.equal(V.validate(addr({ state: 'Tennessee' }), {}).ok, false);
  assert.equal(V.validate(addr({ state: 'tn' }), {}).ok, true);
  assert.equal(V.validate(addr({ zip: '3720' }), {}).errors.zip, 'ZIP is 5 digits');
  assert.equal(V.validate(addr({ zip: '37206-12' }), {}).errors.zip, 'ZIP is 5 digits');
});

test('hasAddress: structured street+city, else legacy address', () => {
  assert.equal(V.hasAddress({ street: '12 Main St', city: 'Nashville' }), true);
  assert.equal(V.hasAddress({ street: '12 Main St', city: '', address: '' }), false);
  assert.equal(V.hasAddress({ street: '', city: 'Nashville' }), false);
  assert.equal(V.hasAddress({ address: '12 Main St, Nashville' }), true);
  assert.equal(V.hasAddress({ address: '   ' }), false);
  assert.equal(V.hasAddress({}), false);
  assert.equal(V.hasAddress(null), false);
});

test('sameName is case-insensitive and whitespace-collapsed', () => {
  assert.equal(V.sameName('The  Shul', 'the shul '), true);
  assert.equal(V.sameName('The Shul', 'The Shull'), false);
  assert.equal(V.sameName('', null), true);
});

test('offerAdd: something typed and no venue of that name (case/space-insensitive)', () => {
  const venues = [{ name: 'The Basement' }, { name: 'Shoresh Hall' }];
  assert.equal(V.offerAdd('Rec Center', venues), true);
  assert.equal(V.offerAdd('the  basement ', venues), false);
  assert.equal(V.offerAdd('The Base', venues), true);   // a partial match is still a new name
  assert.equal(V.offerAdd('   ', venues), false);
  assert.equal(V.offerAdd('', venues), false);
  assert.equal(V.offerAdd('Anything', null), true);
});
