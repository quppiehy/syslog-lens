'use strict';
// Tests for JWT issuance on login, the requireAuth middleware, and the
// protected GET /api/auth/me endpoint.
// Uses an isolated in-memory SQLite DB (never server/data) and Node's
// built-in fetch against an ephemeral-port listener, matching the style of
// test/auth-login.test.js.

process.env.DB_STORAGE = ':memory:';
process.env.JWT_SECRET = 'test-jwt-secret-at-least-32-characters-long';
process.env.JWT_EXPIRES_IN = '8h';
process.env.INVITE_CODE = '';

const test = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');

const sequelize = require('../server/db');
const app = require('../server/app');
const { validateJwtSecret, MIN_JWT_SECRET_LENGTH } = require('../server/config');

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

async function request(path, { method = 'GET', body, headers = {}, rawBody } = {}) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: rawBody !== undefined ? rawBody : body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: res.status, json, text, headers: res.headers };
}

function register(body) {
  return request('/api/auth/register', { method: 'POST', body });
}

function login(body) {
  return request('/api/auth/login', { method: 'POST', body });
}

function me(token) {
  const headers = {};
  if (token !== undefined) {
    headers.Authorization = token;
  }
  return request('/api/auth/me', { headers });
}

async function registerAndLogin({ name = 'Test User', password = 'correct horse battery' } = {}) {
  const employeeNumber = uniqueEmployeeNumber();
  const regRes = await register({ name, employeeNumber, password });
  assert.equal(regRes.status, 201, `setup registration failed: ${regRes.text}`);

  const loginRes = await login({ employeeNumber, password });
  assert.equal(loginRes.status, 200, `setup login failed: ${loginRes.text}`);

  return { employeeNumber, password, name, id: regRes.json.id, token: loginRes.json.token };
}

test('login returns a token that verifies with the right claims and expiry', async () => {
  const before = Math.floor(Date.now() / 1000);
  const { employeeNumber, name, id, token } = await registerAndLogin();
  const after = Math.floor(Date.now() / 1000);

  const decoded = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'] });

  assert.equal(decoded.sub, String(id));
  assert.equal(decoded.employeeNumber, employeeNumber);
  assert.equal(decoded.name, name);
  assert.equal(typeof decoded.iat, 'number');
  assert.equal(typeof decoded.exp, 'number');

  // 8h expiry, allowing a little slack for test execution time.
  const expectedExp = before + 8 * 60 * 60;
  assert.ok(decoded.exp >= expectedExp - 5 && decoded.exp <= expectedExp + (after - before) + 5);
});

test('GET /api/auth/me with a valid token returns 200 and exactly {id, name, employeeNumber}', async () => {
  const { employeeNumber, name, id, token } = await registerAndLogin();

  const { status, json } = await me(`Bearer ${token}`);

  assert.equal(status, 200);
  assert.deepEqual(Object.keys(json).sort(), ['employeeNumber', 'id', 'name']);
  assert.equal(json.id, id);
  assert.equal(json.name, name);
  assert.equal(json.employeeNumber, employeeNumber);
});

test('GET /api/auth/me with no Authorization header returns 401 with WWW-Authenticate: Bearer', async () => {
  const { status, json, headers } = await me();
  assert.equal(status, 401);
  assert.equal(typeof json.error, 'string');
  assert.equal(headers.get('www-authenticate'), 'Bearer');
});

test('GET /api/auth/me with wrong auth scheme returns 401', async () => {
  const { token } = await registerAndLogin();
  const { status } = await me(`Basic ${token}`);
  assert.equal(status, 401);
});

test('GET /api/auth/me with garbage token returns 401', async () => {
  const { status } = await me('Bearer not-a-real-token');
  assert.equal(status, 401);
});

test('GET /api/auth/me with a token signed by the wrong secret returns 401', async () => {
  const { id, employeeNumber, name } = await registerAndLogin();
  const forged = jwt.sign(
    { sub: String(id), employeeNumber, name },
    'a-completely-different-secret-that-is-also-long-enough',
    { algorithm: 'HS256', expiresIn: '8h' }
  );
  const { status } = await me(`Bearer ${forged}`);
  assert.equal(status, 401);
});

test('GET /api/auth/me with an expired token returns 401', async () => {
  const { id, employeeNumber, name } = await registerAndLogin();
  const expired = jwt.sign(
    { sub: String(id), employeeNumber, name },
    process.env.JWT_SECRET,
    { algorithm: 'HS256', expiresIn: -10 }
  );
  const { status } = await me(`Bearer ${expired}`);
  assert.equal(status, 401);
});

test('GET /api/auth/me with an alg:none token returns 401', async () => {
  const { id, employeeNumber, name } = await registerAndLogin();

  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(
    JSON.stringify({ sub: String(id), employeeNumber, name, exp: Math.floor(Date.now() / 1000) + 3600 })
  ).toString('base64url');
  const algNoneToken = `${header}.${payload}.`;

  const { status } = await me(`Bearer ${algNoneToken}`);
  assert.equal(status, 401);
});

test('GET /api/auth/me with a token for a deleted user returns 401', async () => {
  const User = require('../server/models/user');
  const { id, token } = await registerAndLogin();

  const deleted = await User.destroy({ where: { id } });
  assert.equal(deleted, 1);

  const { status } = await me(`Bearer ${token}`);
  assert.equal(status, 401);
});

test('no response (login or /me) ever contains passwordHash', async () => {
  const { token } = await registerAndLogin();

  const loginRes = await login({ employeeNumber: uniqueEmployeeNumber(), password: 'irrelevant' });
  assert.ok(!loginRes.text.toLowerCase().includes('passwordhash'));

  const meRes = await me(`Bearer ${token}`);
  assert.ok(!meRes.text.toLowerCase().includes('passwordhash'));
});

test('config validation rejects a missing JWT secret', () => {
  assert.throws(() => validateJwtSecret(undefined), /required/i);
  assert.throws(() => validateJwtSecret(''), /required/i);
});

test('config validation rejects a JWT secret shorter than the minimum length', () => {
  const shortSecret = 'a'.repeat(MIN_JWT_SECRET_LENGTH - 1);
  assert.throws(() => validateJwtSecret(shortSecret), /at least/i);
});

test('config validation accepts a JWT secret at least the minimum length', () => {
  const okSecret = 'a'.repeat(MIN_JWT_SECRET_LENGTH);
  assert.doesNotThrow(() => validateJwtSecret(okSecret));
});
