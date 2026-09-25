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
// https://vercel.com/docs/project-configuration/vercel-json#rewrites,
// `rewrites[].source` is a path-to-regexp pattern, NOT a raw anchored regex
// — an earlier version of this file used `"^/(.*)$"` as the source, which
// doesn't match path-to-regexp syntax and silently never matched anything in
// production (confirmed live: `/` and `/login` came back as Vercel's own
// `404 NOT_FOUND`, while `/api` itself worked because it's served directly
// by the function). The docs' own examples use named parameters instead —
// `"/resize/:width/:height"` -> `"/api/sharp"` (captured segments become
// query params on the destination) and `"/proxy/:match*"` ->
// `"https://example.com/:match*"` (the same named param, referenced by name,
// substitutes into the destination's path or query). So `vercel.json`'s
// rewrite is `"/:path*"` -> `"/api?__path=:path*"`: every request reaches
// this function with `req.url` equal to `/api` plus a `__path` query
// parameter holding the ORIGINAL path (empty string for `/`, since `:path*`
// matches zero segments), and Vercel merges any of the request's own query
// parameters in alongside it. `req.query` is one of the Node.js helper
// properties Vercel populates on the request object
// (https://vercel.com/docs/functions/runtimes/node-js#node.js-helpers).
//
// A request to `/api` itself is unaffected by this rewrite: per the same
// docs page, "precedence is given to the filesystem prior to rewrites being
// applied" (rewrites "check the filesystem by default"), and `/api` is
// itself a filesystem function route (this file), so it's invoked directly
// with no `__path` — the shim below leaves `req.url` alone in that case.
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
