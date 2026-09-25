'use strict';
// Focused test for the DB-backed per-IP login rate limiter. All requests in
// this test come from the same loopback address, so LOGIN_IP_MAX_ATTEMPTS
// is set low while LOGIN_EMP_MAX_ATTEMPTS is set far out of reach — each
// failed login here uses a distinct, never-before-seen employeeNumber, so
// only the per-IP counter can possibly be the one that locks.

process.env.DB_STORAGE = ':memory:';
process.env.JWT_SECRET = 'rate-limit-ip-test-jwt-secret-at-least-32-chars';
process.env.INVITE_CODE = '';
process.env.LOGIN_IP_MAX_ATTEMPTS = '4';
process.env.LOGIN_IP_WINDOW_MS = '600000';
process.env.LOGIN_IP_LOCK_MS = '600000';
process.env.LOGIN_EMP_MAX_ATTEMPTS = '100000';
process.env.LOGIN_EMP_WINDOW_MS = '600000';
process.env.LOGIN_EMP_LOCK_MS = '600000';
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
  return `RLI-${process.pid}-${counter}`;
}

async function login(body) {
  const res = await fetch(`${baseUrl}/api/auth/login`, {
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

test('a shared per-IP limit locks out even brand-new, never-before-seen employee numbers', async () => {
  for (let i = 0; i < 4; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    const res = await login({ employeeNumber: uniqueEmployeeNumber(), password: 'whatever' });
    assert.equal(res.status, 401, `attempt ${i + 1} (a fresh employeeNumber, well under its own limit) should be 401`);
  }

  const locked = await login({ employeeNumber: uniqueEmployeeNumber(), password: 'whatever' });
  assert.equal(locked.status, 429);
  assert.deepEqual(locked.json, { error: 'Too many attempts. Try again later.' });
  assert.ok(Number(locked.headers.get('retry-after')) > 0);
});
