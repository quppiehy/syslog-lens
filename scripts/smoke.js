#!/usr/bin/env node
'use strict';

// Dependency-free smoke test for a deployed (or locally running) Syslog
// Lens instance. Uses only Node's built-in `fetch` (Node 18+) — no
// node_modules required, so it can run against a freshly-deployed Vercel
// preview/production URL without `npm install` first.
//
// Verifies, against a real HTTP(S) endpoint, logged out:
//   - / and /syslog-lens.html redirect to /login (302), with no app HTML
//     leaked in the redirect body — i.e. the protected app is never served
//     to an unauthenticated visitor, whether by Express or (on Vercel) by
//     the CDN serving a static file ahead of it;
//   - files that must never be reachable (.env, server/app.js,
//     package.json, test-data/*) all 404 — nothing outside public/ leaks;
//   - /login and /register return 200 *with* the same security headers as
//     the rest of the app (CSP, X-Frame-Options or CSP frame-ancestors,
//     X-Content-Type-Options: nosniff, and — unless HSTS is expected to be
//     off — Strict-Transport-Security). This is the check that would catch
//     Vercel's CDN serving these pages directly (with its own default
//     headers) instead of Express.
//   - /api/health reports the DB as reachable.
//
// Usage:
//   node scripts/smoke.js <baseUrl>
//   npm run smoke -- <baseUrl>
//
// Set SMOKE_EXPECT_HSTS=false to skip the HSTS assertion (e.g. when
// smoke-testing a local plain-http server started with COOKIE_SECURE
// unset/false, where HSTS is intentionally not sent — see README).
//
// Exits non-zero, after printing every check's PASS/FAIL, if any check
// failed.

// Any of these appearing in a response body that's supposed to be just a
// redirect stub means the real app leaked out.
const APP_MARKERS = ['Syslog Lens', 'id="app"', 'SyslogLens'];

function bodyLooksLikeApp(body) {
  return APP_MARKERS.some((marker) => body.includes(marker));
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

// Shared by the /login, /register checks and the public/** static-asset
// checks below: asserts the same set of security headers Express's
// middleware attaches to every response.
function assertSecurityHeaders(res, { expectHsts }) {
  const csp = res.headers.get('content-security-policy');
  assert(csp, 'missing Content-Security-Policy header');
  assert(/frame-ancestors\s+'none'/i.test(csp), "missing frame-ancestors 'none' directive in CSP");

  assert(res.headers.get('x-content-type-options') === 'nosniff', 'missing/wrong X-Content-Type-Options');

  if (expectHsts) {
    assert(res.headers.get('strict-transport-security'), 'missing Strict-Transport-Security header');
  }
}

async function check(results, name, fn) {
  try {
    const detail = await fn();
    results.push({ name, ok: true, detail: detail || '' });
  } catch (err) {
    results.push({ name, ok: false, detail: err.message });
  }
}

// Runs the full smoke suite against `baseUrl` (no trailing slash required).
// Returns { results, ok } rather than throwing/exiting, so it can be
// imported and asserted on directly from the test suite as well as run
// from the CLI (see main() below).
async function runSmoke(baseUrl, { expectHsts = true } = {}) {
  const base = baseUrl.replace(/\/+$/, '');
  const results = [];

  async function assertProtectedRedirect(path) {
    const res = await fetch(`${base}${path}`, { redirect: 'manual' });
    assert(res.status === 302, `expected 302, got ${res.status}`);
    const location = res.headers.get('location') || '';
    assert(location === '/login' || location.endsWith('/login'), `expected redirect to /login, got "${location}"`);
    const body = await res.text();
    assert(!bodyLooksLikeApp(body), 'response body looks like it contains the app, not just a redirect stub');
    return `-> ${location}`;
  }

  await check(results, 'GET / (logged out) redirects to /login with no app HTML', () => assertProtectedRedirect('/'));
  await check(results, 'GET /syslog-lens.html (logged out) redirects to /login with no app HTML', () =>
    assertProtectedRedirect('/syslog-lens.html')
  );

  const forbiddenPaths = ['/.env', '/server/app.js', '/package.json', '/test-data/network-incidents.log'];
  for (const p of forbiddenPaths) {
    // eslint-disable-next-line no-await-in-loop
    await check(results, `GET ${p} -> 404`, async () => {
      const res = await fetch(`${base}${p}`, { redirect: 'manual' });
      assert(res.status === 404, `expected 404, got ${res.status}`);
    });
  }

  for (const p of ['/login', '/register']) {
    // eslint-disable-next-line no-await-in-loop
    await check(results, `GET ${p} -> 200 with security headers`, async () => {
      const res = await fetch(`${base}${p}`);
      assert(res.status === 200, `expected 200, got ${res.status}`);
      assertSecurityHeaders(res, { expectHsts });
    });
  }

  // Static assets served out of public/** (login/register pages and their
  // JS/CSS). On Vercel these can be served directly by the CDN, bypassing
  // Express's security-headers middleware entirely, so each one must either
  // 404 (not deployed as a static file) or carry the same headers Express
  // would attach. Either outcome is safe; silently missing headers is not.
  for (const p of ['/login.html', '/register.html', '/auth.js', '/auth.css']) {
    // eslint-disable-next-line no-await-in-loop
    await check(results, `GET ${p} -> 404, or 200 with security headers`, async () => {
      const res = await fetch(`${base}${p}`, { redirect: 'manual' });
      if (res.status === 404) return '404';
      assert(res.status === 200, `expected 404 or 200, got ${res.status}`);
      assertSecurityHeaders(res, { expectHsts });
      return '200 with security headers';
    });
  }

  await check(results, 'GET /api/health -> 200 with db ok', async () => {
    const res = await fetch(`${base}/api/health`);
    assert(res.status === 200, `expected 200, got ${res.status}`);
    const json = await res.json();
    assert(json && json.status === 'ok', `expected status "ok", got ${JSON.stringify(json)}`);
    assert(json && json.db === 'ok', `expected db "ok", got ${JSON.stringify(json)}`);
  });

  const failures = results.filter((r) => !r.ok);
  return { results, ok: failures.length === 0 };
}

function printResults(results) {
  for (const r of results) {
    const mark = r.ok ? 'PASS' : 'FAIL';
    const extra = r.ok ? (r.detail ? ` (${r.detail})` : '') : `: ${r.detail}`;
    // eslint-disable-next-line no-console
    console.log(`[${mark}] ${r.name}${extra}`);
  }
}

async function main() {
  const baseUrl = process.argv[2];
  if (!baseUrl) {
    console.error('Usage: node scripts/smoke.js <baseUrl>'); // eslint-disable-line no-console
    process.exitCode = 1;
    return;
  }

  const expectHsts = process.env.SMOKE_EXPECT_HSTS !== 'false';
  const { results, ok } = await runSmoke(baseUrl, { expectHsts });
  printResults(results);

  if (!ok) {
    console.error(`\n${results.filter((r) => !r.ok).length} check(s) failed.`); // eslint-disable-line no-console
    process.exitCode = 1;
  } else {
    console.log('\nAll checks passed.'); // eslint-disable-line no-console
  }
}

if (require.main === module) {
  main();
}

module.exports = { runSmoke };
