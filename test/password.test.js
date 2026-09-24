'use strict';
// Unit tests for server/lib/password.js's async verify helper.

const test = require('node:test');
const assert = require('node:assert/strict');

const { hashPassword, verifyPasswordAsync } = require('../server/lib/password');

test('verifyPasswordAsync resolves true for the correct password', async () => {
  const stored = await hashPassword('correct horse battery staple');
  assert.equal(await verifyPasswordAsync('correct horse battery staple', stored), true);
});

test('verifyPasswordAsync resolves false for the wrong password', async () => {
  const stored = await hashPassword('correct horse battery staple');
  assert.equal(await verifyPasswordAsync('wrong password', stored), false);
});

test('verifyPasswordAsync resolves false for a malformed stored hash', async () => {
  assert.equal(await verifyPasswordAsync('anything', 'not-a-real-hash'), false);
  assert.equal(await verifyPasswordAsync('anything', 'scrypt:16384:onlythreeparts'), false);
  assert.equal(await verifyPasswordAsync('anything', 'bcrypt:16384:deadbeef:deadbeef'), false);
  assert.equal(await verifyPasswordAsync('anything', null), false);
  assert.equal(await verifyPasswordAsync('anything', undefined), false);
});
