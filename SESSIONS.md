# Session log

One entry per work session, newest last. For design decisions and current limitations, see `HANDOFF.md`. For setup, see `README.md`.

**How work is run:** Claude Opus orchestrates (design, planning and review) and Claude Sonnet agents write the code. Each job gets a fresh agent with a short brief. Opus reviews every job, re-runs `npm test` and either passes it or sends it back.

**Background:** the first prototype (`syslog-lens.html`, the synthetic test data and `HANDOFF.md`) was built earlier in claude.ai on a separate account, then imported into this folder.

---

## Session 1: 2026-09-24

**Goal:** import the prototype, add a test safety net, then make the quick fixes and the grouping improvements.

### Decisions
- Stack: static single-file HTML/JS with no server or build step, which must also work when opened via `file://`.
- v1 scope: paste or upload logs, filter and search, and a timeline.
- Jobs run one after another, not in parallel, because they all edit the same HTML file.
- Accepted trade-off: interface-name matching is now case-sensitive (see Job C).

### Work done

| Job | What changed | Tests | Review |
|---|---|---|---|
| **A: tests** | Renamed `Syslog Lens.html` to `syslog-lens.html` and fixed the file names in `HANDOFF.md`. Added `npm test` (node:test with jsdom, plus a Playwright UI smoke test). Tests load the real app file through a one-line `window.SyslogLens` hook. | 12/12 | Passed. No app bugs found. |
| **B: quick fixes** | "Try a sample log" now loads the real 84-event sample, embedded in the HTML, with a test that fails if it drifts from the log file. Severities guessed from keywords show a "guessed" tag with a tooltip and screen-reader label. Removed unused CSS. The pane width is remembered in `localStorage`, safely. | 19/19 | Passed. Log text is still escaped (checked for code injection). |
| **Docs** | Added `README.md` with how to use the app and the first-time test setup. | n/a | Written by Opus. |
| **C: copy fix, rules and grouping** | The "guessed" tag is no longer copied along with the raw lines. Incident types now live in a declarative `INCIDENT_RULES` array, and their titles and summaries are locked by a test. Grouping is stricter: a shared process name alone no longer links events. The edge-fw01 and dhcp01 false merges are fixed, and all 8 expected incidents are unchanged. | 22/22 | Passed, with the trade-off below. |

### Known trade-off introduced
Interface matching (`IFR` regex) is now case-sensitive, to stop free text like "via vlan20" counting as an interface. As a result, lowercase interface names such as `eth0` and `vlan20` aren't recognised. Juniper-style names like `ge-0/0/0` never were. To fix together with the log-format work.

### State at end of session
- 22/22 tests passing.
- Files: `syslog-lens.html`, `test/`, `test-data/`, `README.md`, `HANDOFF.md`, `SESSIONS.md`, `package.json`.

### Next up
1. **Item 4, formats and time:** a UTC/local time toggle; support for Cisco sequence-number prefixes, IPv6 and lowercase or Juniper interface names.
2. Remaining next steps from `HANDOFF.md`: a "key moments" timeline view, testing with real and large logs, dark theme, mobile and screen readers, and exporting an incident summary.

---

## Session 2: 2026-09-24

**Goal:** add support for more log formats, then turn Syslog Lens into a full-stack app with employee login, one small stage at a time.

### Decisions
- **Architecture change:** the app gets an Express backend for users and authentication. Log parsing stays entirely in the browser, so log data is still never uploaded.
- **Passwords:** hashed with Node's built-in `crypto.scrypt`, salted, with no native dependency. At least 8 characters.
- **Tokens:** JWT (HS256) sent in an `Authorization: Bearer` header and valid for 8 hours. Whether to switch to an httpOnly cookie is still open and will be decided with the frontend login screen.
- **Identity caveat:** anyone can register with any employee number, so it isn't verified. An approved-employee list could be added later if that matters.
- **Paused:** the downloadable incident report. The spec is agreed and waiting for its turn.
- **Git:** repo created and pushed to https://github.com/quppiehy/syslog-lens. `.env`, the SQLite database, `node_modules/`, `dist/` and `build/` are never committed, and LF line endings are enforced via `.gitattributes`. Opus commits after each approved stage and pushes only when asked.

