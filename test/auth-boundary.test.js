'use strict';
// Server-side enforcement of Stage 5: syslog-lens.html (and /) must never
// be sent to an unauthenticated visitor, public/protected route boundaries
// must hold, and no file outside public/ may be reachable.
//
// Uses an isolated in-memory SQLite DB (never server/data) and Node's
// built-in fetch against an ephemeral-port listener, matching the style of
// the other test/auth-*.test.js files in this project (no supertest
// dependency is installed here).

process.env.DB_STORAGE = ':memory:';
process.env.JWT_SECRET = 'test-jwt-secret-at-least-32-characters-long';
process.env.JWT_EXPIRES_IN = '8h';
process.env.COOKIE_SECURE = 'false';
// Explicitly unset (rather than relying on it being absent) so a developer's
// local .env INVITE_CODE can never leak into this suite via dotenv.
process.env.INVITE_CODE = '';

const test = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');

const sequelize = require('../server/db');
const app = require('../server/app');
const { COOKIE_NAME } = require('../server/config');

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

// Extracts "name=value" from a Set-Cookie header's first attribute pair.
function cookiePair(setCookieHeader) {
  return setCookieHeader.split(';')[0];
}

async function rawFetch(path, opts = {}) {
  return fetch(`${baseUrl}${path}`, { redirect: 'manual', ...opts });
}

async function apiPost(path, body, headers = {}) {
  const res = await rawFetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { res, status: res.status, json, text };
}

async function registerAndLogin() {
  const employeeNumber = uniqueEmployeeNumber();
  const name = 'Boundary Test User';
  const password = 'correct horse battery';

  const regRes = await apiPost('/api/auth/register', { name, employeeNumber, password });
  assert.equal(regRes.status, 201, `setup registration failed: ${regRes.text}`);

  const loginRes = await apiPost('/api/auth/login', { employeeNumber, password });
  assert.equal(loginRes.status, 200, `setup login failed: ${loginRes.text}`);

  const setCookie = loginRes.res.headers.getSetCookie
    ? loginRes.res.headers.getSetCookie().find((c) => c.startsWith(`${COOKIE_NAME}=`))
    : loginRes.res.headers.get('set-cookie');
  assert.ok(setCookie, 'login must set the auth cookie');

  return {
    employeeNumber,
    password,
    name,
    id: regRes.json.id,
    token: loginRes.json.token,
    cookie: cookiePair(setCookie),
    setCookieHeader: setCookie,
  };
}

// --- Logged out ---------------------------------------------------------

test('logged out: GET / redirects 302 to /login and the body is not the app', async () => {
  const res = await rawFetch('/');
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), '/login');
  const text = await res.text();
  assert.ok(!text.includes('Syslog Lens'), 'redirect body must not contain the app HTML');
  assert.ok(!text.includes('window.SyslogLens'));
});

test('logged out: GET /syslog-lens.html redirects 302 to /login and the body is not the app', async () => {
  const res = await rawFetch('/syslog-lens.html');
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), '/login');
  const text = await res.text();
  assert.ok(!text.includes('window.SyslogLens'));
});

test('logged out: paths outside public/ return 404 with no content, not the source file', async () => {
  for (const path of ['/server/app.js', '/.env', '/package.json', '/server/data/syslog-lens.sqlite', '/server/config.js']) {
    const res = await rawFetch(path);
    assert.equal(res.status, 404, `${path} should 404`);
    const text = await res.text();
    assert.equal(text, '', `${path} must not leak any content`);
  }
});

test('logged out: GET /login and /register return 200', async () => {
  const loginRes = await rawFetch('/login');
  assert.equal(loginRes.status, 200);
  const loginText = await loginRes.text();
  assert.ok(loginText.includes('Sign in'));

  const registerRes = await rawFetch('/register');
  assert.equal(registerRes.status, 200);
  const registerText = await registerRes.text();
  assert.ok(registerText.includes('Create an account') || registerText.toLowerCase().includes('register'));
});

