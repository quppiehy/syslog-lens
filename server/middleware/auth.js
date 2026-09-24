// Express middleware that requires a valid JWT bearer token, loads the
// corresponding user from the DB, and attaches it to req.user.
const jwt = require('jsonwebtoken');
const User = require('../models/user');
const { JWT_SECRET } = require('../config');

const AUTH_ERROR = 'Missing or invalid authorization token';

function unauthorized(res) {
  res.set('WWW-Authenticate', 'Bearer');
  return res.status(401).json({ error: AUTH_ERROR });
}

async function requireAuth(req, res, next) {
  const header = req.get('authorization') || req.get('Authorization');

  if (typeof header !== 'string') {
    return unauthorized(res);
  }

  const match = /^Bearer\s+(.+)$/.exec(header);
  if (!match) {
    return unauthorized(res);
  }

  const token = match[1];

  let payload;
  try {
    // Pin the algorithm so a token signed (or forged) with alg "none" or
    // any other algorithm is rejected outright.
    payload = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] });
  } catch (err) {
    // Never leak jwt library error details (e.g. exact expiry timestamps).
    return unauthorized(res);
  }

  if (!payload || typeof payload.sub !== 'string') {
    return unauthorized(res);
  }

  try {
    const user = await User.findByPk(payload.sub);
    if (!user) {
      // Token is valid but the user no longer exists (e.g. deleted).
      return unauthorized(res);
    }
    req.user = user.toJSON();
    return next();
  } catch (err) {
    console.error('requireAuth failed:', err);
    return unauthorized(res);
  }
}

module.exports = requireAuth;
