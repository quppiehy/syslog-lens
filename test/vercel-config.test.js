'use strict';
// Parses vercel.json and asserts the specific properties this project
// relies on to keep syslog-lens.html (and public/**, server/, .env,
// test-data/, package files, etc.) from ever being served directly by
// Vercel's CDN instead of going through Express/requirePage. See the
// "Deploying to Vercel" section of README.md for the full reasoning:
// Vercel's docs state that static files in the Output Directory (default
// "public") are served by the CDN with precedence over rewrites/functions
// (https://vercel.com/docs/project-configuration/vercel-json#outputdirectory,
// #rewrites: "precedence is given to the filesystem prior to rewrites
// being applied"), and separately that a zero-config Express deployment
// serves anything under public/** the same way
// (https://vercel.com/docs/frameworks/backend/express#serving-static-assets).
// Pointing outputDirectory at a directory that is guaranteed to hold no
// files closes both paths: there is nothing for the CDN to find and serve
// ahead of the Express function.
//
// This project deliberately does NOT rely on Vercel's zero-config Express
// preset (the dashboard "Framework Preset") — that preset looks for the app
// entry file *inside* outputDirectory
// (https://vercel.com/docs/frameworks/backend/express#exporting-the-express-application),
// which fails outright against a guaranteed-empty outputDirectory ("No
// entrypoint found in output directory"). Instead `vercel.json` sets
// `"framework": null` to force the "Other" preset
// (https://vercel.com/docs/project-configuration/vercel-json#framework:
// "To select 'Other' as the Framework Preset, use `null`") so a Framework
// Preset auto-detected/selected on the dashboard can't reintroduce that
// failure, and uses an explicit catch-all rewrite to a single Node.js
// function at api/index.js instead.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const PROJECT_ROOT = path.join(__dirname, '..');
const VERCEL_JSON_PATH = path.join(PROJECT_ROOT, 'vercel.json');

function readVercelConfig() {
  const raw = fs.readFileSync(VERCEL_JSON_PATH, 'utf8');
  return JSON.parse(raw);
}

test('vercel.json is present and valid JSON', () => {
  assert.ok(fs.existsSync(VERCEL_JSON_PATH), 'vercel.json must exist at the project root');
  assert.doesNotThrow(() => readVercelConfig());
});

test('outputDirectory points at a directory that actually exists and contains no files', () => {
  const config = readVercelConfig();
  assert.equal(typeof config.outputDirectory, 'string', 'outputDirectory must be set (see file header comment for why)');
  assert.notEqual(config.outputDirectory, 'public', 'must not be the conventional "public" directory Vercel serves via its CDN');
  assert.notEqual(config.outputDirectory, '.', 'must not be the project root, which Vercel would also serve via its CDN');

  const resolved = path.join(PROJECT_ROOT, config.outputDirectory);
  assert.ok(fs.existsSync(resolved), `outputDirectory "${config.outputDirectory}" must exist in the repo`);
  assert.ok(fs.statSync(resolved).isDirectory(), `outputDirectory "${config.outputDirectory}" must be a directory`);

  const entries = fs.readdirSync(resolved).filter((name) => name !== '.gitkeep');
  assert.deepEqual(entries, [], `outputDirectory must contain no real files (found: ${entries.join(', ')})`);
});

test('the project root itself is not also configured as a public/static directory Vercel would serve', () => {
  // Belt-and-braces: even with outputDirectory redirected, the repo must
  // not contain a literal top-level "public" directory whose contents are
  // meant to be reachable without going through Express — our actual
  // public/ (login/register pages) must still only be reachable via
  // Express so it gets helmet's CSP/HSTS. This asserts that syslog-lens.html
  // and server/ are not themselves placed inside whatever public/
  // directory exists, so even an unexpected CDN static-serving path can
  // never expose them.
  const publicDir = path.join(PROJECT_ROOT, 'public');
  if (!fs.existsSync(publicDir)) return; // nothing to check
  const publicEntries = fs.readdirSync(publicDir);
  assert.ok(!publicEntries.includes('syslog-lens.html'), 'syslog-lens.html must never live inside public/');
  assert.ok(!publicEntries.includes('server'), 'server/ must never live inside public/');
  assert.ok(!publicEntries.includes('.env'), '.env must never live inside public/');
});

