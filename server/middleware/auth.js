// Express middleware that requires a valid JWT — from either the httpOnly
// auth cookie or a Bearer header — loads the corresponding user from the
// DB, and attaches it to req.user.
const jwt = require('jsonwebtoken');
const User = require('../models/user');
const { JWT_SECRET, COOKIE_NAME } = require('../config');

const AUTH_ERROR = 'Missing or invalid authorization token';

function unauthorized(res) {
  res.set('WWW-Authenticate', 'Bearer');
  return res.status(401).json({ error: AUTH_ERROR });
}

// Extracts the raw token string from the request: prefers the httpOnly
// cookie (used by the browser UI), falling back to an Authorization: Bearer
// header (used by API clients/tests). Returns null if neither is present.
function extractToken(req) {
  const cookieToken = req.cookies && req.cookies[COOKIE_NAME];
  if (typeof cookieToken === 'string' && cookieToken.length > 0) {
    return cookieToken;
  }

  const header = req.get('authorization') || req.get('Authorization');
  if (typeof header === 'string') {
    const match = /^Bearer\s+(.+)$/.exec(header);
    if (match) return match[1];
  }

  return null;
}

// Verifies a token and resolves the corresponding user, or returns null if
// the token is missing, invalid, expired, forged, or belongs to a
// since-deleted user. Shared by requireAuth (API) and requirePage (HTML).
async function resolveUser(req) {
  const token = extractToken(req);
  if (!token) return null;

  let payload;
  try {
    // Pin the algorithm so a token signed (or forged) with alg "none" or
    // any other algorithm is rejected outright.
    payload = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] });
  } catch (err) {
    // Never leak jwt library error details (e.g. exact expiry timestamps).
    return null;
  }

  if (!payload || typeof payload.sub !== 'string') return null;

  try {
    const user = await User.findByPk(payload.sub);
    if (!user) return null; // token valid but user no longer exists
    return user.toJSON();
  } catch (err) {
    console.error('auth lookup failed:', err);
    return null;
  }
}

async function requireAuth(req, res, next) {
  const user = await resolveUser(req);
  if (!user) return unauthorized(res);
  req.user = user;
  return next();
}

// Page guard for HTML routes: same verification rules as requireAuth, but
// redirects to /login instead of returning a 401 JSON body, and clears an
// invalid/expired cookie so the browser doesn't keep resending it.
async function requirePage(req, res, next) {
  const user = await resolveUser(req);
  if (!user) {
    res.clearCookie(COOKIE_NAME, { path: '/' });
    return res.redirect(302, '/login');
  }
  req.user = user;
  return next();
}

module.exports = requireAuth;
module.exports.requireAuth = requireAuth;
module.exports.requirePage = requirePage;
module.exports.resolveUser = resolveUser;
