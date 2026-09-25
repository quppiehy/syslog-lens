'use strict';
// Verifies TRUST_PROXY actually controls how req.ip is derived, using a
// representative X-Forwarded-For header chain — this is the setting the
// README calls out as security-critical on Vercel.
//
// X-Forwarded-For accumulates left-to-right as a request passes through
// proxies: each hop appends the address it received the connection *from*.
// So the right-most entry is always whatever the *nearest* (most trusted)
// hop itself observed — a client can stuff any values it likes into the
// earlier, left-most entries, but it cannot forge the entry its own
// directly-connected proxy appends. Express's numeric `trust proxy` setting
// (TRUST_PROXY=1 for Vercel's single edge proxy) uses exactly that: with N
// hops trusted, it reads the Nth entry from the right, ignoring however
// many untrusted entries a client prepended to the left of it. This is why
// TRUST_PROXY must equal the real hop count in front of the app — trusting
// *more* hops than actually exist lets a client's own forged left-most
// entry be read as the client IP.
//
// Run in child processes (one per TRUST_PROXY value) because Express's
// `trust proxy` setting is read once, at app construction time, from
// server/config.js's already-parsed TRUST_PROXY — there's no supported way
// to flip it on an existing app/require-cached module in this process.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const PROJECT_ROOT = path.join(__dirname, '..');

// A plausible chain for a client that sent its own (forgeable)
// X-Forwarded-For, then passed through Vercel's one real edge proxy, which
// appended the address it actually saw the connection come from.
const FORWARDED_FOR = '203.0.113.7, 100.64.0.1';
const REAL_EDGE_OBSERVED_IP = '100.64.0.1'; // the right-most, trustworthy entry

// Builds a minimal Express app that sets `trust proxy` from
// server/config.js's TRUST_PROXY exactly the way server/app.js does
// (`app.set('trust proxy', TRUST_PROXY)`), with one route that echoes
// req.ip — this exercises the real config-parsing -> Express trust-proxy
// pipeline without depending on server/app.js's own route table (which
// ends in a catch-all 404 that would otherwise swallow a route added after
// the fact).
function reqIpScript(forwardedFor) {
  return `
    const express = require('express');
    const { TRUST_PROXY } = require('./server/config');
    const app = express();
    app.set('trust proxy', TRUST_PROXY);
    app.get('/__whoami', (req, res) => res.json({ ip: req.ip }));
    const server = app.listen(0, async () => {
      const baseUrl = 'http://127.0.0.1:' + server.address().port;
      const res = await fetch(baseUrl + '/__whoami', {
        headers: { 'X-Forwarded-For': ${JSON.stringify(forwardedFor)} },
      });
      const json = await res.json();
      console.log(JSON.stringify(json));
      server.close(() => { process.exitCode = 0; });
    });
  `;
}

function getReqIpInChildProcess(trustProxyEnv, forwardedFor = FORWARDED_FOR) {
  const env = {
    ...process.env,
    JWT_SECRET: 'trust-proxy-test-jwt-secret-at-least-32-chars',
    DB_STORAGE: ':memory:',
    INVITE_CODE: '',
  };
  if (trustProxyEnv === undefined) {
    delete env.TRUST_PROXY;
  } else {
    env.TRUST_PROXY = trustProxyEnv;
  }
  const stdout = execFileSync(process.execPath, ['-e', reqIpScript(forwardedFor)], {
    cwd: PROJECT_ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return JSON.parse(stdout.toString().trim().split('\n').pop()).ip;
}

test('TRUST_PROXY unset/false (default): req.ip ignores X-Forwarded-For entirely', () => {
  const ip = getReqIpInChildProcess(undefined);
  // Direct socket peer for a loopback fetch — never the spoofed header.
  // This is the failure mode the README warns about for a proxied
  // deployment: every client would share this one address as the
  // rate-limit key.
  assert.match(ip, /^(::ffff:)?127\.0\.0\.1$/, `expected the direct socket IP, got ${ip}`);
});

test('TRUST_PROXY=1 (Vercel: one trusted edge hop): req.ip is the edge-observed address, not the client-supplied left-most entry', () => {
  const ip = getReqIpInChildProcess('1');
  assert.equal(ip, REAL_EDGE_OBSERVED_IP, `expected the right-most (trusted-hop-observed) address, got ${ip}`);
  assert.notEqual(ip, '203.0.113.7', 'must not trust the client-supplied left-most entry over the real edge-observed one');
});

test('TRUST_PROXY=1: a longer client-forged chain in front of the trusted hop is still ignored', () => {
  // A client that stuffs extra forged entries into X-Forwarded-For hoping
  // to be treated as an arbitrary IP still only gets the one entry
  // Vercel's own edge appended (the right-most one) trusted — the forged
  // entries to its left are simply part of the untrusted, client-supplied
  // prefix and never consulted when exactly one hop is trusted.
  const longChain = 'forged-address-1, forged-address-2, 100.64.0.1';
  const ip = getReqIpInChildProcess('1', longChain);
  assert.equal(ip, '100.64.0.1', `expected only the right-most entry to be trusted, got ${ip}`);
  assert.notEqual(ip, 'forged-address-1');
  assert.notEqual(ip, 'forged-address-2');
});
