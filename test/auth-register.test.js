'use strict';
// Focused tests for Stage 2 registration: POST /api/auth/register.
// Uses an isolated in-memory SQLite DB (never server/data) and Node's
// built-in fetch against an ephemeral-port listener, so no extra test
// HTTP client dependency is required.

process.env.DB_STORAGE = ':memory:';
process.env.INVITE_CODE = 'test-invite-code-12345';
// This file registers many more than the default 10/hour register-per-IP
// limit (Stage A) as part of exercising unrelated validation paths — raise
// the ceiling so those assertions aren't cross-contaminated by rate limiting
// (register rate limiting itself is covered by test/register-rate-limit.test.js).
process.env.REGISTER_IP_MAX_ATTEMPTS = '1000';

const test = require('node:test');
const assert = require('node:assert/strict');

const sequelize = require('../server/db');
const app = require('../server/app');
const { verifyPassword } = require('../server/lib/password');

let server;
let baseUrl;

test.before(async () => {
  await sequelize.sync({ force: true });
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address();
  baseUrl = `http://127.0.0.1:${port}`;
});

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await sequelize.close();
});

let counter = 0;
function uniqueEmployeeNumber() {
  counter += 1;
  return `EMP-${process.pid}-${counter}`;
}

// Every test in this file registers against a real INVITE_CODE (see above),
// so the helper defaults `inviteCode` in unless the test explicitly passes
// its own (e.g. to test wrong/missing invite code behavior).
function register(body, { rawBody } = {}) {
  const withInvite = rawBody !== undefined ? body : { inviteCode: process.env.INVITE_CODE, ...body };
  return registerRaw(withInvite, { rawBody });
}

