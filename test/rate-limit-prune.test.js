'use strict';
// Focused tests for the stale-row pruning sweep added to
// server/lib/rateLimit.js's recordAttempt(): outside the row-locked
// transaction, with a small (normally 1/50) probability, it deletes rows
// that are both unlocked (lockedUntil null or in the past) and stale
// (windowStart older than 24h). setPruneProbabilityForTests() lets tests
// force that probability to 1 (always sweep) or 0 (never sweep) instead of
// depending on Math.random().

process.env.DB_STORAGE = ':memory:';
process.env.JWT_SECRET = 'prune-test-jwt-secret-at-least-32-characters';
process.env.INVITE_CODE = '';

const test = require('node:test');
const assert = require('node:assert/strict');

const sequelize = require('../server/db');
const LoginAttempt = require('../server/models/loginAttempt');
const { recordAttempt, setPruneProbabilityForTests } = require('../server/lib/rateLimit');

const POLICY = { maxAttempts: 5, windowMs: 900000, lockMs: 900000 };

test.before(async () => {
  await sequelize.sync({ force: true });
});

test.after(async () => {
  setPruneProbabilityForTests(null);
  await sequelize.close();
});

test('recordAttempt prunes stale, unlocked rows when the prune probability is forced to 1', async () => {
  const staleKey = 'emp:STALE-1';
  const stillLockedKey = 'emp:LOCKED-1';
  const freshKey = 'emp:FRESH-1';
  const oldWindowStart = new Date(Date.now() - 25 * 60 * 60 * 1000); // >24h ago

  await LoginAttempt.create({ key: staleKey, failedCount: 3, windowStart: oldWindowStart, lockedUntil: null });
  await LoginAttempt.create({
    key: stillLockedKey,
    failedCount: 5,
    windowStart: oldWindowStart, // stale by window, but...
    lockedUntil: new Date(Date.now() + 60 * 60 * 1000), // ...still actively locked, so must survive
  });

  setPruneProbabilityForTests(1); // force the sweep to always run
  await recordAttempt(freshKey, POLICY);

  assert.equal(await LoginAttempt.findOne({ where: { key: staleKey } }), null, 'a stale, unlocked row should have been pruned');
  assert.ok(await LoginAttempt.findOne({ where: { key: stillLockedKey } }), 'a row still under an active lock must not be pruned, even if stale');
  assert.ok(await LoginAttempt.findOne({ where: { key: freshKey } }), 'the row just written by recordAttempt itself should still be there');
});

test('recordAttempt does not prune anything when the prune probability is forced to 0', async () => {
  const staleKey = 'emp:STALE-2';
  const oldWindowStart = new Date(Date.now() - 25 * 60 * 60 * 1000);
  await LoginAttempt.create({ key: staleKey, failedCount: 3, windowStart: oldWindowStart, lockedUntil: null });

  setPruneProbabilityForTests(0);
  await recordAttempt('emp:OTHER-2', POLICY);

  assert.ok(await LoginAttempt.findOne({ where: { key: staleKey } }), 'nothing should be pruned when the probability is forced to 0');
});
