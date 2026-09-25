const crypto = require('crypto');
const express = require('express');
const jwt = require('jsonwebtoken');
const { UniqueConstraintError } = require('sequelize');
const User = require('../models/user');
const { hashPassword, verifyPasswordAsync } = require('../lib/password');
const { checkLocked, recordAttempt, resetKey, retryAfterSeconds } = require('../lib/rateLimit');
const {
  JWT_SECRET,
  JWT_EXPIRES_IN,
  COOKIE_NAME,
  COOKIE_SECURE,
  COOKIE_MAX_AGE_MS,
  INVITE_CODE,
  MIN_INVITE_CODE_LENGTH,
  IS_PRODUCTION,
  RATE_LIMIT,
} = require('../config');
const requireAuth = require('../middleware/auth');

function setAuthCookie(res, token) {
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'strict',
    path: '/',
    maxAge: COOKIE_MAX_AGE_MS,
    secure: COOKIE_SECURE,
  });
}

const router = express.Router();

function signToken(user) {
  return jwt.sign(
    {
      sub: String(user.id),
      employeeNumber: user.employeeNumber,
      name: user.name,
    },
    JWT_SECRET,
    { algorithm: 'HS256', expiresIn: JWT_EXPIRES_IN }
  );
}

const MIN_PASSWORD_LENGTH = 8;

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

// Derives the rate-limit key for the requester's IP. Requires
// app.set('trust proxy', ...) (see server/app.js + config.TRUST_PROXY) to be
// configured correctly in production so req.ip reflects the real client
// address rather than a shared proxy address.
function ipKeyFor(req, prefix) {
  return `${prefix}:${req.ip || 'unknown'}`;
}

function sendLocked(res, lockedUntil) {
  const retryAfter = retryAfterSeconds(lockedUntil);
  res.set('Retry-After', String(retryAfter));
  return res.status(429).json({ error: 'Too many attempts. Try again later.' });
}

// Hashes both sides to a fixed-length (32-byte) digest before comparing, so
// crypto.timingSafeEqual (which throws on unequal-length buffers, and whose
// whole point is defeated by a length check) always receives equal-length
// input regardless of the submitted invite code's length.
function inviteCodeMatches(submitted) {
  if (typeof submitted !== 'string') return false;
  const expectedHash = crypto.createHash('sha256').update(INVITE_CODE, 'utf8').digest();
  const submittedHash = crypto.createHash('sha256').update(submitted, 'utf8').digest();
  return crypto.timingSafeEqual(expectedHash, submittedHash);
}

// server/config.js's assertProductionConfig() already refuses to boot the
// app at all when this is the case (in production, without a valid
// INVITE_CODE). This is a second, independent guard directly in the
// handler: fail closed rather than open if that startup check is ever
// bypassed (e.g. hot-reloaded config, or a future entry point that
// constructs the router without going through app.js's module-load check).
// Logged once rather than per-request to avoid flooding logs under a
// hammered misconfigured deployment.
let loggedInviteMisconfiguration = false;
function inviteCodeConfiguredForProduction() {
  return typeof INVITE_CODE === 'string' && INVITE_CODE.length >= MIN_INVITE_CODE_LENGTH;
}

