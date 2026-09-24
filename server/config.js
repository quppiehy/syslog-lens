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
};
