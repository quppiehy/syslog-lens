# Syslog Lens

A browser-based tool for troubleshooting network syslogs. Upload or paste a log to browse events by severity and inspect incidents with a summary and timeline. All parsing happens in your browser, and nothing is uploaded.

## Using the app

The app is served by the included backend and requires signing in.

```bash
npm install
cp .env.example .env
npm start
```

Then open <http://localhost:3000>. You'll be redirected to `/login`; register an account first if you don't have one. Once signed in, click **Try a sample log** to try it without your own log.

(`syslog-lens.html` can still be opened directly as a plain file for local development/testing — see `test/ui-smoke.test.js` — but that bypasses the login and is not how the app is meant to be used.)

## Running the tests (developers only)

You only need this to run the automated tests, not to use the app.

**Requirements:** [Node.js](https://nodejs.org/) 24 (the test library jsdom needs 22+; CI and Vercel use 24.x).

**First-time setup** (once per machine, or again after deleting `node_modules`):

```bash
npm install
npx playwright install chromium
```

- `npm install` downloads the test libraries (jsdom and Playwright) into `node_modules/`.
- `npx playwright install chromium` downloads a headless Chromium browser (about 300 MB) for the UI tests.

**Run the tests:**

```bash
npm test
```

## Backend

A small Express + SQLite backend under `server/` provides authentication and now serves the app itself. Stage 1 added the foundation: a database connection, a `User` model, and a health-check endpoint. Stage 2 added user registration. Stage 3 added login (credential check only). Stage 4 added JWT-based authentication: login issues a token, and a protected `/api/auth/me` endpoint returns the current user. Stage 5 wires it all together: Express now serves `syslog-lens.html` itself, and it is never sent to an unauthenticated visitor — this is enforced server-side, not by hiding things in JS.

### Routes

| Route | Access | Notes |
|---|---|---|
| `GET /login` | Public | Login page (`public/login.html`). Redirects to `/` if already signed in. |
| `GET /register` | Public | Registration page (`public/register.html`). Redirects to `/` if already signed in. |
| `GET /auth.css`, `/auth.js` | Public | Shared static assets for the login/register pages (served from `public/`). |
| `POST /api/auth/register` | Public | Create an account. |
| `POST /api/auth/login` | Public | Sign in; sets the auth cookie and returns `{token,user}`. |
| `POST /api/auth/logout` | Public (idempotent) | Clears the auth cookie. |
| `GET /api/auth/me` | Protected | Current user; accepts the cookie or a Bearer token. |
| `GET /` and `GET /syslog-lens.html` | Protected | The app itself. Unauthenticated requests get a `302` to `/login`; responses carry `Cache-Control: no-store`. |
| Everything else | — | `404`, with nothing leaked from `server/`, `.env`, the SQLite DB, etc. — only `public/` is ever statically served. |

### Cookie model

Login sets an httpOnly `sl_token` cookie (`HttpOnly`, `SameSite=Strict`, `Path=/`, `Max-Age` matching the JWT's expiry, and `Secure` when `COOKIE_SECURE=true`). The frontend never reads or stores the token itself (no `localStorage`/`sessionStorage`) — `syslog-lens.html` only calls `GET /api/auth/me` (to show "Signed in as …") and `POST /api/auth/logout`, both `credentials: 'same-origin'`, relying on the browser to send the cookie. `requireAuth` (API routes) and `requirePage` (HTML routes) both accept either the cookie or an `Authorization: Bearer <token>` header, so existing API clients/tests using Bearer tokens keep working unchanged; `requirePage` additionally redirects to `/login` (instead of a 401 JSON body) and clears an invalid/expired cookie.

**Setup:**

```bash
npm install
cp .env.example .env
```

`.env` controls `PORT` (default `3000`), `DB_STORAGE` (default `server/data/syslog-lens.sqlite`, created automatically if missing), `JWT_SECRET`, `JWT_EXPIRES_IN` (default `8h`), and `COOKIE_SECURE` (default `false`; set `true` when serving over HTTPS so the auth cookie is marked `Secure`, which also enables HSTS — see below).

### Environment variables

| Variable | Default | Notes |
|---|---|---|
| `PORT` | `3000` | Port Express listens on. |
| `DB_STORAGE` | `server/data/syslog-lens.sqlite` | SQLite file path (or `:memory:` for tests). Ignored when `DATABASE_URL` is set. |
| `DATABASE_URL` | *(unset)* | When set, use Postgres (via `pg`) instead of SQLite — e.g. the Neon integration on Vercel sets this automatically. See "Deploying to Vercel" below. |
| `JWT_SECRET` | *(required)* | Signs auth JWTs; must be ≥32 characters. |
| `JWT_EXPIRES_IN` | `8h` | JWT/cookie lifetime (`jsonwebtoken` `expiresIn` format). |
| `COOKIE_SECURE` | `false` | Marks the auth cookie `Secure`; also gates whether HSTS is sent. Set `true` behind HTTPS. |
| `INVITE_CODE` | *(unset)* | Required in `POST /api/auth/register` body as `inviteCode` whenever set. **Required in production** (`NODE_ENV=production`) — the server refuses to start without one ≥12 characters. Optional in dev/test: leave unset to skip the check entirely. |
| `TRUST_PROXY` | `false` | Express `trust proxy` setting, used to derive the real client IP (`req.ip`) for rate limiting behind a reverse proxy. Set to `1` on Vercel (a single trusted edge proxy); leave `false` for local development. Accepts `true`/`false`, a hop count, or an Express-style proxy list. |
| `LOGIN_EMP_MAX_ATTEMPTS` | `5` | Failed logins for one employee number, within `LOGIN_EMP_WINDOW_MS`, before that employee number is locked for `LOGIN_EMP_LOCK_MS`. |
| `LOGIN_EMP_WINDOW_MS` | `900000` (15 min) | Rolling window for the per-employee counter. |
| `LOGIN_EMP_LOCK_MS` | `900000` (15 min) | Lockout duration once the per-employee limit is hit. |
| `LOGIN_IP_MAX_ATTEMPTS` | `20` | Failed logins from one IP, within `LOGIN_IP_WINDOW_MS`, before that IP is locked for `LOGIN_IP_LOCK_MS`. |
| `LOGIN_IP_WINDOW_MS` | `900000` (15 min) | Rolling window for the per-IP login counter. |
| `LOGIN_IP_LOCK_MS` | `900000` (15 min) | Lockout duration once the per-IP login limit is hit. |
| `REGISTER_IP_MAX_ATTEMPTS` | `10` | Registration attempts from one IP, within `REGISTER_IP_WINDOW_MS`, before that IP is locked for `REGISTER_IP_LOCK_MS`. |
| `REGISTER_IP_WINDOW_MS` | `3600000` (1 hour) | Rolling window for the per-IP register counter. |
| `REGISTER_IP_LOCK_MS` | `3600000` (1 hour) | Lockout duration once the per-IP register limit is hit. |

All rate-limit counters are stored in the database (a `LoginAttempt` model/table), not in memory — this is required so the limits are enforced correctly across multiple stateless server instances (e.g. Vercel serverless functions), where an in-process counter would be per-instance and trivially bypassable.

`JWT_SECRET` is **required** — the server refuses to start if it's missing or shorter than 32 characters. Generate a strong one with:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

and put it in `.env` as `JWT_SECRET=<generated value>`.

**Start the server:**

```bash
npm start
```

**Verify it's working:**

```bash
curl http://localhost:3000/api/health
```

should return `{"status":"ok","db":"ok"}`. You can also inspect the database schema directly (useful on Windows, where the `sqlite3` CLI usually isn't installed):

```bash
npm run db:check
```

which prints the columns of the `users` table.

### Security headers

Every response carries `helmet`-managed security headers: `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, a `Content-Security-Policy`, and (only when `COOKIE_SECURE=true`) `Strict-Transport-Security`. The CSP's `script-src` allows `'self'` plus a `sha256-` hash per inline `<script>` block found in `syslog-lens.html` and `public/*.html` at startup — no `'unsafe-inline'` for scripts. `style-src` allows `'unsafe-inline'` (the pages use inline `<style>`) plus Google Fonts' stylesheet host; `font-src` allows Google Fonts' font host; `connect-src`/`img-src`/`object-src`/`base-uri`/`form-action`/`frame-ancestors` are locked down to `'self'` (plus `data:`/`blob:` for images, used by report generation).

### Registration

`POST /api/auth/register` creates a new user. It expects a JSON body with `name`, `employeeNumber` and `password` (all strings). `name` and `employeeNumber` must be non-empty after trimming, `employeeNumber` must be unique, and `password` must be at least 8 characters (checked on the raw, untrimmed value). Passwords are hashed with a salted `scrypt` (Node's built-in `crypto`) before storage — the plaintext is never stored, logged, or returned.

If `INVITE_CODE` is configured (required in production), the body must also include a matching `inviteCode` string; a missing/wrong one returns `403 {"error":"Invalid invite code"}`, checked **before** the duplicate-`employeeNumber` check so it can never be used to probe which employee numbers already exist. In production (`NODE_ENV=production`), a missing/invalid `INVITE_CODE` is fail-closed, not fail-open: the app refuses to start at all (`server/config.js`'s `assertProductionConfig()`, run when `server/app.js` is loaded), and as a second, independent guard the register handler itself also returns `503 {"error":"Registration is not configured"}` rather than silently accepting registrations without an invite code. The comparison uses `crypto.timingSafeEqual` over fixed-length sha256 hashes of both values (not the raw strings), so it can't leak the code's length or content via timing. Registration is also rate-limited per IP (`REGISTER_IP_MAX_ATTEMPTS` per `REGISTER_IP_WINDOW_MS`, default 10/hour); once hit, further attempts return `429 {"error":"Too many attempts. Try again later."}` with a `Retry-After` header until `REGISTER_IP_LOCK_MS` elapses.

```bash
curl -X POST http://localhost:3000/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{"name":"Ada Lovelace","employeeNumber":"EMP-001","password":"correct-horse-battery"}'
```

should return `201` with `{"id":1,"name":"Ada Lovelace","employeeNumber":"EMP-001"}`. Registering the same `employeeNumber` again returns `409`; missing/empty/too-short fields return `400`.

On Windows PowerShell, use single quotes around the JSON body and escape the inner double quotes, e.g.:

```powershell
curl.exe -X POST http://localhost:3000/api/auth/register -H "Content-Type: application/json" -d '{\"name\":\"Ada Lovelace\",\"employeeNumber\":\"EMP-001\",\"password\":\"correct-horse-battery\"}'
```

To verify what actually landed in the database (without ever printing a full password hash):

```bash
npm run db:users
```

which lists each user's `id`, `name`, `employeeNumber`, `createdAt`, and the `passwordHash`'s length/prefix only.

### Login

`POST /api/auth/login` checks an `employeeNumber`/`password` pair against a registered user. It expects a JSON body with both fields as strings; `employeeNumber` is trimmed before lookup (`password` is not). On success it also issues a JWT.

```bash
curl -X POST http://localhost:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"employeeNumber":"EMP-001","password":"correct-horse-battery"}'
```

should return `200` with `{"token":"<jwt>","user":{"id":1,"name":"Ada Lovelace","employeeNumber":"EMP-001"}}`. An unknown `employeeNumber` or a wrong `password` both return `401` with the identical body `{"error":"Invalid employee number or password"}` (this is intentional, to avoid revealing which case occurred); missing/empty/non-string fields return `400`.

The token is signed HS256, carries `sub` (the user id, as a string), `employeeNumber` and `name` as claims, and expires after `JWT_EXPIRES_IN` (default `8h`).

Login is rate-limited two ways, both DB-backed (never in-memory, so it holds across multiple stateless server instances): per `employeeNumber` (`LOGIN_EMP_MAX_ATTEMPTS` failures within `LOGIN_EMP_WINDOW_MS`, default 5/15min) and per IP (`LOGIN_IP_MAX_ATTEMPTS` within `LOGIN_IP_WINDOW_MS`, default 20/15min) — including an `employeeNumber` that isn't registered at all, so a locked-out unknown employee number also returns `429`, not `401`. Once locked, requests return `429 {"error":"Too many attempts. Try again later."}` with a `Retry-After` header (seconds) until the lock (`LOGIN_EMP_LOCK_MS` / `LOGIN_IP_LOCK_MS`) expires. A successful login resets that employee's failure counter. `req.ip` (used as the rate-limit key) is derived per `TRUST_PROXY` — see the environment variable table above.

**Trade-off:** the per-employee lock is keyed only on `employeeNumber`, which is not a secret — anyone who knows (or guesses) a valid employee number can deliberately lock that account for `LOGIN_EMP_LOCK_MS` (15 minutes by default) just by submitting a few wrong passwords for it, without needing to know anything else about the account. This is accepted as a reasonable trade-off for an invite-only internal tool with a small, known user base, where that risk is low and the alternative (no per-account lock) would make credential-stuffing a single account trivial. The per-IP limiter still bounds how many different employee numbers one source can hammer this way.

**`TRUST_PROXY` matters here:** if the app runs behind any reverse proxy or edge network (e.g. Vercel) and `TRUST_PROXY` is left at its default (`false`), `req.ip` resolves to the proxy's own address for every request, not the real client's — so the per-IP counter (and its rate-limit key) end up shared by *all* clients behind that proxy. In practice this means either everyone gets rate-limited together after a burst of unrelated traffic, or (depending on how the proxy is set up) the per-IP limit stops meaningfully distinguishing clients at all. Set `TRUST_PROXY` to the correct hop count (`1` on Vercel) whenever the app is not receiving connections directly.

On Windows PowerShell, use single quotes around the JSON body and escape the inner double quotes, e.g.:

```powershell
curl.exe -X POST http://localhost:3000/api/auth/login -H "Content-Type: application/json" -d '{\"employeeNumber\":\"EMP-001\",\"password\":\"correct-horse-battery\"}'
```

### Current user

`GET /api/auth/me` is protected — it requires an `Authorization: Bearer <token>` header with a token obtained from `/api/auth/login`. It returns `200` with `{"id":1,"name":"Ada Lovelace","employeeNumber":"EMP-001"}`. A missing/malformed/expired/invalid-signature token (or one for a since-deleted user) returns `401` with `{"error":"..."}` and a `WWW-Authenticate: Bearer` header.

```bash
TOKEN=$(curl -s -X POST http://localhost:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"employeeNumber":"EMP-001","password":"correct-horse-battery"}' | node -pe 'JSON.parse(require("fs").readFileSync(0)).token')

curl http://localhost:3000/api/auth/me -H "Authorization: Bearer $TOKEN"
```

On Windows PowerShell:

```powershell
$login = curl.exe -s -X POST http://localhost:3000/api/auth/login -H "Content-Type: application/json" -d '{\"employeeNumber\":\"EMP-001\",\"password\":\"correct-horse-battery\"}' | ConvertFrom-Json
curl.exe http://localhost:3000/api/auth/me -H "Authorization: Bearer $($login.token)"
```

## Reports

Once a log is loaded, the **Generate report** button in the header (next to **Open another log**) opens a small menu with two options:

- **Log Summary** — total events, unparsed line count, the analysis time range, a table of devices (with per-device event/incident counts), the severity 0–7 breakdown, and a table of every incident (sorted by first seen) with a brief summary for each.
- **Detailed Incident** — the currently selected incident's title, kind, device, interface/peer/source, processes, summary, severity distribution, and its *complete* timeline (every event, no 300-event cap), including each event's gap from the previous one, severity, process, message and raw line. Disabled (with a "Select an incident first" hint) until an incident is selected.

Both reports are generated entirely in the browser and downloaded as a single, self-contained `.html` file (inline CSS, no external fonts or scripts, no network requests) — nothing about the log ever leaves the page. Filenames look like `syslog-lens-summary-<source>-<timestamp>.html` and `syslog-lens-incident-<incident>-<timestamp>.html`. Reports use a dark theme on screen and switch to a light, ink-saving theme (severity colours and labels preserved) when printed.

## Deploying to Vercel

The app deploys to [Vercel](https://vercel.com) as a single Express [Vercel Function](https://vercel.com/docs/functions/runtimes/node-js), backed by [Neon](https://neon.tech) Postgres instead of SQLite. It does **not** use Vercel's zero-config Express Framework Preset — see below for why, and make sure the dashboard's Framework Preset is set to **"Other"** (`vercel.json`'s `"framework": null` enforces this even if the dashboard is later changed by mistake).

### How the deployment is wired up

- **Why not the zero-config Express preset:** that preset looks for the app entry file (`app.js`/`index.js`/`server.js`, [conventional locations](https://vercel.com/docs/frameworks/backend/express#exporting-the-express-application)) *inside* the project's Output Directory. This repo's Output Directory is deliberately empty (see below), so the preset fails outright with `Error: No entrypoint found in output directory`. `vercel.json` sets `"framework": null`, which the [vercel.json reference](https://vercel.com/docs/project-configuration/vercel-json#framework) documents as the way to select "Other" ("To select 'Other' as the Framework Preset, use `null`") — this overrides the dashboard's Framework Preset setting, so an auto-detected or manually-selected Express preset there can't reintroduce the failure.
- **Entry point:** `api/index.js` is a plain Node.js [Vercel Function](https://vercel.com/docs/functions/runtimes/node-js) that re-exports the Express app from `server/app.js`. `server/index.js` (used by `npm start`) is unaffected and still does its own `app.listen()`.
- **Routing every request through it:** `vercel.json` has a single catch-all rewrite, `"^/(.*)$"` → `"/api?__path=$1"`, so every path (`/`, `/login`, `/auth.js`, `/api/auth/login`, everything) reaches `api/index.js`. **Preserving the original path across the rewrite:** the [vercel.json rewrites reference](https://vercel.com/docs/project-configuration/vercel-json#rewrites) documents that a rewrite's *destination* is what the target actually receives — its own example rewrites `/resize/:width/:height` to `/api/sharp` and shows the result as `/api/sharp?width=800&height=600` (the captured path segments become query parameters, not extra path segments), and a separate example on the same page shows a regex capture group (`$1`) can be substituted into the destination, including into its query string. So the rewrite above hands `api/index.js` a request whose `req.url` is `/api` plus a `__path` query parameter holding the path the browser actually requested. `api/index.js` reads `req.query.__path` (one of the Node.js helper properties [Vercel populates on the request object](https://vercel.com/docs/functions/runtimes/node-js#node.js-helpers)), reassembles the real `req.url` (path plus any other query parameters), and only then hands the request to the Express app — see the comments in `api/index.js` and the tests in `test/vercel-entry.test.js` for the exact reassembly logic and its coverage (root path, nested paths, preserved query parameters, and an end-to-end HTTP request that resolves `/login` correctly).
- **Database:** if `DATABASE_URL` is set, `server/db.js` uses Sequelize's `postgres` dialect (via `pg`/`pg-hstore`) with SSL required and a small pool (`max: 2`) sized for a serverless function rather than a long-running process. Unset, it falls back to SQLite exactly as before. `sqlite3` is only ever `require()`'d on the SQLite path, and is listed as an `optionalDependency` — its native build can't fail Vercel's `npm install`, and the Postgres path never has to load it.
- **Schema:** there's no separate migration step. `sequelize.sync()` (no `force`/`alter`) runs the same way it always has, but on Vercel there is no startup hook to run it before the first request, and a function instance can be reused across many requests — so `server/middleware/ensureDbSynced.js` runs it lazily, caching the in-flight promise so it happens at most once per instance. If it fails, that request gets a `503` and the *next* request retries (the failure isn't cached).
- **Why `syslog-lens.html` can't be a static file:** Vercel's docs state that files in the project's Output Directory (default `public`, or `.`) are served directly from its CDN, and that "precedence is given to the filesystem prior to rewrites being applied" ([vercel.json reference](https://vercel.com/docs/project-configuration/vercel-json#outputdirectory)) — a matching static file is served *before* any rewrite or function runs, meaning before `requirePage`'s auth check ever executes. The Express docs separately confirm that a zero-config Express deployment serves anything under `public/**` the same CDN-first way ([Express on Vercel — Serving static assets](https://vercel.com/docs/frameworks/backend/express#serving-static-assets)). Since this repo's own `public/` holds the login/register pages — which still need helmet's CSP/HSTS from Express, not the CDN's default headers — `vercel.json` sets `outputDirectory` to `.vercel-empty-output/`, a directory that is checked into the repo and guaranteed to contain no files. With nothing there to match, every request (`/`, `/syslog-lens.html`, `/login`, `/register`, `/auth.css`, `/api/*`, everything) always falls through to the Express function, which is the only place auth and security headers are enforced. `test/vercel-config.test.js` asserts this directory stays empty and that `outputDirectory` isn't `public` or `.`.
- **`includeFiles`:** `syslog-lens.html` and `public/**` are read via `fs`/`express.static()`/`res.sendFile()` at runtime, not via a static `require()` — Vercel's dependency tracer can't see those, so `vercel.json`'s `functions["api/index.js"].includeFiles` force-includes them in the deployed function bundle.

### Checklist

1. **Link the repo.** [Import the project](https://vercel.com/new) into Vercel from GitHub (or run `vercel link`). When Vercel asks for a Framework Preset, either leave it as "Other" or don't worry if it guesses "Express" — `vercel.json`'s `"framework": null` forces "Other" regardless of what the dashboard shows.
2. **Add Postgres.** From the project's Vercel dashboard, add the [Neon integration](https://vercel.com/marketplace/neon) (or any Postgres add-on) with the environment variable prefix set to `DATABASE` — this is what makes the integration populate `DATABASE_URL` (rather than some other prefix) automatically. You don't need to type it in.
3. **Set the remaining environment variables** (Project Settings → Environment Variables, for both Production and Preview). **Do not use Vercel's "Import .env" option and do not paste in values from your local `.env` or from `.env.example`** — `.env.example`'s secrets are left blank on purpose (see the comments in that file), and a real local `.env`'s values are for local development only, not production:

   | Variable | Value | How to generate |
   |---|---|---|
   | `DATABASE_URL` | *(set automatically by the Neon integration, prefix `DATABASE`)* | — |
   | `JWT_SECRET` | a random string, ≥32 characters | `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"` |
   | `INVITE_CODE` | a random string, ≥12 characters | `node -e "console.log(require('crypto').randomBytes(9).toString('base64url'))"` |
   | `COOKIE_SECURE` | `true` | Vercel always serves over HTTPS, so this should always be `true` in Production/Preview — never leave it at the local-dev default of `false`. |
   | `TRUST_PROXY` | `1` | Vercel places exactly one proxy (its edge network) in front of your function. `1` means "trust exactly one hop", which makes `req.ip` the address that edge actually observed — not whatever a client puts in its own `X-Forwarded-For` header (see `test/trust-proxy.test.js`), and not the edge's own address for every request (the failure mode if this is left at its `false` default). |

   `assertProductionConfig()` (`server/config.js`) fails closed at startup if `JWT_SECRET`/`INVITE_CODE` are missing, too short, or still contain placeholder text like `replace-this` or `change-me` — so a value accidentally copied from `.env.example` won't silently deploy.

   The login/register rate-limit variables (`LOGIN_EMP_MAX_ATTEMPTS`, etc.) are optional — the defaults documented above apply if you don't set them.
4. **Redeploy** (Vercel redeploys automatically on the next push once these are set; trigger one manually from the dashboard if needed).
5. **Run the smoke check** against the deployed URL:

   ```bash
   npm run smoke -- https://<your-project>.vercel.app
   ```

   This confirms, from the outside, that logged-out visitors get redirected instead of served the app, that nothing outside `public/` is reachable, and that the login/register pages carry the real security headers (not the CDN's defaults).
6. **Turn on branch protection.** In the GitHub repo's Settings → Branches, add a protection rule for `main` requiring the `CI / test` check (from `.github/workflows/ci.yml`) to pass before merging.

### CI/CD

- `.github/workflows/ci.yml` runs the full test suite (`npm test`) on every pull request and push to `main`, on Ubuntu with the Node version pinned in `package.json`'s `engines` field, with Playwright's Chromium browser cached between runs.
- Actual deployments are handled by Vercel's own Git integration: every pull request gets a Preview Deployment, and pushes to `main` deploy to Production — no separate deploy workflow is needed. To smoke-test a PR's preview deployment, run `npm run smoke -- <preview-url>` manually (its URL is posted by the Vercel bot on the PR) until that's wired into CI.

## Project files

| Path | Purpose |
|---|---|
| `syslog-lens.html` | The whole app: HTML, CSS and JS in one file. Served by the backend at `/` and `/syslog-lens.html`, protected by login. |
| `public/` | Public login/register pages and their shared assets (`login.html`, `register.html`, `auth.css`, `auth.js`) |
| `api/index.js` | Vercel entry point — a Node.js function that restores the original request path (see "Deploying to Vercel" above) and re-exports the Express app from `server/app.js`. Not used for local dev; that's `server/index.js`. |
| `vercel.json` | Vercel deployment config: forces the "Other" Framework Preset, keeps static serving out of the CDN's way, rewrites every path to `api/index.js`, and bundles `syslog-lens.html`/`public/**` into the function. |
| `scripts/smoke.js` | Dependency-free smoke check for a deployed (or local) instance — `npm run smoke -- <url>`. |
| `test/` | Automated tests |
| `test-data/` | Synthetic sample log and the incident groupings it should produce |
| `server/` | Backend (Express + Sequelize/SQLite or Postgres): auth, page guards, DB sync, and static serving |
| `.github/workflows/ci.yml` | CI: runs the test suite on every PR and push to `main` |
| `HANDOFF.md` | Design decisions, known limitations and next steps |
