# Syslog Lens

A browser-based tool for troubleshooting network syslogs. Upload or paste a log to browse events by severity and inspect incidents with a summary and timeline. All parsing happens in your browser, and nothing is uploaded.

## Using the app

No installation needed. Open `syslog-lens.html` in any modern browser. To try it without your own log, click **Try a sample log**.

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

## Backend (in progress)

A small Express + SQLite backend is being added under `server/` to support future authentication. Stage 1 added the foundation: a database connection, a `User` model, and a health-check endpoint. Stage 2 adds user registration. Stage 3 adds login (credential check only). Stage 4 adds JWT-based authentication: login now issues a token, and a protected `/api/auth/me` endpoint returns the current user. There is no frontend integration yet.

**Setup:**

```bash
npm install
cp .env.example .env
```

`.env` controls `PORT` (default `3000`), `DB_STORAGE` (default `server/data/syslog-lens.sqlite`, created automatically if missing), `JWT_SECRET`, and `JWT_EXPIRES_IN` (default `8h`).

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
| `syslog-lens.html` | The whole app: HTML, CSS and JS in one file |
| `test/` | Automated tests |
| `test-data/` | Synthetic sample log and the incident groupings it should produce |
| `server/` | Backend (Express + Sequelize/SQLite), currently just the Stage 1 foundation |
| `HANDOFF.md` | Design decisions, known limitations and next steps |
