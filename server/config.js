// Central place to read environment configuration for the backend.
require('dotenv').config();

const path = require('path');

const PORT = process.env.PORT || 3000;

// Default DB path is relative to the project root (server/data/syslog-lens.sqlite).
// DB_STORAGE=':memory:' is passed through as-is so tests can use an
// isolated in-memory SQLite database instead of touching server/data.
const DB_STORAGE = process.env.DB_STORAGE
  ? process.env.DB_STORAGE === ':memory:'
    ? ':memory:'
    : path.resolve(process.cwd(), process.env.DB_STORAGE)
  : path.join(__dirname, 'data', 'syslog-lens.sqlite');

// JWT signing secret. Required — there is no insecure default. Tests are
// expected to set their own JWT_SECRET before requiring server/app.
const JWT_SECRET = process.env.JWT_SECRET;

// Token lifetime, passed straight through to jsonwebtoken's `expiresIn`.
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '8h';

const MIN_JWT_SECRET_LENGTH = 32;

// Name of the httpOnly cookie that carries the JWT.
const COOKIE_NAME = 'sl_token';

// Whether the auth cookie should be marked Secure (only sent over HTTPS).
// Off by default so login works over plain http://localhost in development;
// set COOKIE_SECURE=true behind HTTPS in production.
const COOKIE_SECURE = process.env.COOKIE_SECURE === 'true';

// Parses a jsonwebtoken `expiresIn`-style value (a number of seconds, or a
// string like "8h", "30m", "1d") into a number of milliseconds, for use as
// a cookie Max-Age. Falls back to 8 hours if the value can't be parsed.
function parseExpiresInMs(value) {
  const FALLBACK_MS = 8 * 60 * 60 * 1000;
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value * 1000;
  }
  if (typeof value !== 'string') return FALLBACK_MS;
  if (/^\d+$/.test(value)) {
    return Number(value) * 1000;
  }
  const match = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d|w|y)$/i.exec(value.trim());
  if (!match) return FALLBACK_MS;
  const n = Number(match[1]);
  const unit = match[2].toLowerCase();
  const unitMs = { ms: 1, s: 1000, m: 60 * 1000, h: 60 * 60 * 1000, d: 24 * 60 * 60 * 1000, w: 7 * 24 * 60 * 60 * 1000, y: 365 * 24 * 60 * 60 * 1000 }[unit];
  return n * unitMs;
}

const COOKIE_MAX_AGE_MS = parseExpiresInMs(JWT_EXPIRES_IN);

// Validates a JWT secret value, throwing a clear, actionable Error if it's
// missing or too short. Exported (rather than run automatically at module
// load) so it can be unit-tested directly and so index.js controls exactly
// when/how a validation failure aborts startup.
function validateJwtSecret(secret) {
  if (typeof secret !== 'string' || secret.length === 0) {
    throw new Error(
      'JWT_SECRET is required but not set. Add it to your .env file — see .env.example for how to generate one.'
    );
  }
  if (secret.length < MIN_JWT_SECRET_LENGTH) {
    throw new Error(
      `JWT_SECRET must be at least ${MIN_JWT_SECRET_LENGTH} characters long (got ${secret.length}). ` +
        'See .env.example for how to generate a strong secret.'
    );
  }
}

const NODE_ENV = process.env.NODE_ENV || 'development';
const IS_PRODUCTION = NODE_ENV === 'production';

// Invite code required to register. Optional outside production: if unset
// in dev/test, registration does not ask for one at all. In production it
// is mandatory (checked at startup by validateInviteCodeConfig) and must be
// at least MIN_INVITE_CODE_LENGTH characters.
const INVITE_CODE = process.env.INVITE_CODE || null;
const MIN_INVITE_CODE_LENGTH = 12;

function validateInviteCodeConfig() {
  if (!IS_PRODUCTION) return;
  if (typeof INVITE_CODE !== 'string' || INVITE_CODE.length === 0) {
    throw new Error(
      'INVITE_CODE is required in production but not set. Add it to your .env file (at least ' +
        `${MIN_INVITE_CODE_LENGTH} characters).`
    );
  }
  if (INVITE_CODE.length < MIN_INVITE_CODE_LENGTH) {
    throw new Error(
      `INVITE_CODE must be at least ${MIN_INVITE_CODE_LENGTH} characters long (got ${INVITE_CODE.length}).`
    );
  }
}

// Validates production-only config invariants (JWT_SECRET, INVITE_CODE) and
// throws if either is missing/invalid. A no-op outside production. Exported
// so it can run from *any* entry point that boots the Express app — not
// just server/index.js — which matters because a serverless entry point
// (e.g. a Vercel function) may `require('./app')` directly without ever
// running index.js's own startup sequence; without this, such an entry
// point would silently skip the checks index.js performs today.
function assertProductionConfig() {
  if (!IS_PRODUCTION) return;
  validateJwtSecret(JWT_SECRET);
  validateInviteCodeConfig();
}

// Express `trust proxy` setting, used to derive req.ip correctly when the
// app runs behind a reverse proxy / load balancer (e.g. Vercel). Defaults
// to false (do not trust any proxy headers) so req.ip is the direct socket
// address unless explicitly configured otherwise. On Vercel (and most PaaS
// setups sitting behind a single trusted edge proxy) set TRUST_PROXY=1 (or
// the appropriate hop count) so X-Forwarded-For is honoured; setting it to
// "true" trusts every hop, which is only safe if nothing untrusted can
// reach the app directly.
function parseTrustProxy(value) {
  if (value === undefined || value === '') return false;
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (/^\d+$/.test(value)) return Number(value);
  return value; // e.g. a comma-separated subnet list or a token like "loopback"
}
const TRUST_PROXY = parseTrustProxy(process.env.TRUST_PROXY);

// DB-backed login/register rate limiting. All windows/lockouts are in
// milliseconds so tests can configure very short ones; the effective
// defaults below match the 15-minute / 5-failure (per employee) and
// 15-minute / 20-failure (per IP) policy, plus a 10-per-hour register cap
// per IP.
function envInt(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

const RATE_LIMIT = {
  loginPerEmployee: {
    maxAttempts: envInt('LOGIN_EMP_MAX_ATTEMPTS', 5),
    windowMs: envInt('LOGIN_EMP_WINDOW_MS', 15 * 60 * 1000),
    lockMs: envInt('LOGIN_EMP_LOCK_MS', 15 * 60 * 1000),
  },
  loginPerIp: {
    maxAttempts: envInt('LOGIN_IP_MAX_ATTEMPTS', 20),
    windowMs: envInt('LOGIN_IP_WINDOW_MS', 15 * 60 * 1000),
    lockMs: envInt('LOGIN_IP_LOCK_MS', 15 * 60 * 1000),
  },
  registerPerIp: {
    maxAttempts: envInt('REGISTER_IP_MAX_ATTEMPTS', 10),
    windowMs: envInt('REGISTER_IP_WINDOW_MS', 60 * 60 * 1000),
    lockMs: envInt('REGISTER_IP_LOCK_MS', 60 * 60 * 1000),
  },
};

module.exports = {
  PORT,
  DB_STORAGE,
  JWT_SECRET,
  JWT_EXPIRES_IN,
  MIN_JWT_SECRET_LENGTH,
  validateJwtSecret,
  COOKIE_NAME,
  COOKIE_SECURE,
  COOKIE_MAX_AGE_MS,
  NODE_ENV,
  IS_PRODUCTION,
  INVITE_CODE,
  MIN_INVITE_CODE_LENGTH,
  validateInviteCodeConfig,
  assertProductionConfig,
  TRUST_PROXY,
  RATE_LIMIT,
};
