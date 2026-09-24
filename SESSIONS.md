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
