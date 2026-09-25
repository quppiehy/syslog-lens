'use strict';
// Runs scripts/smoke.js's actual check suite against a real, locally
// started instance of the app (on a random port), so the smoke script
// itself is covered by `npm test` and not just exercised manually against
// a deployed URL. COOKIE_SECURE is left unset (false) here, as it would be
// for a plain-http local run, so the HSTS check is skipped — see README.

process.env.DB_STORAGE = ':memory:';
process.env.JWT_SECRET = 'smoke-script-test-jwt-secret-at-least-32-chars';
process.env.INVITE_CODE = '';
process.env.COOKIE_SECURE = 'false';

const test = require('node:test');
const assert = require('node:assert/strict');

const sequelize = require('../server/db');
const app = require('../server/app');
const { runSmoke } = require('../scripts/smoke');

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

test('smoke script passes every check against a local, plain-http instance (HSTS skipped)', async () => {
  const { results, ok } = await runSmoke(baseUrl, { expectHsts: false });
  const failures = results.filter((r) => !r.ok);
  assert.equal(ok, true, `expected all smoke checks to pass, failures: ${JSON.stringify(failures, null, 2)}`);
  assert.ok(results.length >= 13, `expected at least 13 checks to have run, got ${results.length}`);
});

test('smoke script checks the public/** static assets (login.html, register.html, auth.js, auth.css) for security headers', async () => {
  const { results, ok } = await runSmoke(baseUrl, { expectHsts: false });
  assert.equal(ok, true);
  for (const p of ['/login.html', '/register.html', '/auth.js', '/auth.css']) {
    const staticCheck = results.find((r) => r.name.startsWith(`GET ${p} `));
    assert.ok(staticCheck, `expected a check for ${p}`);
    assert.equal(staticCheck.ok, true, `expected ${p} check to pass: ${staticCheck.detail}`);
    // Locally these files are served through Express's static middleware,
    // which sits behind helmet, so they must come back 200 with headers
    // (not 404) — this is what would catch a CDN bypassing Express.
    assert.equal(staticCheck.detail, '200 with security headers', `expected ${p} to be served with headers locally, got: ${staticCheck.detail}`);
  }
});

test('smoke script fails the HSTS assertion for /login when expectHsts is true but COOKIE_SECURE is off', async () => {
  const { results, ok } = await runSmoke(baseUrl, { expectHsts: true });
  assert.equal(ok, false, 'expected at least one check to fail without COOKIE_SECURE=true');
  const loginCheck = results.find((r) => r.name.startsWith('GET /login '));
  assert.equal(loginCheck.ok, false);
  assert.match(loginCheck.detail, /Strict-Transport-Security/);
});
