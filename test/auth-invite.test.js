'use strict';
// Focused tests for the Stage A invite-code registration gate: POST
// /api/auth/register now also requires a matching `inviteCode` field
// whenever INVITE_CODE is configured, checked BEFORE the duplicate-
// employeeNumber check so a wrong code can't be used to probe which
// employee numbers already exist. Also covers the production startup
// check (validateInviteCodeConfig).

process.env.DB_STORAGE = ':memory:';
process.env.INVITE_CODE = 'invite-test-code-12345';
process.env.REGISTER_IP_MAX_ATTEMPTS = '1000';

const test = require('node:test');
const assert = require('node:assert/strict');

const sequelize = require('../server/db');
const app = require('../server/app');

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
  return `INV-${process.pid}-${counter}`;
}

async function register(body) {
  const res = await fetch(`${baseUrl}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: res.status, json, text };
}

test('missing inviteCode returns 403 {error:"Invalid invite code"}', async () => {
  const { status, json } = await register({
    name: 'Missing Invite',
    employeeNumber: uniqueEmployeeNumber(),
    password: 'password123',
  });
  assert.equal(status, 403);
  assert.deepEqual(json, { error: 'Invalid invite code' });
});

test('wrong inviteCode returns 403', async () => {
  const { status, json } = await register({
    name: 'Wrong Invite',
    employeeNumber: uniqueEmployeeNumber(),
    password: 'password123',
    inviteCode: 'definitely-not-the-code',
  });
  assert.equal(status, 403);
  assert.deepEqual(json, { error: 'Invalid invite code' });
});

test('correct inviteCode returns 201', async () => {
  const { status, json } = await register({
    name: 'Correct Invite',
    employeeNumber: uniqueEmployeeNumber(),
    password: 'password123',
    inviteCode: process.env.INVITE_CODE,
  });
  assert.equal(status, 201);
  assert.equal(typeof json.id, 'number');
});

test('a wrong invite code against an already-registered employeeNumber returns 403, not 409 (invite check runs first)', async () => {
  const employeeNumber = uniqueEmployeeNumber();
  const first = await register({
    name: 'First User',
    employeeNumber,
    password: 'password123',
    inviteCode: process.env.INVITE_CODE,
  });
  assert.equal(first.status, 201);

  const second = await register({
    name: 'Second User',
    employeeNumber, // same, already-registered employeeNumber
    password: 'password456',
    inviteCode: 'wrong-code',
  });
  assert.equal(second.status, 403);
  assert.deepEqual(second.json, { error: 'Invalid invite code' });
});

test('a missing invite code against an already-registered employeeNumber also returns 403, not 409', async () => {
  const employeeNumber = uniqueEmployeeNumber();
  const first = await register({
    name: 'First User',
    employeeNumber,
    password: 'password123',
    inviteCode: process.env.INVITE_CODE,
  });
  assert.equal(first.status, 201);

  const second = await register({ name: 'Second User', employeeNumber, password: 'password456' });
  assert.equal(second.status, 403);
});

test('response never leaks the configured INVITE_CODE', async () => {
  const { text } = await register({
    name: 'Leak Check',
    employeeNumber: uniqueEmployeeNumber(),
    password: 'password123',
    inviteCode: 'wrong-code',
  });
  assert.ok(!text.includes(process.env.INVITE_CODE));
});

test('registration is optional when INVITE_CODE is not configured (dev/test default)', async () => {
  // Simulate an app instance with no INVITE_CODE configured at all: reload
  // config/app fresh with the env var removed.
  const prevInvite = process.env.INVITE_CODE;
  process.env.INVITE_CODE = '';
  delete require.cache[require.resolve('../server/config')];
  delete require.cache[require.resolve('../server/routes/auth')];
  delete require.cache[require.resolve('../server/app')];
  const freshApp = require('../server/app');
  const freshServer = freshApp.listen(0);
  await new Promise((resolve) => freshServer.once('listening', resolve));
  const freshBaseUrl = `http://127.0.0.1:${freshServer.address().port}`;

  try {
    const res = await fetch(`${freshBaseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'No Invite Needed', employeeNumber: uniqueEmployeeNumber(), password: 'password123' }),
    });
    assert.equal(res.status, 201);
  } finally {
    await new Promise((resolve) => freshServer.close(resolve));
    process.env.INVITE_CODE = prevInvite;
    delete require.cache[require.resolve('../server/config')];
    delete require.cache[require.resolve('../server/routes/auth')];
    delete require.cache[require.resolve('../server/app')];
  }
});

test('validateInviteCodeConfig: production startup refuses to start without INVITE_CODE', () => {
  const prevEnv = process.env.NODE_ENV;
  const prevInvite = process.env.INVITE_CODE;
  process.env.NODE_ENV = 'production';
  process.env.INVITE_CODE = '';
  delete require.cache[require.resolve('../server/config')];
  try {
    const config = require('../server/config');
    assert.throws(() => config.validateInviteCodeConfig(), /INVITE_CODE is required/);
  } finally {
    process.env.NODE_ENV = prevEnv;
    process.env.INVITE_CODE = prevInvite;
    delete require.cache[require.resolve('../server/config')];
  }
});

test('validateInviteCodeConfig: production startup refuses an INVITE_CODE shorter than 12 characters', () => {
  const prevEnv = process.env.NODE_ENV;
  const prevInvite = process.env.INVITE_CODE;
  process.env.NODE_ENV = 'production';
  process.env.INVITE_CODE = 'short';
  delete require.cache[require.resolve('../server/config')];
  try {
    const config = require('../server/config');
    assert.throws(() => config.validateInviteCodeConfig(), /at least 12 characters/);
  } finally {
    process.env.NODE_ENV = prevEnv;
    process.env.INVITE_CODE = prevInvite;
    delete require.cache[require.resolve('../server/config')];
  }
});

test('validateInviteCodeConfig: production startup succeeds with a valid INVITE_CODE', () => {
  const prevEnv = process.env.NODE_ENV;
  const prevInvite = process.env.INVITE_CODE;
  process.env.NODE_ENV = 'production';
  process.env.INVITE_CODE = 'a-valid-invite-code-1234';
  delete require.cache[require.resolve('../server/config')];
  try {
    const config = require('../server/config');
    assert.doesNotThrow(() => config.validateInviteCodeConfig());
  } finally {
    process.env.NODE_ENV = prevEnv;
    process.env.INVITE_CODE = prevInvite;
    delete require.cache[require.resolve('../server/config')];
  }
});

test('validateInviteCodeConfig: dev/test (non-production) never throws, even with no INVITE_CODE', () => {
  const prevEnv = process.env.NODE_ENV;
  const prevInvite = process.env.INVITE_CODE;
  process.env.NODE_ENV = 'test';
  process.env.INVITE_CODE = '';
  delete require.cache[require.resolve('../server/config')];
  try {
    const config = require('../server/config');
    assert.doesNotThrow(() => config.validateInviteCodeConfig());
  } finally {
    process.env.NODE_ENV = prevEnv;
    process.env.INVITE_CODE = prevInvite;
    delete require.cache[require.resolve('../server/config')];
  }
});
