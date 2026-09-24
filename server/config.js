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
};
