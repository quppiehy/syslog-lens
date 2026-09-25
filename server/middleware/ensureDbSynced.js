// On a traditional, long-running process (server/index.js), sequelize.sync()
// runs once at startup, before the server ever accepts a request — see
// index.js. On Vercel, there is no such startup hook: a serverless function
// instance can be reused for many requests (so sync() must run only once
// per instance, not per request) but it can also be a brand-new cold start
// at any time (so *something* still has to run sync() before the very first
// request touches the DB).
//
// This middleware makes "run sync() exactly once per instance, but recover
// if it failed" work as ordinary request handling: it caches the in-flight
// sync() promise on first use so concurrent requests during a cold start
// all await the same attempt instead of racing multiple sync() calls, and
// if that attempt fails, it clears the cache so the *next* request tries
// again (rather than permanently wedging the instance after one transient
// DB hiccup). Mount it before any route that touches the DB.
const sequelize = require('../db');

let syncPromise = null;

function ensureDbSynced() {
  if (!syncPromise) {
    // no force/alter — creates tables only if missing, same as index.js.
    syncPromise = sequelize.sync().catch((err) => {
      // Failed: forget this attempt so the next request retries from
      // scratch instead of being stuck forever on one rejected promise.
      syncPromise = null;
      throw err;
    });
  }
  return syncPromise;
}

function ensureDbSyncedMiddleware(req, res, next) {
  ensureDbSynced().then(
    () => next(),
    (err) => {
      console.error('Database sync failed:', err);
      res.status(503).json({ error: 'Service temporarily unavailable' });
    }
  );
}

// Test-only hook: forces the next call to ensureDbSynced()/the middleware to
// attempt sync() again, as if this were a fresh instance.
function resetForTests() {
  syncPromise = null;
}

module.exports = ensureDbSyncedMiddleware;
module.exports.ensureDbSynced = ensureDbSynced;
module.exports.resetForTests = resetForTests;
