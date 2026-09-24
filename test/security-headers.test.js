'use strict';
// Verifies the helmet-based security headers (HSTS, frameguard, noSniff,
// referrer-policy, CSP) added in Stage A land on real responses, including
// redirects (an unauthenticated GET / still gets the same middleware
// stack). HSTS is asserted twice: absent by default, present when
// COOKIE_SECURE=true.

process.env.DB_STORAGE = ':memory:';
process.env.JWT_SECRET = 'headers-test-jwt-secret-at-least-32-characters';
process.env.INVITE_CODE = '';

const test = require('node:test');
const assert = require('node:assert/strict');

const sequelize = require('../server/db');

let server;
let baseUrl;

test.before(async () => {
  const app = require('../server/app');
  await sequelize.sync({ force: true });
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await sequelize.close();
});

test('GET / (redirected, unauthenticated) carries the security headers', async () => {
  const res = await fetch(`${baseUrl}/`, { redirect: 'manual' });
  assert.equal(res.status, 302);
  assertCommonHeaders(res);
});

test('GET /login carries the security headers, including a CSP with no unsafe-inline for scripts', async () => {
  const res = await fetch(`${baseUrl}/login`);
  assert.equal(res.status, 200);
  assertCommonHeaders(res);

  const csp = res.headers.get('content-security-policy');
  assert.ok(csp, 'CSP header should be present');
  assert.match(csp, /script-src[^;]*'self'/);
  assert.doesNotMatch(csp, /script-src[^;]*'unsafe-inline'/);
  assert.match(csp, /script-src[^;]*'sha256-/, 'script-src should allow the inline script via a sha256 hash');
  assert.match(csp, /style-src[^;]*'unsafe-inline'/);
  assert.match(csp, /style-src[^;]*fonts\.googleapis\.com/);
  assert.match(csp, /font-src[^;]*fonts\.gstatic\.com/);
  assert.match(csp, /connect-src[^;]*'self'/);
  assert.match(csp, /img-src[^;]*data:/);
  assert.match(csp, /img-src[^;]*blob:/);
  assert.match(csp, /object-src[^;]*'none'/);
  assert.match(csp, /base-uri[^;]*'none'/);
  assert.match(csp, /form-action[^;]*'self'/);
  assert.match(csp, /frame-ancestors[^;]*'none'/);
});

test('HSTS is absent when COOKIE_SECURE is not true (the default, e.g. plain http://localhost)', async () => {
  const res = await fetch(`${baseUrl}/login`);
  assert.equal(res.headers.get('strict-transport-security'), null);
});

function assertCommonHeaders(res) {
  assert.equal(res.headers.get('x-frame-options'), 'DENY');
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
  assert.ok(res.headers.get('content-security-policy'), 'CSP header should be present');
}

test('HSTS is present once COOKIE_SECURE=true', async () => {
  process.env.COOKIE_SECURE = 'true';
  delete require.cache[require.resolve('../server/config')];
  delete require.cache[require.resolve('../server/routes/auth')];
  delete require.cache[require.resolve('../server/app')];
  const secureApp = require('../server/app');
  const secureServer = secureApp.listen(0);
  await new Promise((resolve) => secureServer.once('listening', resolve));
  const secureBaseUrl = `http://127.0.0.1:${secureServer.address().port}`;

  try {
    const res = await fetch(`${secureBaseUrl}/login`);
    const hsts = res.headers.get('strict-transport-security');
    assert.ok(hsts, 'HSTS header should be present when COOKIE_SECURE=true');
    assert.match(hsts, /max-age=\d+/);
  } finally {
    await new Promise((resolve) => secureServer.close(resolve));
    delete process.env.COOKIE_SECURE;
    delete require.cache[require.resolve('../server/config')];
    delete require.cache[require.resolve('../server/routes/auth')];
    delete require.cache[require.resolve('../server/app')];
  }
});
