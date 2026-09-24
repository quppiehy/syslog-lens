// Express app definition, separated from server startup so tests can
// import and exercise the app (via supertest-style requests or fetch
// against an ephemeral listener) without binding to the configured PORT
// or requiring a real startup sequence.
const path = require('path');
const express = require('express');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const sequelize = require('./db');
require('./models/user'); // register the User model with Sequelize
require('./models/loginAttempt'); // register the LoginAttempt model with Sequelize
const authRouter = require('./routes/auth');
const { requirePage, resolveUser } = require('./middleware/auth');
const { TRUST_PROXY, COOKIE_SECURE, assertProductionConfig } = require('./config');
const { computeInlineScriptHashes } = require('./lib/csp');

// Fail closed at module load, not just in server/index.js's own startup
// sequence: any entry point that imports this module directly (e.g. a
// future serverless/Vercel handler) must not be able to skip the
// production JWT_SECRET/INVITE_CODE checks. No-op outside production.
assertProductionConfig();

const app = express();

// Needed for req.ip (and therefore per-IP rate limiting) to reflect the
// real client address when running behind a reverse proxy / edge network
// (e.g. Vercel) rather than the proxy's own address. Off by default — see
// server/config.js for how TRUST_PROXY is parsed.
app.set('trust proxy', TRUST_PROXY);

const PROJECT_ROOT = path.join(__dirname, '..');
const PUBLIC_DIR = path.join(PROJECT_ROOT, 'public');
const APP_HTML_PATH = path.join(PROJECT_ROOT, 'syslog-lens.html');

// Computed once at startup: sha256 hashes of every inline <script> block in
// syslog-lens.html and public/*.html, so the CSP below can allow exactly
// those blocks without 'unsafe-inline'.
const INLINE_SCRIPT_HASHES = computeInlineScriptHashes();

app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", ...INLINE_SCRIPT_HASHES],
        styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
        fontSrc: ["'self'", 'https://fonts.gstatic.com'],
        connectSrc: ["'self'"],
        imgSrc: ["'self'", 'data:', 'blob:'],
        objectSrc: ["'none'"],
        baseUri: ["'none'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
      },
    },
    frameguard: { action: 'deny' },
    noSniff: true,
    referrerPolicy: { policy: 'no-referrer' },
    // HSTS only makes sense (and is only safe to advertise) once the app is
    // actually served over HTTPS with a Secure cookie — advertising it over
    // plain http://localhost in dev would just be misleading.
    hsts: COOKIE_SECURE ? { maxAge: 15552000, includeSubDomains: true } : false,
  })
);

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