test('framework is explicitly null so a dashboard Framework Preset cannot override this config', () => {
  const config = readVercelConfig();
  assert.ok(
    Object.prototype.hasOwnProperty.call(config, 'framework'),
    'vercel.json must explicitly set "framework" (see file header comment for why)'
  );
  assert.equal(config.framework, null, 'framework must be null (selects "Other") — a preset like Express would override this config');
});

test('rewrites contains a catch-all rewrite that routes every request to the /api function', () => {
  const config = readVercelConfig();
  assert.ok(Array.isArray(config.rewrites) && config.rewrites.length > 0, 'expected at least one rewrite');

  const catchAll = config.rewrites.find((r) => {
    if (typeof r.source !== 'string' || typeof r.destination !== 'string') return false;
    // vercel.json rewrites use path-to-regexp syntax, not raw anchored
    // regex (a bare "^/(.*)$" source silently never matches in production —
    // see api/index.js's header comment). Accept either the path-to-regexp
    // wildcard capture "(.*)" or a named zero-or-more segment matcher like
    // "/:path*", routed to the /api function.
    const matchesEverything = /\(\.\*\)/.test(r.source) || /^\/:[A-Za-z_$][A-Za-z0-9_$]*\*$/.test(r.source);
    const routesToApi = /^\/api(\?|$)/.test(r.destination);
    return matchesEverything && routesToApi;
  });
  assert.ok(catchAll, 'expected a catch-all rewrite (matching every path) whose destination is the /api function');
});

test('the catch-all rewrite is not a raw anchored regex (path-to-regexp does not support ^ and $ anchors)', () => {
  const config = readVercelConfig();
  for (const r of config.rewrites) {
    if (typeof r.source === 'string') {
      assert.ok(!r.source.startsWith('^') && !r.source.endsWith('$'), `rewrite source "${r.source}" looks like a raw anchored regex, not path-to-regexp syntax`);
    }
  }
});

test('functions config includes syslog-lens.html and public/** so the Vercel entry point can read them at runtime', () => {
  const config = readVercelConfig();
  assert.ok(config.functions, 'expected a functions config for includeFiles');

  const entries = Object.values(config.functions);
  assert.ok(entries.length > 0, 'expected at least one function entry');

  const matching = entries.find((entry) => {
    const inc = entry.includeFiles;
    if (typeof inc !== 'string') return false;
    return inc.includes('syslog-lens.html') && inc.includes('public');
  });
  assert.ok(matching, 'expected some function entry\'s includeFiles to cover both syslog-lens.html and public/**');
});

test('the configured Vercel entry point file exists and re-exports the Express app', () => {
  const config = readVercelConfig();
  const functionPaths = Object.keys(config.functions || {});
  assert.ok(functionPaths.length > 0, 'expected at least one function path configured');

  for (const fnPath of functionPaths) {
    const resolved = path.join(PROJECT_ROOT, fnPath);
    assert.ok(fs.existsSync(resolved), `configured function entry "${fnPath}" must exist`);
  }
});

test('api/index.js exports a request handler backed by the Express app', () => {
  const config = readVercelConfig();
  const functionPaths = Object.keys(config.functions || {});
  assert.ok(functionPaths.includes('api/index.js'), 'expected vercel.json functions config to include api/index.js');

  const handler = require(path.join(PROJECT_ROOT, 'api', 'index.js'));
  assert.equal(typeof handler, 'function', 'api/index.js must export a function (the Vercel request handler)');
  assert.equal(typeof handler.restoreOriginalUrl, 'function', 'api/index.js must export restoreOriginalUrl for the path-restoring shim to be unit-testable');
});
