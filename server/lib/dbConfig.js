// Chooses the Sequelize constructor options for this process, without
// connecting to anything — kept separate from server/db.js (which actually
// builds/exports the `sequelize` instance) so the *selection logic* can be
// unit-tested cheaply and deterministically (no real DB, no network).
//
// Rule: if DATABASE_URL is set, use it (Postgres, e.g. Neon on Vercel).
// Otherwise fall back to the existing SQLite file, unchanged from before
// this file existed.
//
// Importantly, this module does NOT `require('pg')` or `require('sqlite3')`
// at the top level. Both drivers are required lazily, only inside the
// branch that actually needs them:
//   - `sqlite3` has a native binding and is only needed for local dev/tests.
//     On Vercel (DATABASE_URL set), sqlite3 must never be required, so a
//     Vercel install/build can't fail on its native build step, and so the
//     Postgres path never pays for loading a driver it doesn't use.
//   - `pg`/`pg-hstore` are pure-JS-ish and small, but there's no reason to
//     load them in local/test runs that only ever use SQLite either.
function getSequelizeOptions({ databaseUrl, sqliteStorage } = {}) {
  if (databaseUrl) {
    return {
      dialect: 'postgres',
      dialectModule: require('pg'),
      // Sequelize's postgres dialect uses pg-hstore for the (unused, but
      // required-to-be-resolvable) HSTORE type support; requiring it here
      // (rather than relying on Sequelize's own lazy require) keeps the
      // "what does the postgres branch load" list in one place.
      dialectOptions: {
        // Neon (and most hosted Postgres) uses publicly trusted certs, so
        // certificate verification should stay on; disabling it would allow
        // MITM against the DB connection.
        ssl: { require: true, rejectUnauthorized: true },
      },
      // Serverless-appropriate pool: each function instance handles very
      // few concurrent requests, and short-lived instances mean a large,
      // long-lived pool just holds idle connections against Postgres'
      // (comparatively low) max_connections. Neon's pooled connection
      // string already load-balances across many function instances, so
      // the per-instance pool here only needs to be small.
      pool: {
        max: 2,
        min: 0,
        acquire: 10000,
        idle: 5000,
      },
      logging: false,
    };
  }

  return {
    dialect: 'sqlite',
    // eslint-disable-next-line global-require
    dialectModule: require('sqlite3'),
    storage: sqliteStorage,
    logging: false,
  };
}

module.exports = { getSequelizeOptions };
