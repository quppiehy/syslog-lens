'use strict';
// Focused tests for the DB-backed, per-employeeNumber login rate limiter
// (server/lib/rateLimit.js + server/models/loginAttempt.js). Uses a very
// low max-attempts and a short lock so the test can actually observe the
// lock expiring without a fake clock. The per-IP limiter is deliberately
// configured far out of reach here (see LOGIN_IP_MAX_ATTEMPTS) so these
// tests only ever observe the per-employee limiter; see
// test/auth-rate-limit-ip.test.js for the per-IP behavior.

process.env.DB_STORAGE = ':memory:';
process.env.JWT_SECRET = 'rate-limit-test-jwt-secret-at-least-32-chars';
process.env.INVITE_CODE = '';
process.env.LOGIN_EMP_MAX_ATTEMPTS = '3';
process.env.LOGIN_EMP_WINDOW_MS = '600000';
process.env.LOGIN_EMP_LOCK_MS = '300';
process.env.LOGIN_IP_MAX_ATTEMPTS = '100000';
process.env.LOGIN_IP_WINDOW_MS = '600000';
process.env.LOGIN_IP_LOCK_MS = '600000';
process.env.REGISTER_IP_MAX_ATTEMPTS = '100000';

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
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await sequelize.close();
});

let counter = 0;
function uniqueEmployeeNumber() {
  counter += 1;
  return `RLE-${process.pid}-${counter}`;
}

async function post(path, body) {
  const res = await fetch(`${baseUrl}${path}`, {
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
  return { status: res.status, json, headers: res.headers };
}

function register(body) {
  return post('/api/auth/register', body);
}

function login(body) {
  return post('/api/auth/login', body);
}

async function registerUser() {
  const employeeNumber = uniqueEmployeeNumber();
  const password = 'correct-horse-battery';
  const res = await register({ name: 'Rate Limit Test', employeeNumber, password });
  assert.equal(res.status, 201, `setup registration failed: ${JSON.stringify(res.json)}`);
  return { employeeNumber, password };
}

test('the (maxAttempts+1)th wrong login for one employeeNumber returns 429 with Retry-After, earlier ones stay 401', async () => {
  const { employeeNumber } = await registerUser();

  for (let i = 0; i < 3; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    const res = await login({ employeeNumber, password: 'wrong-password' });
    assert.equal(res.status, 401, `attempt ${i + 1} should still be 401`);
  }

  const locked = await login({ employeeNumber, password: 'wrong-password' });
  assert.equal(locked.status, 429);
  assert.deepEqual(locked.json, { error: 'Too many attempts. Try again later.' });
  assert.ok(locked.headers.get('retry-after'), 'Retry-After header should be present');
  assert.ok(Number(locked.headers.get('retry-after')) > 0);

  // Even the *correct* password is locked out while the window holds.
  const lockedWithRightPassword = await login({ employeeNumber, password: 'correct-horse-battery' });
  assert.equal(lockedWithRightPassword.status, 429);
});

test('the lock expires after LOGIN_EMP_LOCK_MS', async () => {
  const { employeeNumber, password } = await registerUser();

  for (let i = 0; i < 3; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await login({ employeeNumber, password: 'wrong-password' });
  }
  const locked = await login({ employeeNumber, password });
  assert.equal(locked.status, 429);

  await new Promise((resolve) => setTimeout(resolve, 400)); // LOGIN_EMP_LOCK_MS=300

  const afterExpiry = await login({ employeeNumber, password });
  assert.equal(afterExpiry.status, 200, 'a correct login after the lock expires should succeed again');
});

test('a successful login resets the employee failure counter', async () => {
  const { employeeNumber, password } = await registerUser();

  // Two failures (below the max of 3), then a success.
  await login({ employeeNumber, password: 'wrong-password' });
  await login({ employeeNumber, password: 'wrong-password' });
  const success = await login({ employeeNumber, password });
  assert.equal(success.status, 200);

  // Counter should be back to zero: two more failures should NOT lock.
  const f1 = await login({ employeeNumber, password: 'wrong-password' });
  const f2 = await login({ employeeNumber, password: 'wrong-password' });
  assert.equal(f1.status, 401);
  assert.equal(f2.status, 401);
});

test('a locked-out unknown (never-registered) employee number also returns 429, not 401', async () => {
  const unknownEmployeeNumber = uniqueEmployeeNumber();

  for (let i = 0; i < 3; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    const res = await login({ employeeNumber: unknownEmployeeNumber, password: 'whatever' });
    assert.equal(res.status, 401);
  }

  const locked = await login({ employeeNumber: unknownEmployeeNumber, password: 'whatever' });
  assert.equal(locked.status, 429);
  assert.deepEqual(locked.json, { error: 'Too many attempts. Try again later.' });
});
