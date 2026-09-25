// Vercel entry point (classic, preset-independent Express deployment).
//
// vercel.json intentionally does NOT use Vercel's zero-config Express
// preset: that preset looks for the app entry file *inside*
// `outputDirectory` (app.{js,...}/index.{js,...}/server.{js,...} — see
// https://vercel.com/docs/frameworks/backend/express#exporting-the-express-application),
// which conflicts with this project's deliberately empty
// `.vercel-empty-output` (kept empty so the CDN never serves
// syslog-lens.html or public/** ahead of Express's requirePage/CSP — see
// the "Deploying to Vercel" section of README.md). Instead, `vercel.json`
// sets `"framework": null` (selects "Other" — see
// https://vercel.com/docs/project-configuration/vercel-json#framework:
// "To select 'Other' as the Framework Preset, use `null`"), points
// `outputDirectory` at the empty directory, and adds a catch-all rewrite so
// every request (`/`, `/login`, `/auth.js`, `/api/*`, everything) is routed
// to this one Node.js function in `/api`.
//
// Preserving the original path/query across the rewrite: per
// https://vercel.com/docs/project-configuration/vercel-json#rewrites, a
// rewrite hands the target the DESTINATION path, not the path the browser
// requested — the docs' own example rewrites "/resize/:width/:height" to
// "/api/sharp" and shows the result as "/api/sharp?width=800&height=600"
// (the source's captured segments end up as query parameters on the
// destination, not appended to its path), and the regex-capture-group
// example on the same page shows a capture (`$1`) can be substituted
// directly into the destination, including into its query string. So
// `vercel.json`'s rewrite is `"^/(.*)$"` -> `"/api?__path=$1"`: every
// request reaches this function with `req.url` equal to `/api` plus a
// `__path` query parameter holding the ORIGINAL path (and Vercel merges any
// of the request's own query parameters in alongside it). `req.query` is
// one of the Node.js helper properties Vercel populates on the request
// object (https://vercel.com/docs/functions/runtimes/node-js#node.js-helpers).
//
// The shim below reads `__path` back off `req.query`, reassembles the
// original `req.url` (path + any remaining query parameters) before Express
// ever sees the request, and removes the `__path` parameter itself so it
// doesn't leak into `req.query` inside the app. This is what lets
// server/app.js's routes (`/`, `/login`, `/register`, `/api/auth`, static
// `public/**`, etc.) match exactly as they do under `server/index.js`'s
// traditional `app.listen()` — see test/vercel-entry.test.js for coverage
// of this reassembly, including the plain "/" case and paths carrying their
// own query string.
const app = require('../server/app');

function restoreOriginalUrl(req) {
  const query = req.query || {};

  // __path absent: Vercel didn't route this through the rewrite (or someone
  // hit /api directly) — leave req.url exactly as-is rather than guessing.
  if (!Object.prototype.hasOwnProperty.call(query, '__path')) {
    return { ok: true };
  }

  const encodedPath = query.__path;
  // A second client-supplied __path becomes an array; refuse rather than
  // silently picking one.
  if (typeof encodedPath !== 'string') {
    return { ok: false, status: 400 };
  }

  const remaining = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (key === '__path') continue;
    if (Array.isArray(value)) {
      for (const v of value) remaining.append(key, v);
    } else {
      remaining.append(key, value);
    }
  }

  const search = remaining.toString();
  req.url = `/${encodedPath}${search ? `?${search}` : ''}`;
  return { ok: true };
}

module.exports = function handler(req, res) {
  const result = restoreOriginalUrl(req);
  if (!result.ok) {
    res.statusCode = result.status;
    res.end('Bad Request');
    return;
  }
  return app(req, res);
};

// Exposed for direct, dependency-free unit testing of the reassembly logic
// (see test/vercel-entry.test.js) without going through a real HTTP request.
module.exports.restoreOriginalUrl = restoreOriginalUrl;