test('register then login sets an httpOnly, SameSite=Strict auth cookie', async () => {
  const { cookie, setCookieHeader } = await registerAndLogin();
  assert.ok(cookie.startsWith(`${COOKIE_NAME}=`));
  assert.match(setCookieHeader, /HttpOnly/i);
  assert.match(setCookieHeader, /SameSite=Strict/i);
  assert.match(setCookieHeader, /Path=\//i);
});

// --- Logged in -----------------------------------------------------------

test('with the auth cookie: GET / returns 200 with the app HTML and no-store headers', async () => {
  const { cookie } = await registerAndLogin();
  const res = await rawFetch('/', { headers: { Cookie: cookie } });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.equal(res.headers.get('pragma'), 'no-cache');
  const text = await res.text();
  assert.ok(text.includes('window.SyslogLens'));
});

test('with the auth cookie: GET /syslog-lens.html returns 200 with the app HTML', async () => {
  const { cookie } = await registerAndLogin();
  const res = await rawFetch('/syslog-lens.html', { headers: { Cookie: cookie } });
  assert.equal(res.status, 200);
  const text = await res.text();
  assert.ok(text.includes('window.SyslogLens'));
});

test('GET /api/auth/me works with the cookie', async () => {
  const { cookie, employeeNumber, name } = await registerAndLogin();
  const res = await rawFetch('/api/auth/me', { headers: { Cookie: cookie } });
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.equal(json.employeeNumber, employeeNumber);
  assert.equal(json.name, name);
});

test('GET /api/auth/me works with a Bearer header (API clients still work)', async () => {
  const { token, employeeNumber } = await registerAndLogin();
  const res = await rawFetch('/api/auth/me', { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.equal(json.employeeNumber, employeeNumber);
});

test('logged in: GET /login redirects 302 to /', async () => {
  const { cookie } = await registerAndLogin();
  const res = await rawFetch('/login', { headers: { Cookie: cookie } });
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), '/');
});

// --- Bad/forged tokens -----------------------------------------------------

test('expired cookie: page routes redirect 302 to /login, /api returns 401', async () => {
  const { id, employeeNumber, name } = await registerAndLogin();
  const expired = jwt.sign(
    { sub: String(id), employeeNumber, name },
    process.env.JWT_SECRET,
    { algorithm: 'HS256', expiresIn: -10 }
  );
  const cookie = `${COOKIE_NAME}=${expired}`;

  const pageRes = await rawFetch('/', { headers: { Cookie: cookie } });
  assert.equal(pageRes.status, 302);
  assert.equal(pageRes.headers.get('location'), '/login');

  const apiRes = await rawFetch('/api/auth/me', { headers: { Cookie: cookie } });
  assert.equal(apiRes.status, 401);
});

test('forged cookie (wrong secret): page routes redirect 302 to /login, /api returns 401', async () => {
  const { id, employeeNumber, name } = await registerAndLogin();
  const forged = jwt.sign(
    { sub: String(id), employeeNumber, name },
    'a-completely-different-secret-that-is-also-long-enough',
    { algorithm: 'HS256', expiresIn: '8h' }
  );
  const cookie = `${COOKIE_NAME}=${forged}`;

  const pageRes = await rawFetch('/', { headers: { Cookie: cookie } });
  assert.equal(pageRes.status, 302);
  assert.equal(pageRes.headers.get('location'), '/login');

  const apiRes = await rawFetch('/api/auth/me', { headers: { Cookie: cookie } });
  assert.equal(apiRes.status, 401);
});

test('alg:none cookie: page routes redirect 302 to /login, /api returns 401', async () => {
  const { id, employeeNumber, name } = await registerAndLogin();
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(
    JSON.stringify({ sub: String(id), employeeNumber, name, exp: Math.floor(Date.now() / 1000) + 3600 })
  ).toString('base64url');
  const algNoneToken = `${header}.${payload}.`;
  const cookie = `${COOKIE_NAME}=${algNoneToken}`;

  const pageRes = await rawFetch('/', { headers: { Cookie: cookie } });
  assert.equal(pageRes.status, 302);
  assert.equal(pageRes.headers.get('location'), '/login');

  const apiRes = await rawFetch('/api/auth/me', { headers: { Cookie: cookie } });
  assert.equal(apiRes.status, 401);
});

test('garbage cookie: page routes redirect 302 to /login, /api returns 401', async () => {
  const cookie = `${COOKIE_NAME}=not-a-real-token`;

  const pageRes = await rawFetch('/', { headers: { Cookie: cookie } });
  assert.equal(pageRes.status, 302);
  assert.equal(pageRes.headers.get('location'), '/login');

  const apiRes = await rawFetch('/api/auth/me', { headers: { Cookie: cookie } });
  assert.equal(apiRes.status, 401);
});

// --- Logout ----------------------------------------------------------------

test('logout clears the cookie, after which / redirects to /login again', async () => {
  const { cookie } = await registerAndLogin();

  // Confirm we're actually in before logging out.
  const before = await rawFetch('/', { headers: { Cookie: cookie } });
  assert.equal(before.status, 200);

  const logoutRes = await rawFetch('/api/auth/logout', { method: 'POST', headers: { Cookie: cookie } });
  assert.equal(logoutRes.status, 204);
  const clearedSetCookie = logoutRes.headers.getSetCookie
    ? logoutRes.headers.getSetCookie().find((c) => c.startsWith(`${COOKIE_NAME}=`))
    : logoutRes.headers.get('set-cookie');
  assert.ok(clearedSetCookie, 'logout must clear the cookie via Set-Cookie');

  // A real browser would stop sending the cookie once Set-Cookie clears it;
  // fetch() here has no cookie jar, so simulate that by not resending it.
  const after = await rawFetch('/');
  assert.equal(after.status, 302);
  assert.equal(after.headers.get('location'), '/login');
});

test('logout is idempotent: calling it twice (or with no session) still returns 204', async () => {
  const res1 = await rawFetch('/api/auth/logout', { method: 'POST' });
  assert.equal(res1.status, 204);
  const res2 = await rawFetch('/api/auth/logout', { method: 'POST' });
  assert.equal(res2.status, 204);
});
