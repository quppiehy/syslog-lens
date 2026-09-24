// Express app definition, separated from server startup so tests can
// import and exercise the app (via supertest-style requests or fetch
// against an ephemeral listener) without binding to the configured PORT
// or requiring a real startup sequence.
const express = require('express');
const sequelize = require('./db');
require('./models/user'); // register the User model with Sequelize
const authRouter = require('./routes/auth');

const app = express();

app.use(express.json());

// Malformed JSON bodies should produce a clean 400 JSON error instead of
// Express's default HTML error page.
app.use((err, req, res, next) => {
  if (err && err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'Malformed JSON body' });
  }
  return next(err);
});

app.get('/api/health', async (req, res) => {
  let dbStatus = 'unknown';
  try {
    await sequelize.authenticate();
    dbStatus = 'ok';
  } catch (err) {
    dbStatus = 'error';
  }
  res.json({
    status: 'ok',
    db: dbStatus,
  });
});

app.use('/api/auth', authRouter);

// Generic error handler as a final safety net for unexpected errors.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('Unexpected error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

module.exports = app;
