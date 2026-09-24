// Sequelize connection setup (SQLite via the sqlite3 driver).
const fs = require('fs');
const path = require('path');
const { Sequelize } = require('sequelize');
const { DB_STORAGE } = require('./config');

// Make sure the directory that will hold the SQLite file exists.
const dbDir = path.dirname(DB_STORAGE);
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

const sequelize = new Sequelize({
  dialect: 'sqlite',
  dialectModule: require('sqlite3'),
  storage: DB_STORAGE,
  logging: false,
});

// For non-transactional queries, Sequelize's sqlite ConnectionManager hands
// out one shared sqlite3.Database object (cached under a fixed "default"
// key). But sequelize.transaction() (see node_modules/sequelize/lib/
// transaction.js prepareEnvironment/cleanup) acquires its connection keyed
// by the *transaction's own id* instead — for a real (non-':memory:') file,
// that means every transaction gets a genuinely separate sqlite3.Database
// file handle, opened for the transaction and closed again when it
// commits/rolls back. That's realistic (two concurrent transactions really
// are two separate connections, as they would be against Postgres too),
// but SQLite's default busy_timeout is 0, so two of those connections
// racing to write (e.g. two requests both recording a failed login for the
// same brand-new rate-limit key at once) immediately hit SQLITE_BUSY
// ("database is locked") instead of one waiting for the other's
// transaction to finish. sqlite3's Database#configure('busyTimeout', ms)
// fixes that by making a second writer wait (up to the timeout) instead of
// erroring — it has to be set per connection object, so this wraps
// getConnection() to configure every new one exactly once (a WeakSet
// avoids reconfiguring the same object repeatedly, since the shared
// "default" connection is returned from many calls). This is irrelevant
// for a real Postgres deployment, where MVCC/row locks (not a busy_timeout
// on a shared file handle) provide the concurrency control.
const BUSY_TIMEOUT_MS = 5000;
const originalGetConnection = sequelize.connectionManager.getConnection.bind(sequelize.connectionManager);
const busyTimeoutConfiguredConnections = new WeakSet();
sequelize.connectionManager.getConnection = async function getConnectionWithBusyTimeout(options) {
  const connection = await originalGetConnection(options);
  if (!busyTimeoutConfiguredConnections.has(connection)) {
    busyTimeoutConfiguredConnections.add(connection);
    connection.configure('busyTimeout', BUSY_TIMEOUT_MS);
  }
  return connection;
};

module.exports = sequelize;
