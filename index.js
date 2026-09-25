// Vercel entry point. Vercel's zero-config Express support looks for a file
// that exports the Express app at one of a few conventional locations
// (app.js, index.js, server.js, or the same under src/) at the *project
// root* — see https://vercel.com/docs/frameworks/backend/express
// ("Exporting the Express application"). The app itself lives at
// server/app.js (kept there so it can also be required directly by
// server/index.js for traditional/local hosting, and by the test suite);
// this file just re-exports it for Vercel to find.
//
// Deliberately NOT used for local development or `npm start` (see
// server/index.js for that) — Vercel invokes the exported app directly as a
// request handler per invocation, it never calls .listen(), and there is no
// startup hook to run sequelize.sync() once before the first request. That
// gap is filled by server/middleware/ensureDbSynced.js, mounted inside
// server/app.js itself, so it applies here automatically.
module.exports = require('./server/app');
