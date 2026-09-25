'use strict';
// Unit tests for server/lib/dbConfig.js's dialect-selection logic. These
// deliberately never connect to a real database (no sequelize.authenticate
// or .sync) — they only check *which options object* would be built for a
// given environment, so they run instantly and don't need Postgres or a
// SQLite file available in CI.

const test = require('node:test');
const assert = require('node:assert/strict');

const { getSequelizeOptions } = require('../server/lib/dbConfig');

test('DATABASE_URL set -> postgres dialect, with a small serverless-appropriate pool and SSL required', () => {
  const options = getSequelizeOptions({ databaseUrl: 'postgres://user:pass@host:5432/db' });

  assert.equal(options.dialect, 'postgres');
  assert.equal(typeof options.dialectModule, 'object', 'dialectModule should be the loaded pg module');
  assert.equal(options.logging, false);

  assert.ok(options.dialectOptions, 'expected dialectOptions to be set');
  assert.ok(options.dialectOptions.ssl, 'expected ssl to be required for a hosted Postgres like Neon');
  assert.equal(options.dialectOptions.ssl.require, true);
  assert.equal(options.dialectOptions.ssl.rejectUnauthorized, true, 'certificate verification must stay enabled');

  assert.ok(options.pool, 'expected a pool config suitable for serverless');
  assert.ok(options.pool.max <= 5, `pool.max should be small for serverless, got ${options.pool.max}`);
  assert.ok(options.pool.acquire <= 15000, 'acquire timeout should be short, not the default 60s');
  assert.ok(options.pool.idle <= 10000, 'idle timeout should be short so idle connections are released quickly');
});

test('DATABASE_URL unset -> sqlite dialect, unchanged from before', () => {
  const options = getSequelizeOptions({ sqliteStorage: ':memory:' });

  assert.equal(options.dialect, 'sqlite');
  assert.equal(options.storage, ':memory:');
  assert.equal(options.logging, false);
  assert.equal(typeof options.dialectModule, 'object', 'dialectModule should be the loaded sqlite3 module');
});

test('getSequelizeOptions never requires sqlite3 on the postgres path', () => {
  // sqlite3 has a native binding; requiring it unconditionally is exactly
  // what would make a Vercel install/build fail on a platform where its
  // prebuilt binary isn't available. Assert the postgres branch simply
  // does not reference the sqlite3 module id at all, by checking it is not
  // newly present in the require cache as a *direct* result of calling
  // getSequelizeOptions({ databaseUrl }) alone.
  const sqliteWasCached = Object.keys(require.cache).some((id) => id.includes(`${require('path').sep}sqlite3${require('path').sep}`));
  if (sqliteWasCached) {
    // Some earlier test file in this same process may have already loaded
    // sqlite3 (e.g. via server/db.js in dev mode); that's fine and outside
    // what this test can observe. Skip rather than false-fail.
    return;
  }
  getSequelizeOptions({ databaseUrl: 'postgres://user:pass@host:5432/db' });
  const sqliteNowCached = Object.keys(require.cache).some((id) => id.includes(`${require('path').sep}sqlite3${require('path').sep}`));
  assert.equal(sqliteNowCached, false, 'the postgres branch must never require("sqlite3")');
});

test('server/db.js selects postgres when DATABASE_URL is set, without ever requiring sqlite3', () => {
  const { execFileSync } = require('node:child_process');
  const path = require('node:path');
  const PROJECT_ROOT = path.join(__dirname, '..');

  // Run in a child process: this is the only reliable way to observe "was
  // sqlite3 ever require()'d for this DATABASE_URL-configured process" —
  // require.cache in *this* test process may already hold it from other
  // test files run in the same worker.
  const script = `
    const sequelize = require('./server/db');
    if (sequelize.getDialect() !== 'postgres') {
      console.error('expected postgres, got ' + sequelize.getDialect());
      process.exit(1);
    }
    const sqliteLoaded = Object.keys(require.cache).some((id) => id.includes('sqlite3'));
    if (sqliteLoaded) {
      console.error('sqlite3 was required even though DATABASE_URL was set');
      process.exit(1);
    }
    process.exit(0);
  `;

  assert.doesNotThrow(() => {
    execFileSync(process.execPath, ['-e', script], {
      cwd: PROJECT_ROOT,
      env: {
        ...process.env,
        DATABASE_URL: 'postgres://user:pass@127.0.0.1:5432/nonexistent',
        JWT_SECRET: 'db-dialect-test-jwt-secret-at-least-32-characters',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  });
});
