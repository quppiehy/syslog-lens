const express = require('express');
const jwt = require('jsonwebtoken');
const { UniqueConstraintError } = require('sequelize');
const User = require('../models/user');
const { hashPassword, verifyPasswordAsync } = require('../lib/password');
const { JWT_SECRET, JWT_EXPIRES_IN } = require('../config');
const requireAuth = require('../middleware/auth');

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

router.post('/register', async (req, res) => {
  try {
    const body = req.body || {};
    const { name, employeeNumber, password } = body;

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

    const user = await User.findOne({ where: { employeeNumber: trimmedEmployeeNumber } });

    if (!user) {
      // Run a verify against a fixed dummy hash so the response time for an
      // unknown employee number is similar to a wrong-password response.
      const dummyHash = await dummyHashPromise;
      await verifyPasswordAsync(password, dummyHash);
      return res.status(401).json({ error: INVALID_LOGIN_ERROR });
    }

    const valid = await verifyPasswordAsync(password, user.passwordHash);
    if (!valid) {
      return res.status(401).json({ error: INVALID_LOGIN_ERROR });
    }

    const token = signToken(user);

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

module.exports = router;