async function registerRaw(body, { rawBody } = {}) {
  const res = await fetch(`${baseUrl}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: rawBody !== undefined ? rawBody : JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: res.status, json, text };
}

test('successful registration returns 201 with exactly {id, name, employeeNumber}', async () => {
  const employeeNumber = uniqueEmployeeNumber();
  const { status, json } = await register({ name: 'Ada Lovelace', employeeNumber, password: 'correct horse battery' });

  assert.equal(status, 201);
  assert.deepEqual(Object.keys(json).sort(), ['employeeNumber', 'id', 'name']);
  assert.equal(json.name, 'Ada Lovelace');
  assert.equal(json.employeeNumber, employeeNumber);
  assert.equal(typeof json.id, 'number');
});

test('stored password hash differs from the plaintext and verifies correctly', async () => {
  const employeeNumber = uniqueEmployeeNumber();
  const password = 'super-secret-password';
  const { status, json } = await register({ name: 'Grace Hopper', employeeNumber, password });
  assert.equal(status, 201);

  const User = require('../server/models/user');
  const stored = await User.findOne({ where: { id: json.id }, attributes: ['passwordHash'] });
  assert.ok(stored, 'user should exist in DB');
  assert.notEqual(stored.passwordHash, password);
  assert.ok(verifyPassword(password, stored.passwordHash));
  assert.ok(!verifyPassword('wrong-password', stored.passwordHash));
});

test('missing name returns 400 with an error message', async () => {
  const { status, json } = await register({ employeeNumber: uniqueEmployeeNumber(), password: 'password123' });
  assert.equal(status, 400);
  assert.equal(typeof json.error, 'string');
});

test('missing employeeNumber returns 400', async () => {
  const { status, json } = await register({ name: 'Test User', password: 'password123' });
  assert.equal(status, 400);
  assert.equal(typeof json.error, 'string');
});

test('missing password returns 400', async () => {
  const { status, json } = await register({ name: 'Test User', employeeNumber: uniqueEmployeeNumber() });
  assert.equal(status, 400);
  assert.equal(typeof json.error, 'string');
});

test('empty string name returns 400', async () => {
  const { status } = await register({ name: '', employeeNumber: uniqueEmployeeNumber(), password: 'password123' });
  assert.equal(status, 400);
});

test('whitespace-only name returns 400', async () => {
  const { status } = await register({ name: '   ', employeeNumber: uniqueEmployeeNumber(), password: 'password123' });
  assert.equal(status, 400);
});

test('whitespace-only employeeNumber returns 400', async () => {
  const { status } = await register({ name: 'Test User', employeeNumber: '   ', password: 'password123' });
  assert.equal(status, 400);
});

test('empty string password returns 400', async () => {
  const { status } = await register({ name: 'Test User', employeeNumber: uniqueEmployeeNumber(), password: '' });
  assert.equal(status, 400);
});

test('7-character password returns 400 (below the 8-character minimum)', async () => {
  const { status, json } = await register({ name: 'Test User', employeeNumber: uniqueEmployeeNumber(), password: '1234567' });
  assert.equal(status, 400);
  assert.equal(typeof json.error, 'string');
});

test('8-character password is accepted (201)', async () => {
  const { status, json } = await register({ name: 'Test User', employeeNumber: uniqueEmployeeNumber(), password: '12345678' });
  assert.equal(status, 201);
  assert.equal(typeof json.id, 'number');
});

test('password length is checked on the raw, untrimmed value', async () => {
  // "  1234  " trims to "1234" (4 chars) but is 8 chars raw — it must be
  // accepted, proving length is checked before/without trimming.
  const { status } = await register({ name: 'Test User', employeeNumber: uniqueEmployeeNumber(), password: '  1234  ' });
  assert.equal(status, 201);
});

test('non-string name returns 400', async () => {
  const { status } = await register({ name: 12345, employeeNumber: uniqueEmployeeNumber(), password: 'password123' });
  assert.equal(status, 400);
});

test('non-string employeeNumber returns 400', async () => {
  const { status } = await register({ name: 'Test User', employeeNumber: 12345, password: 'password123' });
  assert.equal(status, 400);
});

test('non-string password returns 400', async () => {
  const { status } = await register({ name: 'Test User', employeeNumber: uniqueEmployeeNumber(), password: 12345 });
  assert.equal(status, 400);
});

test('name and employeeNumber are trimmed before storage', async () => {
  const rawEmployeeNumber = uniqueEmployeeNumber();
  const { status, json } = await register({
    name: '  Padded Name  ',
    employeeNumber: `  ${rawEmployeeNumber}  `,
    password: 'password123',
  });
  assert.equal(status, 201);
  assert.equal(json.name, 'Padded Name');
  assert.equal(json.employeeNumber, rawEmployeeNumber);
});

test('duplicate employeeNumber returns 409', async () => {
  const employeeNumber = uniqueEmployeeNumber();
  const first = await register({ name: 'First User', employeeNumber, password: 'password123' });
  assert.equal(first.status, 201);

  const second = await register({ name: 'Second User', employeeNumber, password: 'password456' });
  assert.equal(second.status, 409);
  assert.equal(typeof second.json.error, 'string');
});

test('duplicate that differs only by surrounding whitespace returns 409', async () => {
  const employeeNumber = uniqueEmployeeNumber();
  const first = await register({ name: 'First User', employeeNumber, password: 'password123' });
  assert.equal(first.status, 201);

  const second = await register({ name: 'Second User', employeeNumber: `  ${employeeNumber}  `, password: 'password456' });
  assert.equal(second.status, 409);
});

test('malformed JSON body returns 400 JSON, not an HTML error page', async () => {
  const res = await fetch(`${baseUrl}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{ this is not valid json',
  });
  assert.equal(res.status, 400);
  const contentType = res.headers.get('content-type') || '';
  assert.ok(contentType.includes('application/json'), `expected JSON content-type, got "${contentType}"`);
  const json = await res.json();
  assert.equal(typeof json.error, 'string');
});

test('no successful or error response ever contains passwordHash or the plaintext password', async () => {
  const employeeNumber = uniqueEmployeeNumber();
  const password = 'never-leak-me-123';

  const ok = await register({ name: 'Leak Check', employeeNumber, password });
  assert.equal(ok.status, 201);
  assert.ok(!('passwordHash' in ok.json));
  assert.ok(!ok.text.includes(password));
  assert.ok(!ok.text.toLowerCase().includes('passwordhash'));

  const dup = await register({ name: 'Leak Check 2', employeeNumber, password: 'another-password-456' });
  assert.equal(dup.status, 409);
  assert.ok(!dup.text.includes(password));
  assert.ok(!dup.text.includes('another-password-456'));
  assert.ok(!dup.text.toLowerCase().includes('passwordhash'));

  const bad = await register({ name: 'Leak Check 3', employeeNumber: uniqueEmployeeNumber(), password: '' });
  assert.equal(bad.status, 400);
  assert.ok(!bad.text.toLowerCase().includes('passwordhash'));
});
