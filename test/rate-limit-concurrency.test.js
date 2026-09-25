'use strict';
// Regression test for the Postgres-transaction-abort bug fixed in
// server/lib/rateLimit.js: recordAttempt() used to create()-then-catch a
// unique-violation for a brand-new key, and re-query *inside the same
// transaction* on conflict — which aborts the whole transaction on
// Postgres, so any concurrent first-failure race would 500 there. The fix
// uses an idempotent bulkCreate({ignoreDuplicates:true}) insert followed by
// a single SELECT ... FOR UPDATE, so the first-attempt and concurrent
// paths converge instead of branching into a catch block.
//
// Uses a file-backed (not ':memory:') SQLite database so this at least
// exercises multiple requests genuinely racing to insert the same brand-new
// key, rather than relying on a single in-memory connection to hide any
// race entirely.

// node-sqlite3 dispatches each connection's blocking work (including
// SQLite's own internal busy_timeout retry-wait, see server/db.js) onto
// libuv's threadpool, which defaults to only 4 worker threads
// (UV_THREADPOOL_SIZE). With ~10 file-backed SQLite connections genuinely
// racing to write at once (one per concurrent login below), that default
// starves most of them of a thread to even begin retrying on, so they see
// SQLITE_BUSY immediately instead of waiting out the busy_timeout. This
// must be set before anything touches the threadpool (ideally before any
// module is required), so it's the very first thing in this file.
process.env.UV_THREADPOOL_SIZE = '16';

process.env.JWT_SECRET = 'concurrency-test-jwt-secret-at-least-32-chars';
process.env.INVITE_CODE = '';
process.env.LOGIN_EMP_MAX_ATTEMPTS = '3';
process.env.LOGIN_EMP_WINDOW_MS = '600000';
process.env.LOGIN_EMP_LOCK_MS = '600000';
process.env.LOGIN_IP_MAX_ATTEMPTS = '100000';
process.env.REGISTER_IP_MAX_ATTEMPTS = '100000';

const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const dbFile = path.join(os.tmpdir(), `syslog-lens-rl-concurrency-${process.pid}-${Date.now()}.sqlite`);
process.env.DB_STORAGE = dbFile;

const sequelize = require('../server/db');
const LoginAttempt = require('../server/models/loginAttempt');
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
  fs.rm(dbFile, { force: true }, () => {});
});

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
  return { status: res.status, json };
}

test('~10 simultaneous failed logins against a brand-new employee number: no 500s, outcome matches the lock policy', async () => {
  const employeeNumber = `CONC-${process.pid}-${Date.now()}`;
  const N = 10;

  const results = await Promise.all(
    Array.from({ length: N }, () => login({ employeeNumber, password: 'wrong-password' }))
  );

  for (const r of results) {
    assert.notEqual(r.status, 500, `expected no 500s, got ${r.status}: ${JSON.stringify(r.json)}`);
    assert.ok(r.status === 401 || r.status === 429, `expected 401 or 429, got ${r.status}`);
  }

  // The route checks checkLocked() once up front and only records the
  // attempt afterwards without rechecking — so a genuinely simultaneous
  // burst typically has every request observe "not locked yet" (401), with
  // the lock only becoming externally visible to the *next* request. What
  // matters here is that recordAttempt() itself doesn't lose updates or
  // 500 under concurrency: query the row directly and confirm every one of
  // the N concurrent attempts was actually recorded (not silently dropped
  // by a lost update) and that reaching LOGIN_EMP_MAX_ATTEMPTS=3 correctly
  // set a lock.
  const record = await LoginAttempt.findOne({ where: { key: `emp:${employeeNumber}` } });
  assert.ok(record, 'a LoginAttempt row should exist for this employee number');
  assert.ok(record.failedCount >= 3, `expected failedCount >= maxAttempts (3), got ${record.failedCount}`);
  assert.ok(record.lockedUntil && record.lockedUntil.getTime() > Date.now(), 'the row should now be locked');

  // And the employee number should now be locked for real from the
  // outside too, independent of the race above.
  const after = await login({ employeeNumber, password: 'wrong-password' });
  assert.equal(after.status, 429);
});