### Work done

| Job | What changed | Tests | Review |
|---|---|---|---|
| **D: formats and time** | Cisco IOS lines, with or without a sequence number or `<PRI>`; severity comes from the `%FAC-SEV-MNEMONIC` tag and isn't flagged as guessed. IPv6 addresses are used for grouping. Lowercase, Linux and Juniper interface names are recognised, but only after "interface" or "port". A UTC/local time toggle was added (remembered, default local). New fixture: `test-data/formats.log`. | 36/36 | Passed |
| **Auth stage 1: backend foundation** | Express + Sequelize + SQLite in `server/`. User model: id, name, employeeNumber (unique), passwordHash and timestamps. `GET /api/health`, `.env.example`, `npm start`, `npm run db:check`. | 36/36 | Passed |
| **Auth stage 2: registration** | `POST /api/auth/register` returns 201 `{id, name, employeeNumber}`, 400 for invalid input and 409 for a duplicate (including simultaneous duplicate sign-ups). Fields are trimmed and the hash is never returned. Added `npm run db:users`. | 56/56 | Passed |
| **Auth stage 3: login** | `POST /api/auth/login` returns 401 with the same response for an unknown employee or a wrong password, and runs a dummy-hash check so timing doesn't reveal which. Password hashing and checking are now async. | 74/74 | Sent back once: login still verified synchronously. Passed after the fix. |
| **Auth stage 4: JWT** | Login returns `{token, user}`. `requireAuth` middleware and `GET /api/auth/me` added. The server refuses to start without a `JWT_SECRET` of at least 32 characters. Forged, expired, `alg: none` and deleted-user tokens get a 401. | 87/87 | Passed |

### Known limitations introduced
- Cisco lines without a hostname share the placeholder host `unknown-host`, so they could group together.
- For Cisco timezones, only `UTC` and `GMT` are understood; any other label is read as local time.
- `enp0s3`-style interface names aren't recognised, and a bare `::` or `::1` address could link unrelated events.
- npm audit reports warnings in `sqlite3`'s install-time tools (tar, node-gyp) and in `uuid` inside Sequelize. None of this code runs while the app is serving requests. Revisit before any deployment.

### State at end of session
- 87/87 tests passing. The backend runs with `npm start`, and the frontend is not yet connected to it.
- Restart `npm start` after each backend change, because Node doesn't reload code automatically.

### Next up
1. Frontend login and registration screens, with the app shown only to logged-in users. Also decide Bearer header vs httpOnly cookie.
2. Downloadable incident report (spec agreed).
3. Optionally: record who used the app and when, which was the original reason for adding login.

---

## Session 3: 2026-09-24

**Goal:** connect the frontend to login, add downloadable reports, then prepare for public deployment on Vercel with CI/CD.

### Decisions
- **Server-enforced access:** Express serves `syslog-lens.html` only when the request carries a valid JWT in an httpOnly, SameSite=Strict cookie (`sl_token`); otherwise it redirects to `/login`. The app stays plain HTML/JS with no React or router.
- **Reports** are generated entirely in the browser from the app's existing parsed data, with no second parser. They include "Generated by <name> (<employee no.>)" and the date and time with timezone.
- **Git workflow:** each feature gets its own `feature/<name>` branch. Opus commits after each review and pushes only when asked, and the user merges through GitHub pull requests.
- **Review:** every stage is reviewed with `/code-review` at high effort, with security checks for auth, input and file-serving changes.
- **Hosting:** Vercel with Neon Postgres. Dev and tests stay on SQLite. The app will be on the public internet, so it's hardened first: an invite code to register, login rate limiting and security headers.

### Work done

