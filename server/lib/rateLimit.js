// DB-backed, dialect-agnostic (SQLite + Postgres) rate limiting used for
// login and register. Deliberately backed by a table (server/models/loginAttempt.js)
// rather than an in-memory Map: the app is deployed as multiple stateless
// serverless instances, so any in-process counter would be per-instance and
// would not actually enforce a shared limit.
const { Op } = require('sequelize');
const sequelize = require('../db');
const LoginAttempt = require('../models/loginAttempt');

// Probability that recordAttempt() also sweeps stale rows (see
// pruneStaleAttempts below). Kept low so the sweep is cheap on average, but
// still runs occasionally without needing a separate cron/scheduled job.
// Overridable only for tests (see setPruneProbabilityForTests).
const DEFAULT_PRUNE_PROBABILITY = 1 / 50;
let pruneProbabilityOverride = null;

// Test-only hook: forces pruneStaleAttempts' random gate to a fixed
// probability (e.g. 1, to make it deterministic) or resets it (null).
function setPruneProbabilityForTests(probability) {
  pruneProbabilityOverride = probability;
}

// Deletes rate-limit rows that are both no longer locked (lockedUntil is
// null, or in the past) and stale (their window started more than 24h ago,
// so they can no longer affect any current decision). Runs outside the
// row-locked transaction in recordAttempt, gated by a low random
// probability so it doesn't add a DELETE to every single request — this
// table has no other janitor/cron, so without this it would grow forever.
async function pruneStaleAttempts() {
  const probability = pruneProbabilityOverride !== null ? pruneProbabilityOverride : DEFAULT_PRUNE_PROBABILITY;
  if (Math.random() >= probability) return;

  const staleCutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
  try {
    await LoginAttempt.destroy({
      where: {
        windowStart: { [Op.lt]: staleCutoff },
        [Op.or]: [{ lockedUntil: null }, { lockedUntil: { [Op.lte]: new Date() } }],
      },
    });
  } catch (err) {
    // Never let a best-effort cleanup sweep break rate limiting itself.
    console.error('pruneStaleAttempts failed:', err);
  }
}

// Returns the remaining lock, in whole seconds (minimum 1), for use as a
// Retry-After header value.
function retryAfterSeconds(lockedUntil) {
  const ms = lockedUntil.getTime() - Date.now();
  return Math.max(1, Math.ceil(ms / 1000));
}

// Reads the current lock state for `key` without mutating anything. Returns
// the Date the lock expires at, or null if not currently locked.
async function checkLocked(key) {
  const rec = await LoginAttempt.findOne({ where: { key } });
  if (!rec) return null;
  if (rec.lockedUntil && rec.lockedUntil.getTime() > Date.now()) {
    return rec.lockedUntil;
  }
  return null;
}

// Records one failed/counted attempt against `key` under the given policy
// ({maxAttempts, windowMs, lockMs}), rolling the window over and applying a
// new lock once maxAttempts is reached within it. Runs inside a transaction
// with a row lock (a no-op but harmless on SQLite, a real FOR UPDATE on
// Postgres) so concurrent requests against the same key don't lose updates.
async function recordAttempt(key, policy) {
  const rec = await sequelize.transaction(async (t) => {
    const now = new Date();

    // Idempotent insert: creates the row if it doesn't exist yet, does
    // nothing if it does (INSERT OR IGNORE on SQLite, ON CONFLICT DO
    // NOTHING on Postgres — `key` is the model's primary key, so both
    // dialects treat a duplicate as a no-op here rather than an error).
    // This deliberately replaces the previous create()-then-catch-the-
    // unique-violation approach: on Postgres, a failed INSERT poisons the
    // surrounding transaction, so any statement issued afterwards
    // (including the "re-read and fall through" recovery this used to do)
    // would itself fail with "current transaction is aborted". bulkCreate
    // with ignoreDuplicates avoids ever raising that error in the first
    // place, so the first-attempt and concurrent-attempt paths converge on
    // the same SELECT ... FOR UPDATE + update logic below instead of
    // branching.
    await LoginAttempt.bulkCreate([{ key, failedCount: 0, windowStart: now, lockedUntil: null }], {
      ignoreDuplicates: true,
      transaction: t,
    });

    // Row now definitely exists (just created above, or already there) —
    // lock it for update so concurrent requests against the same key
    // serialize here instead of losing an update.
    const rowRec = await LoginAttempt.findOne({
      where: { key },
      transaction: t,
      lock: t.LOCK.UPDATE,
    });

    if (rowRec.lockedUntil && rowRec.lockedUntil.getTime() > now.getTime()) {
      // Already locked — leave the counter/lock as-is. Callers are expected
      // to have checked checkLocked() first and short-circuited, but this
      // keeps recordAttempt itself safe to call unconditionally too.
      return rowRec;
    }

    // A freshly-created row has windowStart === now, so this is never
    // "expired" and falls into the else branch below, taking failedCount
    // from 0 to 1 — i.e. the first failure still counts as 1, same as
    // before.
    const windowExpired = now.getTime() - rowRec.windowStart.getTime() > policy.windowMs;
    if (windowExpired) {
      rowRec.failedCount = 1;
      rowRec.windowStart = now;
      rowRec.lockedUntil = null;
    } else {
      rowRec.failedCount += 1;
    }

    if (rowRec.failedCount >= policy.maxAttempts) {
      rowRec.lockedUntil = new Date(now.getTime() + policy.lockMs);
    }

    await rowRec.save({ transaction: t });
    return rowRec;
  });

  // Outside the row-locked transaction: occasionally sweep stale rows so
  // this table doesn't grow forever (see pruneStaleAttempts above).
  await pruneStaleAttempts();

  return rec;
}

// Clears the counter for `key` entirely (used on a successful login to
// reset that employee's failure count).
async function resetKey(key) {
  await LoginAttempt.destroy({ where: { key } });
}

module.exports = {
  checkLocked,
  recordAttempt,
  resetKey,
  retryAfterSeconds,
  setPruneProbabilityForTests,
};
