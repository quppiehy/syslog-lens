'use strict';
// Tests server/middleware/ensureDbSynced.js in isolation, against a tiny
// Express app of its own (not server/app.js), so it can stub
// sequelize.sync() directly and control exactly when it fails vs succeeds
// — proving: (1) sync() is only ever called once across many requests once
// it has succeeded, and (2) a failure returns 503 and is retried (not
// permanently cached) on the next request.

process.env.DB_STORAGE = ':memory:';
process.env.JWT_SECRET = 'db-sync-middleware-test-jwt-secret-32-chars';
process.env.INVITE_CODE = '';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const sequelize = require('../server/db');
const ensureDbSynced = require('../server/middleware/ensureDbSynced');

function buildApp() {
  const app = express();
  app.use(ensureDbSynced);
  app.get('/ping', (req, res) => res.json({ pong: true }));
  return app;
}

async function startApp(app) {
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  return { server, baseUrl: `http://127.0.0.1:${server.address().port}` };
}

test.beforeEach(() => {
  ensureDbSynced.resetForTests();
});

test('sync() is called exactly once across multiple requests once it succeeds', async () => {
  let syncCalls = 0;
  const originalSync = sequelize.sync.bind(sequelize);
  sequelize.sync = async (...args) => {
    syncCalls += 1;
    return originalSync(...args);
  };

  const { server, baseUrl } = await startApp(buildApp());
  try {
    const results = await Promise.all([
      fetch(`${baseUrl}/ping`),
      fetch(`${baseUrl}/ping`),
      fetch(`${baseUrl}/ping`),
    ]);
    for (const res of results) {
      assert.equal(res.status, 200);
    }
    // A 4th, sequential request after the first batch has resolved should
    // not trigger another sync() call either.
    const again = await fetch(`${baseUrl}/ping`);
    assert.equal(again.status, 200);

    assert.equal(syncCalls, 1, `expected sync() to run exactly once, ran ${syncCalls} times`);
  } finally {
    sequelize.sync = originalSync;
    await new Promise((resolve) => server.close(resolve));
  }
});

test('a failed sync() returns 503 and is retried (and can succeed) on the next request', async () => {
  let syncCalls = 0;
  const originalSync = sequelize.sync.bind(sequelize);
  sequelize.sync = async (...args) => {
    syncCalls += 1;
    if (syncCalls === 1) {
      throw new Error('simulated sync failure');
    }
    return originalSync(...args);
  };

  const { server, baseUrl } = await startApp(buildApp());
  try {
    const first = await fetch(`${baseUrl}/ping`);
    assert.equal(first.status, 503);
    const firstJson = await first.json();
    assert.equal(firstJson.error, 'Service temporarily unavailable');

    const second = await fetch(`${baseUrl}/ping`);
    assert.equal(second.status, 200, 'the second request should retry sync() and succeed');

    const third = await fetch(`${baseUrl}/ping`);
    assert.equal(third.status, 200, 'once synced, later requests should not need to sync again');

    assert.equal(syncCalls, 2, `expected exactly one failed + one successful sync() call, got ${syncCalls}`);
  } finally {
    sequelize.sync = originalSync;
    await new Promise((resolve) => server.close(resolve));
  }
});

test('concurrent requests during a cold start share a single in-flight sync() call', async () => {
  let syncCalls = 0;
  let resolveSync;
  const originalSync = sequelize.sync.bind(sequelize);
  sequelize.sync = () =>
    new Promise((resolve, reject) => {
      syncCalls += 1;
      resolveSync = () => originalSync().then(resolve, reject);
    });

  const { server, baseUrl } = await startApp(buildApp());
  try {
    const requests = Promise.all([fetch(`${baseUrl}/ping`), fetch(`${baseUrl}/ping`), fetch(`${baseUrl}/ping`)]);
    // Give all three requests a chance to hit the middleware before letting
    // the single in-flight sync() resolve.
    await new Promise((resolve) => setTimeout(resolve, 50));
    resolveSync();
    const results = await requests;

    for (const res of results) {
      assert.equal(res.status, 200);
    }
    assert.equal(syncCalls, 1, `expected a single shared sync() call for concurrent cold-start requests, got ${syncCalls}`);
  } finally {
    sequelize.sync = originalSync;
    await new Promise((resolve) => server.close(resolve));
  }
});
