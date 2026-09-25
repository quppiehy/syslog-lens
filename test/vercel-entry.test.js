'use strict';
// Unit + integration coverage for api/index.js's path-restoring shim.
//
// vercel.json rewrites every request to "/api?__path=$1" (see api/index.js
// for the full reasoning, grounded in
// https://vercel.com/docs/project-configuration/vercel-json#rewrites),
// which means the function receives the DESTINATION path/query, not the
// one the browser requested. These tests prove the shim correctly
// reconstructs req.url from req.query.__path (and any other query
// parameters Vercel merges in) before Express ever sees the request, since
// a regression here would silently break every route (auth, static assets,
// the app itself) in production while looking fine in any test that talks
// to server/app.js directly.

process.env.JWT_SECRET = process.env.JWT_SECRET || 'vercel-entry-test-jwt-secret-32-characters';
process.env.DB_STORAGE = ':memory:';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const handler = require(path.join(__dirname, '..', 'api', 'index.js'));
const { restoreOriginalUrl } = handler;

test('restoreOriginalUrl reconstructs the root path with no query', () => {
  const req = { query: { __path: '' } };
  restoreOriginalUrl(req);
  assert.equal(req.url, '/');
});

test('restoreOriginalUrl reconstructs a simple path', () => {
  const req = { query: { __path: 'login' } };
  restoreOriginalUrl(req);
  assert.equal(req.url, '/login');
});

test('restoreOriginalUrl reconstructs a nested path', () => {
  const req = { query: { __path: 'api/auth/login' } };
  restoreOriginalUrl(req);
  assert.equal(req.url, '/api/auth/login');
});

test('restoreOriginalUrl preserves other query parameters Vercel merges in, and drops __path itself', () => {
  const req = { query: { __path: 'search', q: 'syslog', page: '2' } };
  restoreOriginalUrl(req);
  assert.equal(req.url, '/search?q=syslog&page=2');
});

test('restoreOriginalUrl leaves req.url unchanged when __path is absent', () => {
  const req = { url: '/some/original/path?x=1', query: {} };
  const result = restoreOriginalUrl(req);
  assert.equal(req.url, '/some/original/path?x=1');
  assert.equal(result.ok, true);
});

test('restoreOriginalUrl rejects a non-string (array) __path with 400', () => {
  const req = { url: '/api', query: { __path: ['a', 'b'] } };
  const result = restoreOriginalUrl(req);
  assert.equal(result.ok, false);
  assert.equal(result.status, 400);
  // req.url is left alone; the handler is responsible for short-circuiting.
  assert.equal(req.url, '/api');
});

test('restoreOriginalUrl reconstructs "/" for an empty __path', () => {
  const req = { query: { __path: '' } };
  restoreOriginalUrl(req);
  assert.equal(req.url, '/');
});

test('restoreOriginalUrl preserves extra query params like registered=1', () => {
  const req = { query: { __path: 'login', registered: '1' } };
  restoreOriginalUrl(req);
  assert.equal(req.url, '/login?registered=1');
});

test('restoreOriginalUrl handles repeated query parameter values', () => {
  const req = { query: { __path: 'search', tag: ['a', 'b'] } };
  restoreOriginalUrl(req);
  assert.equal(req.url, '/search?tag=a&tag=b');
});

test('end-to-end over real HTTP: a request rewritten to /api?__path=login is handled as /login, not 404ed', async () => {
  const http = require('node:http');

  // Mimics the one thing Vercel's Node.js runtime does before invoking a
  // function that this test can't get from a plain node:http server:
  // populating req.query from the (rewritten) req.url's query string — see
  // https://vercel.com/docs/functions/runtimes/node-js#node.js-helpers.
  // Everything after that — restoring the original path and routing through
  // the real Express app — runs unmodified.
  function vercelLikeHandler(req, res) {
    const parsed = new URL(req.url, 'http://localhost');
    req.query = Object.fromEntries(parsed.searchParams);
    return handler(req, res);
  }

  const server = http.createServer(vercelLikeHandler);
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();

  try {
    const res = await fetch(`http://127.0.0.1:${port}/api?__path=login`);
    assert.equal(res.status, 200, 'expected the restored /login route to be served, not a 404 for /api');
    const body = await res.text();
    assert.match(body, /login/i);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('end-to-end over real HTTP: a repeated __path (array) is rejected with 400 by the handler', async () => {
  const http = require('node:http');

  const server = http.createServer((req, res) => {
    // Simulate Vercel handing us __path twice, which node:querystring/URL
    // helpers turn into an array.
    req.query = { __path: ['login', 'register'] };
    return handler(req, res);
  });
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();

  try {
    const res = await fetch(`http://127.0.0.1:${port}/api`);
    assert.equal(res.status, 400);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('end-to-end over real HTTP: an unknown restored path still 404s (the shim does not accidentally bypass routing)', async () => {
  const http = require('node:http');

  function vercelLikeHandler(req, res) {
    const parsed = new URL(req.url, 'http://localhost');
    req.query = Object.fromEntries(parsed.searchParams);
    return handler(req, res);
  }

  const server = http.createServer(vercelLikeHandler);
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();

  try {
    const res = await fetch(`http://127.0.0.1:${port}/api?__path=this-route-does-not-exist`);
    assert.equal(res.status, 404);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