| Job | What changed | Tests | Review |
|---|---|---|---|
| **Stage 5: login UI** | `public/login.html` and `register.html`, the cookie-based page guard, `POST /api/auth/logout`, `no-store` caching, a 404 catch-all (so project files are never served), a user badge and Logout button in the header, and a back-button check | 104/104 | Passed. Merged as PR #1. |
| **Download report** | A "Generate report" menu offering a **Log Summary** (whole log) or a **Detailed Incident** (selected incident, full timeline and raw lines) as a self-contained `.html` file. The time-gap calculation now lives in one shared function (`gapInfo()`) used by both the timeline and the report. | 128/128 | Round 1: 7 findings fixed (name escaped twice, report missing the user's name if made too soon after page load, filename timezone, 4 cleanups). Round 2: an expired session still downloaded a report; fixed. |
| **Header restyle** | "Download report" is now the main (accent) button; the timezone and theme toggles are grouped; a user chip plus Log out; better dark-mode contrast and focus rings; icons only on narrow screens | 128/128 | Passed. Merged with the report as PR #2. |
| **Deploy Stage A: hardening** | Invite code (`INVITE_CODE`) required to register. Login and registration rate limits stored in the database (`LoginAttempt` model): 5 failures per employee or 20 per IP in 15 minutes gives a 15-minute lock, returned as 429 with `Retry-After`. helmet security headers, and a CSP built from hashes of the inline scripts (no `unsafe-inline` for scripts). | 158/158 | Review found 5 issues: 3 fixed and 1 documented (see below); the TRUST_PROXY finding moved to Stage B. The fix round also fixed an SQLite `busy_timeout` problem that the new concurrency test exposed. |

### Stage A review findings
1. The invite-code check failed open when `INVITE_CODE` was missing on serverless. Now fixed: registration is blocked if the code isn't set, and the config is checked when the app loads.
2. The rate limiter's handling of a duplicate insert would have crashed on Postgres. Now fixed: it uses an insert that is safe on both SQLite and Postgres, plus a concurrency test.
3. The `login_attempts` table grew forever. Now fixed: stale rows are pruned occasionally.
4. Per-employee lockout can be triggered by anyone who knows the number. Documented as an accepted trade-off.
5. On Vercel, `TRUST_PROXY` must be set, or every client shares one IP key and 20 failures lock out everyone. To handle in Stage B.

### State at end of session
- `main` has Stage 5, the reports and the header restyle (PRs #1 and #2).
- Stage A is committed on `feature/deploy` but not pushed or merged.
- The user has a Vercel account and created a Neon database (`syslog-lens-db`) through Vercel Storage. The GitHub repo is deliberately **not linked** to Vercel yet, so nothing deploys before Stage B.

### Next up
1. **Stage B: Vercel + Neon.** Use Postgres through `DATABASE_URL`; add a Vercel serverless entry point and `vercel.json`; make sure `syslog-lens.html` is never served as a static file; set `TRUST_PROXY`; add a post-deploy smoke check.
2. **Stage C: CI/CD.** A GitHub Actions workflow running `npm test` with Playwright on every PR, Vercel preview and production deploys, and branch protection on `main`.
3. **User checklist after B:** link the repo in Vercel; confirm `DATABASE_URL`; set `JWT_SECRET`, `INVITE_CODE`, `COOKIE_SECURE=true` and `TRUST_PROXY`.

---

## Session 4: 2026-09-25

**Goal:** finish the Vercel deployment and CI/CD, then improve log-format coverage and incident correlation based on real-world Cisco samples.

### Decisions
- **Hosting:** Vercel with the "Other" preset and a single Express function, `api/index.js`. A path-to-regexp rewrite sends every path to it, and the output directory is deliberately empty, so the CDN can never serve `syslog-lens.html` or skip Express's login check and security headers.
- **Database:** Neon Postgres connected through Vercel Storage with the prefix `DATABASE` (giving `DATABASE_URL`), plus a database branch per preview deployment. Certificates are verified (`rejectUnauthorized: true`).
- **Runtime:** Node 24.x for CI and Vercel, because jsdom 30 needs Node 22 or later.
- **Secrets:** generated by the user and stored only in Vercel. `.env.example` placeholders are blank, and production refuses placeholder-looking values.
- **Format fixtures** are our own synthetic lines in each vendor's exact format; nothing is copied from licensed sources, since the repo is public.
- **Correlation principle (the user's rule):** never merge on "same device + same thing" alone without a time bound. Down/recovery pairing is capped at 1 hour; related incidents get a hint but aren't merged.
- **Parallel agents** run in isolated git worktrees when they would touch the same file. `.claude/worktrees/` is gitignored.

### Work done

| Job | What changed | Tests | Review |
|---|---|---|---|
| **Deploy Stages B + C** | Postgres when `DATABASE_URL` is set (SQLite for dev and tests); sync-once middleware; `TRUST_PROXY`; `npm run smoke -- <url>`; GitHub Actions CI (Node 24, Playwright) | 176/176 | 3 findings fixed: Neon TLS verification was off, the smoke check missed CDN-served static files, and CI had a hard-coded secret-like value |
| **CI fix** | `engines.node` changed from 20.x to 24.x | 176/176 | CI green |
| **Vercel fixes (PRs #4–#6)** | Express preset conflict → `framework: null` + `api/index.js` with a catch-all rewrite and a hardened `__path` shim; rewrite changed from `^/(.*)$` to `/:path*`; an explicit root `/` rewrite | 195/195 | Found by probing production: Vercel-level 404s, then a crash from an `INVITE_CODE` under 12 characters, which the user fixed |
| **Live** | https://syslog-lens.vercel.app | smoke 13/13 | All checks pass |
| **Cisco collector format** | `CSC2`: `timestamp host %TAG:` layout; `SEC_LOGIN` failures count as authentication incidents | 204/204 | The user's 58-line sample went from 0 to 58 lines parsed |
| **Vendor format library (PR #7)** | Fixtures for Cisco IOS, IOS-XE, NX-OS and ASA, Junos (RFC 3164 and 5424) and FortiGate key=value; `#` comment lines skipped; Cisco interface names normalised for grouping; a hint when 20% or more of lines are unrecognised | 229/229 | 4 findings fixed: FortiGate time was treated as UTC, microsecond `eventtime` was misread, `devname=` detection was too loose, and Junos `ifName` wasn't grouped |
| **Auth summary count (PR #8)** | A vendor-neutral `isAuthFailure()`; the Cisco sample now says 5 failed logins instead of 0 | 234/234 | Passed |
| **Outage correlation (PR #9)** | A DOWN pairs with its recovery for the same host and resource (interface, OSPF neighbour or BGP peer) up to 1 hour apart; "Interface down/flap — X" titles; outage-duration summaries; "Possibly related" hints that don't merge incidents | 246/246 | 3 findings fixed: the generic "X is down" fallback paired unrelated events, a late recovery was wrongly reported as "no recovery", and related hints were O(n²) |
| **UI contrast (PR #10)** | Dark-mode form fields visible, with placeholders and a focus ring; strong selected-severity and selected-incident highlights. The severity highlight had been silently dropped by a CSS variable-scope bug. | 234/234 (246 on `main` after merge) | Two rounds against the user's screenshots |

### Other notes
- A GitGuardian alert on `test/auth-register.test.js` (`never-leak-me-123`) was a false positive (a test fixture). No real secret was ever committed.
- The UI agent's leftover worktree folder `.claude/worktrees/agent-a2ddbeee8b70659d6` couldn't be deleted (permission denied while in use). It's gitignored; delete it by hand later.

### State at end of session
- `main` has PRs #1–#10, and https://syslog-lens.vercel.app passes the smoke check.
- 246/246 tests pass on `main`.

### Next up
1. **Repeat grouping (queued):** merge identical messages from the same host within the 300-second chain window, cap a chain at about 1 hour in total, and add "×N" titles.
2. **Incident noise:** rank or fold single low-severity events. The messy sample produces 71 incidents.
3. **Branch protection** on `main`, requiring the `test` check, if not already done.
4. **Minor:** a favicon, and removing the `url.parse` deprecation warning (DEP0169).
