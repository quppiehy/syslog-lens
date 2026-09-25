'use strict';
// Focused test for the DB-backed per-IP registration rate limiter.
// REGISTER_IP_MAX_ATTEMPTS is set low so the test can exceed it quickly;
// every call here (success or not) counts as one "attempt" against the
// same source IP.

process.env.DB_STORAGE = ':memory:';
process.env.INVITE_CODE = '';
process.env.REGISTER_IP_MAX_ATTEMPTS = '3';
process.env.REGISTER_IP_WINDOW_MS = '600000';
process.env.REGISTER_IP_LOCK_MS = '600000';

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
  return `REG-${process.pid}-${counter}`;
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
  return { status: res.status, json, headers: res.headers };
}

test('register is rate-limited per IP: the (maxAttempts+1)th attempt returns 429 with Retry-After', async () => {
  for (let i = 0; i < 3; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    const res = await register({ name: 'Reg Limit', employeeNumber: uniqueEmployeeNumber(), password: 'password123' });
    assert.equal(res.status, 201, `attempt ${i + 1} should still succeed`);
  }

  const locked = await register({ name: 'Reg Limit', employeeNumber: uniqueEmployeeNumber(), password: 'password123' });
  assert.equal(locked.status, 429);
  assert.deepEqual(locked.json, { error: 'Too many attempts. Try again later.' });
  assert.ok(Number(locked.headers.get('retry-after')) > 0);
});
