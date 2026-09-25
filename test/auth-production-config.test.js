'use strict';
// Two independent production-mode guards, covering review finding
// "[security] invite check fails open": (a) POST /api/auth/register fails
// closed (503) if it is ever reached in production without a valid
// INVITE_CODE, even if something upstream skipped the startup check; (b)
// server/config.js's assertProductionConfig() throws as soon as
// server/app.js is loaded in production with a missing/invalid
// JWT_SECRET or INVITE_CODE, so a serverless entry point that
// `require('./app')`s directly (skipping server/index.js's own
// validateJwtSecret()/validateInviteCodeConfig() calls) can't boot
// misconfigured either.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const PROJECT_ROOT = path.join(__dirname, '..');

// (b) is exercised in a fresh child process (not require-cache tricks)
// because throwing at module load is exactly the behavior under test, and
// a child process is the only way to observe that without tearing down
// unrelated module state shared with the rest of this file's own process.
function requireAppInChildProcess(envOverrides) {
  try {
    execFileSync(process.execPath, ['-e', "require('./server/app');"], {
      cwd: PROJECT_ROOT,
      env: { ...process.env, ...envOverrides },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { threw: false };
  } catch (err) {
    return { threw: true, stderr: err.stderr ? err.stderr.toString() : '' };
  }
}

test('requiring server/app in production with no JWT_SECRET throws at module load', () => {
  const result = requireAppInChildProcess({
    NODE_ENV: 'production',
    JWT_SECRET: '',
    INVITE_CODE: 'a-valid-invite-code-123',
    DB_STORAGE: ':memory:',
  });
  assert.equal(result.threw, true, 'require(app) should have thrown');
  assert.match(result.stderr, /JWT_SECRET is required/);
});

test('requiring server/app in production with a valid JWT_SECRET but no INVITE_CODE throws at module load', () => {
  const result = requireAppInChildProcess({
    NODE_ENV: 'production',
    JWT_SECRET: 'a'.repeat(32),
    INVITE_CODE: '',
    DB_STORAGE: ':memory:',
  });
  assert.equal(result.threw, true, 'require(app) should have thrown');
  assert.match(result.stderr, /INVITE_CODE is required/);
});

test('requiring server/app in production with a valid JWT_SECRET and a too-short INVITE_CODE throws at module load', () => {
  const result = requireAppInChildProcess({
    NODE_ENV: 'production',
    JWT_SECRET: 'a'.repeat(32),
    INVITE_CODE: 'short',
    DB_STORAGE: ':memory:',
  });
  assert.equal(result.threw, true, 'require(app) should have thrown');
  assert.match(result.stderr, /at least 12 characters/);
});

test('requiring server/app in production with valid JWT_SECRET and INVITE_CODE does not throw', () => {
  const result = requireAppInChildProcess({
    NODE_ENV: 'production',
    JWT_SECRET: 'a'.repeat(32),
    INVITE_CODE: 'a-valid-invite-code-123',
    DB_STORAGE: ':memory:',
  });
  assert.equal(result.threw, false, 'require(app) should not have thrown');
});

// Covers the review finding that Vercel auto-detects a project's
// .env.example and offers to pre-fill Environment Variables from it: even
// if someone imports it (or copy-pastes its old placeholder text) and the
// result happens to be long enough to pass validateJwtSecret/
// validateInviteCodeConfig's length checks, assertProductionConfig must
// still refuse to boot with known placeholder text.
test('requiring server/app in production with a placeholder-looking JWT_SECRET throws at module load', () => {
  const result = requireAppInChildProcess({
    NODE_ENV: 'production',
    JWT_SECRET: 'replace-this-with-a-generated-secret-at-least-32-characters-long',
    INVITE_CODE: 'a-valid-invite-code-123',
    DB_STORAGE: ':memory:',
  });
  assert.equal(result.threw, true, 'require(app) should have thrown');
  assert.match(result.stderr, /looks like a placeholder value/);
});

test('requiring server/app in production with a placeholder-looking INVITE_CODE throws at module load', () => {
  const result = requireAppInChildProcess({
    NODE_ENV: 'production',
    JWT_SECRET: 'a'.repeat(32),
    INVITE_CODE: 'change-me-invite-code',
    DB_STORAGE: ':memory:',
  });
  assert.equal(result.threw, true, 'require(app) should have thrown');
  assert.match(result.stderr, /looks like a placeholder value/);
});

test('findPlaceholderPattern detects known placeholder substrings case-insensitively and ignores real values', () => {
  const { findPlaceholderPattern } = require('../server/config');
  assert.equal(findPlaceholderPattern('replace-this-with-a-secret'), 'replace-this');
  assert.equal(findPlaceholderPattern('Please CHANGE-ME before deploying'), 'change-me');
  assert.equal(findPlaceholderPattern('a'.repeat(32)), null);
  assert.equal(findPlaceholderPattern(''), null);
  assert.equal(findPlaceholderPattern(undefined), null);
});

// (a): the register handler's own fail-closed check, exercised directly
// against server/routes/auth.js mounted on a minimal express app rather
// than server/app.js — this deliberately bypasses assertProductionConfig()
// (which would otherwise refuse to even build the app in this scenario),
// so it isolates and proves out the *second*, independent guard living in
// the route handler itself.
test('production register fails closed (503) when INVITE_CODE is missing, and creates no user', async () => {
  process.env.NODE_ENV = 'production';
  process.env.JWT_SECRET = 'auth-prod-guard-test-jwt-secret-32ch';
  process.env.INVITE_CODE = '';
  process.env.DB_STORAGE = ':memory:';
  process.env.REGISTER_IP_MAX_ATTEMPTS = '1000';

  for (const mod of ['../server/config', '../server/db', '../server/models/user', '../server/models/loginAttempt', '../server/routes/auth']) {
    delete require.cache[require.resolve(mod)];
  }

  const express = require('express');
  const cookieParser = require('cookie-parser');
  const sequelize = require('../server/db');
  const User = require('../server/models/user');
  require('../server/models/loginAttempt');
  const authRouter = require('../server/routes/auth');

  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/auth', authRouter);

  await sequelize.sync({ force: true });
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  try {
    const res = await fetch(`${baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Prod Guard', employeeNumber: 'PGUARD-1', password: 'password123' }),
    });
    assert.equal(res.status, 503);
    const json = await res.json();
    assert.deepEqual(json, { error: 'Registration is not configured' });

    const count = await User.count();
    assert.equal(count, 0, 'no user should have been created');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await sequelize.close();
  }
});
