// Express app definition, separated from server startup so tests can
// import and exercise the app (via supertest-style requests or fetch
// against an ephemeral listener) without binding to the configured PORT
// or requiring a real startup sequence.
const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');
const sequelize = require('./db');
require('./models/user'); // register the User model with Sequelize
const authRouter = require('./routes/auth');
const { requirePage, resolveUser } = require('./middleware/auth');

const app = express();

const PROJECT_ROOT = path.join(__dirname, '..');
const PUBLIC_DIR = path.join(PROJECT_ROOT, 'public');
const APP_HTML_PATH = path.join(PROJECT_ROOT, 'syslog-lens.html');

app.use(express.json());
app.use(cookieParser());

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

// Sends a response that must never be cached (used for every protected,
// user-specific HTML response so a shared/browser cache or the back button
// can't resurrect the app after logout).
function noStore(res) {
  res.set('Cache-Control', 'no-store');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
}

// Public login/register assets only — never the project root, which would
// expose server/, .env and the SQLite DB alongside them.
app.use(express.static(PUBLIC_DIR, { index: false }));

// GET /login and /register are public; if the visitor already has a valid
// session, send them straight to the app instead of showing the form again.
app.get('/login', async (req, res) => {
  try {
    const user = await resolveUser(req);
    if (user) return res.redirect(302, '/');
  } catch (err) {
    // fall through to showing the login page
  }
  return res.sendFile(path.join(PUBLIC_DIR, 'login.html'));
});

app.get('/register', async (req, res) => {
  try {
    const user = await resolveUser(req);
    if (user) return res.redirect(302, '/');
  } catch (err) {
    // fall through to showing the register page
  }
  return res.sendFile(path.join(PUBLIC_DIR, 'register.html'));
});

// GET / and /syslog-lens.html are the protected app itself.
app.get(['/', '/syslog-lens.html'], requirePage, (req, res) => {
  noStore(res);
  res.sendFile(APP_HTML_PATH);
});

// Everything else (including attempts to reach server/, .env, package.json,
// the SQLite DB, etc.) is a plain 404 — no listing, no leaking of files
// outside public/.
app.use((req, res) => {
  res.status(404).end();
});

// Generic error handler as a final safety net for unexpected errors.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('Unexpected error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

module.exports = app;
