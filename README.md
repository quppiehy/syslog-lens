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

**Requirements:** [Node.js](https://nodejs.org/) 18 or later.

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

`.env` controls `PORT` (default `3000`), `DB_STORAGE` (default `server/data/syslog-lens.sqlite`, created automatically if missing), `JWT_SECRET`, `JWT_EXPIRES_IN` (default `8h`), and `COOKIE_SECURE` (default `false`; set `true` when serving over HTTPS so the auth cookie is marked `Secure`).

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

### Registration

`POST /api/auth/register` creates a new user. It expects a JSON body with `name`, `employeeNumber` and `password` (all strings). `name` and `employeeNumber` must be non-empty after trimming, `employeeNumber` must be unique, and `password` must be at least 8 characters (checked on the raw, untrimmed value). Passwords are hashed with a salted `scrypt` (Node's built-in `crypto`) before storage — the plaintext is never stored, logged, or returned.

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

## Project files

| Path | Purpose |
|---|---|
| `syslog-lens.html` | The whole app: HTML, CSS and JS in one file. Served by the backend at `/` and `/syslog-lens.html`, protected by login. |
| `public/` | Public login/register pages and their shared assets (`login.html`, `register.html`, `auth.css`, `auth.js`) |
| `test/` | Automated tests |
| `test-data/` | Synthetic sample log and the incident groupings it should produce |
| `server/` | Backend (Express + Sequelize/SQLite): auth, page guards, and static serving |
| `HANDOFF.md` | Design decisions, known limitations and next steps |
