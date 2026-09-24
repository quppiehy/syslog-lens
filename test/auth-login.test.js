'use strict';
// Focused tests for POST /api/auth/login.
// Uses an isolated in-memory SQLite DB (never server/data) and Node's
// built-in fetch against an ephemeral-port listener, matching the style of
// test/auth-register.test.js.

process.env.DB_STORAGE = ':memory:';
process.env.JWT_SECRET = 'test-jwt-secret-at-least-32-characters-long';
process.env.JWT_EXPIRES_IN = '8h';
process.env.INVITE_CODE = '';
process.env.REGISTER_IP_MAX_ATTEMPTS = '1000'; // many registerUser() setup calls in this file

const test = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');

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
  return `EMP-${process.pid}-${counter}`;
}

async function request(path, body, { rawBody } = {}) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: rawBody !== undefined ? rawBody : JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: res.status, json, text };
}

function register(body, opts) {
  return request('/api/auth/register', body, opts);
}

function login(body, opts) {
  return request('/api/auth/login', body, opts);
}

async function registerUser({ name = 'Test User', password = 'correct horse battery' } = {}) {
  const employeeNumber = uniqueEmployeeNumber();
  const res = await register({ name, employeeNumber, password });
  assert.equal(res.status, 201, `setup registration failed: ${res.text}`);
  return { employeeNumber, password, name, id: res.json.id };
}

test('successful login returns 200 with {token, user: {id, name, employeeNumber}}', async () => {
  const { employeeNumber, password, name, id } = await registerUser();

  const { status, json } = await login({ employeeNumber, password });

  assert.equal(status, 200);
  assert.deepEqual(Object.keys(json).sort(), ['token', 'user']);
  assert.equal(typeof json.token, 'string');
  assert.deepEqual(Object.keys(json.user).sort(), ['employeeNumber', 'id', 'name']);
  assert.equal(json.user.id, id);
  assert.equal(json.user.name, name);
  assert.equal(json.user.employeeNumber, employeeNumber);
  assert.ok(!('passwordHash' in json));
  assert.ok(!('password' in json));

  const decoded = jwt.verify(json.token, process.env.JWT_SECRET, { algorithms: ['HS256'] });
  assert.equal(decoded.sub, String(id));
  assert.equal(decoded.employeeNumber, employeeNumber);
  assert.equal(decoded.name, name);
});

test('wrong password returns 401', async () => {
  const { employeeNumber } = await registerUser({ password: 'the-real-password' });

  const { status, json } = await login({ employeeNumber, password: 'not-the-real-password' });
  assert.equal(status, 401);
  assert.equal(typeof json.error, 'string');
});

test('unknown employee number returns 401 with a body identical to the wrong-password case', async () => {
  const { employeeNumber } = await registerUser({ password: 'the-real-password' });

  const wrongPassword = await login({ employeeNumber, password: 'not-the-real-password' });
  assert.equal(wrongPassword.status, 401);

  const unknownEmployee = await login({ employeeNumber: uniqueEmployeeNumber(), password: 'whatever-password' });
  assert.equal(unknownEmployee.status, 401);

  assert.deepEqual(unknownEmployee.json, wrongPassword.json);
});

test('employeeNumber with surrounding whitespace still logs in', async () => {
  const { employeeNumber, password } = await registerUser();

  const { status, json } = await login({ employeeNumber: `  ${employeeNumber}  `, password });
  assert.equal(status, 200);
  assert.equal(json.user.employeeNumber, employeeNumber);
});

test('missing employeeNumber returns 400', async () => {
  const { status, json } = await login({ password: 'password123' });
  assert.equal(status, 400);
  assert.equal(typeof json.error, 'string');
});

test('missing password returns 400', async () => {
  const { status, json } = await login({ employeeNumber: uniqueEmployeeNumber() });
  assert.equal(status, 400);
  assert.equal(typeof json.error, 'string');
});

test('empty string employeeNumber returns 400', async () => {
  const { status } = await login({ employeeNumber: '', password: 'password123' });
  assert.equal(status, 400);
});

test('whitespace-only employeeNumber returns 400', async () => {
  const { status } = await login({ employeeNumber: '   ', password: 'password123' });
  assert.equal(status, 400);
});

test('empty string password returns 400', async () => {
  const { status } = await login({ employeeNumber: uniqueEmployeeNumber(), password: '' });
  assert.equal(status, 400);
});

test('non-string employeeNumber returns 400', async () => {
  const { status } = await login({ employeeNumber: 12345, password: 'password123' });
  assert.equal(status, 400);
});

test('non-string password returns 400', async () => {
  const { status } = await login({ employeeNumber: uniqueEmployeeNumber(), password: 12345 });
  assert.equal(status, 400);
});

test('malformed JSON body returns 400 JSON, not an HTML error page', async () => {
  const res = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{ this is not valid json',
  });
  assert.equal(res.status, 400);
  const contentType = res.headers.get('content-type') || '';
  assert.ok(contentType.includes('application/json'), `expected JSON content-type, got "${contentType}"`);
  const json = await res.json();
  assert.equal(typeof json.error, 'string');
});

test('password differing only by case returns 401', async () => {
  const { employeeNumber, password } = await registerUser({ password: 'CaseSensitive123' });

  const { status } = await login({ employeeNumber, password: password.toLowerCase() });
  assert.equal(status, 401);
});

test('password differing only by trailing space returns 401', async () => {
  const { employeeNumber, password } = await registerUser({ password: 'no-trailing-space-here' });

  const { status } = await login({ employeeNumber, password: `${password} ` });
  assert.equal(status, 401);
});

test('no successful or error response ever contains passwordHash or the plaintext password', async () => {
  const { employeeNumber, password } = await registerUser({ password: 'never-leak-me-login-123' });

  const ok = await login({ employeeNumber, password });
  assert.equal(ok.status, 200);
  assert.ok(!ok.text.includes(password));
  assert.ok(!ok.text.toLowerCase().includes('passwordhash'));

  const bad = await login({ employeeNumber, password: 'wrong-password' });
  assert.equal(bad.status, 401);
  assert.ok(!bad.text.includes(password));
  assert.ok(!bad.text.toLowerCase().includes('passwordhash'));
});