router.post('/register', async (req, res) => {
  try {
    if (IS_PRODUCTION && !inviteCodeConfiguredForProduction()) {
      if (!loggedInviteMisconfiguration) {
        loggedInviteMisconfiguration = true;
        console.error(
          `Registration is not configured: INVITE_CODE is missing or shorter than ${MIN_INVITE_CODE_LENGTH} characters in production.`
        );
      }
      return res.status(503).json({ error: 'Registration is not configured' });
    }

    const ipKey = ipKeyFor(req, 'regip');
    const lockedUntil = await checkLocked(ipKey);
    if (lockedUntil) {
      return sendLocked(res, lockedUntil);
    }
    await recordAttempt(ipKey, RATE_LIMIT.registerPerIp);

    const body = req.body || {};
    const { name, employeeNumber, password, inviteCode } = body;

    if (typeof name !== 'string' || typeof employeeNumber !== 'string' || typeof password !== 'string') {
      return res.status(400).json({ error: 'name, employeeNumber and password must all be strings' });
    }

    const trimmedName = name.trim();
    const trimmedEmployeeNumber = employeeNumber.trim();

    if (!isNonEmptyString(name)) {
      return res.status(400).json({ error: 'name is required' });
    }
    if (!isNonEmptyString(employeeNumber)) {
      return res.status(400).json({ error: 'employeeNumber is required' });
    }
    if (password.length === 0) {
      return res.status(400).json({ error: 'password is required' });
    }
    // Length is checked on the raw (untrimmed) password — leading/trailing
    // whitespace in a password is significant and should count.
    if (password.length < MIN_PASSWORD_LENGTH) {
      return res.status(400).json({ error: `password must be at least ${MIN_PASSWORD_LENGTH} characters` });
    }

    // Invite code check — only enforced when one is actually configured
    // (required in production; optional in dev/test, see server/config.js).
    // Deliberately checked BEFORE the duplicate-employeeNumber lookup below
    // so a wrong invite code can never be used to probe which employee
    // numbers are already registered.
    if (INVITE_CODE && !inviteCodeMatches(inviteCode)) {
      return res.status(403).json({ error: 'Invalid invite code' });
    }

    // Pre-check for a friendlier error on the common case; the unique index
    // still catches the race via the catch block below.
    const existing = await User.findOne({ where: { employeeNumber: trimmedEmployeeNumber } });
    if (existing) {
      return res.status(409).json({ error: 'employeeNumber is already registered' });
    }

    const passwordHash = await hashPassword(password);

    const user = await User.create({
      name: trimmedName,
      employeeNumber: trimmedEmployeeNumber,
      passwordHash,
    });

    return res.status(201).json({
      id: user.id,
      name: user.name,
      employeeNumber: user.employeeNumber,
    });
  } catch (err) {
    if (err instanceof UniqueConstraintError) {
      return res.status(409).json({ error: 'employeeNumber is already registered' });
    }
    console.error('Registration failed:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

const INVALID_LOGIN_ERROR = 'Invalid employee number or password';

// Computed once at module load so a lookup miss can still run a verify
// against a real scrypt hash of the same shape as a genuine stored hash —
// this keeps response time similar for unknown vs. wrong-password cases
// and prevents timing-based user enumeration.
const dummyHashPromise = hashPassword('dummy-password-for-timing-safety');

router.post('/login', async (req, res) => {
  try {
    const body = req.body || {};
    const { employeeNumber, password } = body;

    if (typeof employeeNumber !== 'string' || typeof password !== 'string') {
      return res.status(400).json({ error: 'employeeNumber and password must both be strings' });
    }

    const trimmedEmployeeNumber = employeeNumber.trim();

    if (!isNonEmptyString(employeeNumber)) {
      return res.status(400).json({ error: 'employeeNumber is required' });
    }
    if (password.length === 0) {
      return res.status(400).json({ error: 'password is required' });
    }

    const empKey = `emp:${trimmedEmployeeNumber}`;
    const ipKey = ipKeyFor(req, 'ip');

    // Checked (and enforced) for both the employee number and the caller's
    // IP — including an employee number that doesn't exist, so a locked-out
    // attacker can't distinguish "wrong password" from "unknown employee"
    // by watching for 429 vs 401. Sequential, not Promise.all: SQLite (in
    // particular the single-connection ':memory:' mode tests use) can't run
    // two transactions concurrently on one connection, and sequential reads/
    // writes here cost negligible latency either way.
    const empLock = await checkLocked(empKey);
    const ipLock = empLock ? null : await checkLocked(ipKey);
    const lockedUntil = empLock || ipLock;
    if (lockedUntil) {
      return sendLocked(res, lockedUntil);
    }

    const user = await User.findOne({ where: { employeeNumber: trimmedEmployeeNumber } });

    if (!user) {
      // Run a verify against a fixed dummy hash so the response time for an
      // unknown employee number is similar to a wrong-password response.
      const dummyHash = await dummyHashPromise;
      await verifyPasswordAsync(password, dummyHash);
      await recordAttempt(empKey, RATE_LIMIT.loginPerEmployee);
      await recordAttempt(ipKey, RATE_LIMIT.loginPerIp);
      return res.status(401).json({ error: INVALID_LOGIN_ERROR });
    }

    const valid = await verifyPasswordAsync(password, user.passwordHash);
    if (!valid) {
      await recordAttempt(empKey, RATE_LIMIT.loginPerEmployee);
      await recordAttempt(ipKey, RATE_LIMIT.loginPerIp);
      return res.status(401).json({ error: INVALID_LOGIN_ERROR });
    }

    // Successful login resets this employee's failure counter (but not the
    // shared per-IP counter, which protects against a single IP hammering
    // many different employee numbers).
    await resetKey(empKey);

    const token = signToken(user);
    setAuthCookie(res, token);

    return res.status(200).json({
      token,
      user: {
        id: user.id,
        name: user.name,
        employeeNumber: user.employeeNumber,
      },
    });
  } catch (err) {
    console.error('Login failed:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/me', requireAuth, (req, res) => {
  const { id, name, employeeNumber } = req.user;
  return res.status(200).json({ id, name, employeeNumber });
});

// Idempotent: clearing an already-absent cookie is a no-op, so calling this
// with no session (or calling it twice) still returns 204.
router.post('/logout', (req, res) => {
  res.clearCookie(COOKIE_NAME, { path: '/' });
  return res.status(204).end();
});

module.exports = router;
