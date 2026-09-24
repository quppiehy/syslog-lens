# Syslog Lens: handoff summary

Networking troubleshooting web app. Upload or paste a syslog, parse it locally in the browser, browse events by RFC 5424 severity (0-7), open an incident, and read its summary and timeline.

Live prototype: https://claude.ai/artifact/VmgAh1g5m99FEviJtfRq9c

## Features

- **Input:** upload a `.log`, `.txt` or `.syslog` file, or paste text. Parsing runs in the browser and nothing is uploaded.
- **Formats:** RFC 5424 and RFC 3164, with or without a `<PRI>` prefix; and Cisco IOS-style messages (`%FACILITY-SEV-MNEMONIC`), with an optional sequence-number prefix, an optional `*`/`.` freshness marker, an optional hostname, an optional timezone abbreviation, and with or without a `<PRI>`. Lines that can't be parsed are counted and viewable.
- **Severity rail:** levels 0-7 with event counts. Empty levels are dimmed.
- **UTC/local time toggle:** a header button (next to Theme) switches every displayed timestamp between the viewer's local time and UTC. Labelled "Local (UTC±H)" or "UTC". Defaults to local; the choice is remembered in `localStorage` (best-effort, every access wrapped in try/catch). See "Time handling" below for how parsing and display relate.
- **Incident list:** each card shows a plain title (for example "BGP disruption — peer 198.51.100.2"), device, event count, duration and a severity breakdown. A filter box narrows the list.
- **Incident detail:**
  - Pinned header with incident name, device and interface/peer/source.
  - Collapsible sections: Incident summary, Event overview, Timeline, Raw event details.
  - Collapse all / Expand all button.
  - Defaults: summary, overview and timeline open; raw details closed.
- **Timeline:** every event with its severity, the gap between events (vertical spacing grows with the gap), and a per-event "raw line". Events at the selected severity are highlighted. Events whose severity had no `<PRI>` (guessed from keywords) carry a visible "guessed" tag with a title/aria-label, next to the severity in the timeline and next to the raw line in Raw event details — never colour alone. In Raw event details the tag is `user-select:none`, so selecting/copying the raw lines copies only the raw log text, not the tag.
- **Layout:** the divider between the list and detail panes can be dragged or moved with the keyboard (arrow keys, Home, End). The left rail is fixed at 250px. Minimum widths are 260px (list) and 380px (detail). Mobile (900px and under) uses a step-by-step drill-down. The chosen divider width is remembered in `localStorage` between visits (best-effort: every access is wrapped in try/catch, and the app works the same if storage is unavailable).

## File structure

```
syslog-lens.html                      Whole app: CSS, HTML and JS in one file
test-data/network-incidents.log       84 synthetic RFC 5424 events, labelled as synthetic test data
test-data/expected-incidents.json     Expected groupings. Development/testing only, never shown to end users
test/                                 Automated tests (see Testing below)
package.json                          Test dependencies and the `npm test` script
HANDOFF.md                            This file
```

Notes:
- The "Try a sample log" button loads `network-incidents.log`, embedded verbatim in `syslog-lens.html` as the `SAMPLE_LOG` constant (fetch() can't read local files under `file://`). `test/sample-log.test.js` asserts the embedded copy is byte-identical to the source file so they can't drift.
- Every line in `network-incidents.log` has structured data `[synth@32473 eid="E0xx" synthetic="true"]`. The `eid` is a test-only event ID and must not be used for grouping.
- `test-data/formats.log` is a second, smaller fixture (added for the log-format work below) covering Cisco IOS lines, IPv6 addresses and lowercase/Juniper/Linux interface names. It's separate from `network-incidents.log`/`expected-incidents.json` on purpose, so the Session 1 grouping-rule tests keep asserting against an unchanged baseline.

## Design decisions

- **Interaction model:** a three-pane funnel (severity, then incident, then timeline). The app is a lens over log noise, not a dashboard.
- **Look:** IBM Plex Sans and Mono, light/dark theme via CSS variables, and a red-to-grey severity ramp. The number and name always accompany the colour.
- **Grouping rule:** events on the same device form one incident if consecutive events (at most 300 seconds apart) share an interface name or an IP address, OR both individually match the same incident-type rule (see below). A shared process name alone is no longer enough — see `ruleOf()` and `keys()` in `syslog-lens.html`. Links are chained, so a later event can join two earlier groups. An incident appears under every severity it contains.
- **Titles and summaries:** deterministic, built from `INCIDENT_RULES` in `syslog-lens.html` (a declarative array: match criteria + a title/summary builder per type), with no AI. A note in the pane says it describes the events and is not a diagnosis. `ruleOf()` reuses the same rules' match criteria per-event for grouping.
- **Incident types with tailored wording:** BGP disruption, OSPF adjacency flap, repeated authentication failures. Everything else gets a generic title (the last, always-matching entry in `INCIDENT_RULES`). Adding a new tailored type means adding one entry to that array.
- **Sections:** native `<details>`/`<summary>` elements, so keyboard use and open/closed state come for free. The section state carries over between incidents.
- **Resizing:** pure CSS clamps handle minimum widths, so shrinking the window can't squash the detail pane. The divider is a `role="separator"` element with arrow-key support.
- **Scrolling:** columns scroll on their own, and the detail pane has no nested scroll boxes.
- **Cisco IOS parsing (`CSC` in `syslog-lens.html`):** matches an optional sequence number (`000123: `), an optional hostname (a single token immediately followed by `: `), an optional `*`/`.` freshness marker, the `Mon Day HH:MM:SS` timestamp with optional fractional seconds, an optional timezone abbreviation, then `%FACILITY-SEV-MNEMONIC: message`. Tried after the RFC 5424 attempt but *before* RFC 3164, because a bare Cisco line with no sequence number or hostname (`Sep 24 03:14:02.114 UTC: %OSPF-5-ADJCHG: ...`) otherwise starts exactly like an RFC 3164 line and would be misparsed by that regex (its `.114`/`UTC` token would be read as the RFC 3164 "host"). The facility becomes the process name; the severity digit (0-7, the same scale as syslog) is used directly and **not** marked `guessed` when there's no `<PRI>` — a `<PRI>`, when present, still wins (matching existing RFC 3164/5424 behaviour). A Cisco line with no hostname gets the placeholder host `unknown-host`; since the log gives no way to tell two such hostless devices apart, multiple hostless Cisco devices in one file will be grouped as if they were one device (documented limitation, not fixed).
- **Lowercase/Juniper/Linux interface names (`IFR2`):** kept as a *separate* regex from the existing capitalised `IFR`, gated by a lookbehind requiring `interface ` or `port ` immediately before the name (e.g. "Interface eth0", "interface ge-0/0/0", "port gi0/1"). This context requirement is the fix for the Session 1 trade-off: without it, a general-purpose lowercase interface pattern would also match "via vlan20" in `network-incidents.log`'s dhcp01 lines (`vlan` is a valid interface prefix), re-breaking the false-merge fix from Job C. Gating on a preceding "interface"/"port" keyword recognises real interface mentions while leaving casual prose alone. Trade-off: a lowercase name with *no* such lead-in (e.g. a bare "eth0 down" with no "Interface"/"port" before it) isn't recognised — narrower than the capitalised `IFR`, which matches anywhere.
- **IPv6 grouping (`IP6R`):** matches full 8-group addresses and `::`-compressed addresses. No extra filtering is needed to keep these apart from HH:MM:SS timestamps (3 groups) or MAC addresses (6 groups, single colons only): the full form requires exactly 7 colons (8 groups), and the compressed form requires a literal `::`, neither of which a timestamp or a MAC address ever has.
- **Time handling:** RFC 3164 and Cisco IOS lines with no explicit timezone are parsed as the *viewer's* local time (via the local `Date` constructor), same as before. A Cisco line with an explicit `UTC`/`GMT` timezone is parsed as UTC instead (`Date.UTC(...)`), regardless of the viewer's own timezone; other timezone abbreviations aren't recognised and fall back to local-time parsing (a rare case in practice; not fixed). RFC 5424's own timestamp always carries an explicit offset and is unaffected. Once parsed, every timestamp is a single absolute instant; the UTC/local toggle only changes how `fmt()` *displays* that instant (via `Intl`'s `timeZone: 'UTC'` option or the platform default), it never reparses anything.

## Known limitations

- **Grouping is still heuristic.** It no longer links purely on a shared process name, but a shared interface or IP address (or two events independently matching the same incident-type rule) can still merge genuinely unrelated events in principle. `expected-incidents.json` deliberately doesn't assert most background groupings; `test/incident-rules.test.js` locks in the two specific false merges (edge-fw01 config save/connection summary, and the two dhcp01 acknowledgements) that used to happen and now don't.
- **Only three incident types** have tailored titles and summaries.
- **Parsing:**
  - RFC 3164 and Cisco IOS lines have no year, so the current year is assumed.
  - A hostless Cisco IOS line (no hostname in the log itself) is given the placeholder host `unknown-host`; several hostless Cisco devices in the same file are indistinguishable and can be grouped together.
  - A Cisco IOS timezone abbreviation other than `UTC`/`GMT` isn't recognised and is parsed as local time.
  - Lowercase/Juniper/Linux interface names are only recognised right after the word "interface" or "port" (e.g. "Interface eth0"); a bare mention with no such lead-in isn't picked up.
  - Not handled: JSON logs, IPv4-in-IPv6 embedded addresses, IPv6 zone/scope IDs (`%eth0`).
- **Size limits:** the timeline and raw block are capped at 300 events per incident. Large files haven't been performance-tested.
- **Testing gaps:**
  - Tested only in headless Chromium, mostly in the light theme.
  - The dark theme and real mobile devices are untested.
  - A section chevron looked odd once in a screenshot taken mid-animation. This was not investigated.

## Verification done

Using a headless browser against `network-incidents.log`:
- All 8 expected incidents display with the exact expected event IDs, under the expected severity levels and with the expected per-severity counts.
- None of the deliberate look-alikes merged: bastion01 first and second wave, bastion01 and bastion02, core-rtr1 and core-rtr2, dist-sw1, and edge-rtr1 and edge-rtr2.
- Section defaults, keyboard toggling, the sticky header, drag and keyboard resizing, minimum-width clamps and the mobile layout all behaved as intended.

This was manual, ad-hoc verification from a temporary folder, done before the automated suite below existed. See Testing for the checked-in tests that now cover the same ground (plus parser unit tests).

## Testing

Automated tests now live in `test/` and run with `npm install` once, then `npm test` (Node's built-in test runner, no build step for the app itself).

- `test/parser.test.js` — unit tests for the parser: RFC 5424 and RFC 3164, with and without `<PRI>`, unparseable-line counting, and keyword-based severity guessing.
- `test/integration.test.js` — parses `test-data/network-incidents.log` and checks the result against `test-data/expected-incidents.json`: the 8 expected incidents, their exact event IDs per severity, the severity totals, and that the deliberate look-alikes (bastion01 waves, bastion01/bastion02, core-rtr1/core-rtr2, dist-sw1, edge-rtr1/edge-rtr2) stay separate.
- `test/ui-smoke.test.js` — a light Playwright (Chromium) smoke test: opens `syslog-lens.html` directly (file://, no server), pastes `network-incidents.log`, and checks the severity rail, incident list and detail pane render.
- `test/sample-log.test.js` — asserts the `SAMPLE_LOG` constant embedded in `syslog-lens.html` is byte-identical to `test-data/network-incidents.log`, and that the "Try a sample log" button uses it (not `fetch()`).
- `test/severity-guessed.test.js` — unit-tests the parser's `guessed` flag (set when a line has no `<PRI>`), plus a Playwright check that a guessed severity renders a visible "guessed" tag (with a title) in both the timeline and the Raw event details section, while a `<PRI>`-derived severity does not.
- `test/pane-width-persistence.test.js` — Playwright tests that the divider width is written to `localStorage`, restored (clamped to the 260px minimum) after a reload, and that the app still loads and resizes normally when `localStorage` throws on every call.
- `test/incident-rules.test.js` — locks in the exact title and summary text `INCIDENT_RULES` produces for all 8 expected incidents (so the rules refactor can't silently change output), and asserts the two background false merges described above (edge-fw01 config save vs connection summary; the two dhcp01 DHCPACK events) no longer happen.
- `test/formats.test.js` — parses `test-data/formats.log` (a dedicated fixture, separate from `network-incidents.log`) plus a few standalone lines: Cisco IOS parsing (with/without a sequence number, with/without `<PRI>`, facility-as-process-name, tag-derived severity not marked guessed), IPv6 grouping keys (full and `::`-compressed, and that a HH:MM:SS timestamp or a MAC address is never misread as one), and grouping via lowercase/Juniper/Linux interface names (`eth0`, `ge-0/0/0`, `gi0/1`) — including that "via bond0" (no "interface"/"port" lead-in) is correctly *not* treated as an interface, matching the Session 1 dhcp01/vlan20 trade-off.
- `test/timezone-toggle.test.js` — Playwright tests that the UTC/local header toggle defaults to local, switches the displayed timestamp to UTC on click, persists the choice to `localStorage`, and still works when `localStorage` throws on every call.

To keep the app testable without a build step or a duplicated parser, `syslog-lens.html` exposes its internal `parse`, `guess`, `describe` and `keys` functions on `window.SyslogLens` (added right after `parse()` is defined, gated on `typeof window!=='undefined'`). This is a test-only hook — the UI code never reads it — so app behaviour is unchanged. Unit and integration tests load the real HTML file into `jsdom` and call `window.SyslogLens.parse(...)` directly, so they exercise the exact shipped code rather than a reimplementation. The UTC/local toggle is a display-only feature with no parser-level hook, so it's covered by Playwright instead (like the pane-width persistence tests).

`npm test` installs two dev dependencies: `jsdom` (to execute the app's own script in Node) and `playwright`/`playwright-core` (for the UI smoke test; run `npx playwright install chromium` once after `npm install` to fetch the browser binary). If that download is unavailable, skip the Playwright-based tests — the parser and integration suites don't need it.

Latest run: 36/36 tests passing (6 parser, 5 integration, 1 UI smoke, 2 sample-log, 2 severity-guessed, 3 pane-width-persistence, 3 incident-rules, 11 formats, 3 timezone-toggle).

## Next steps

1. Add a "key moments" timeline view that collapses repeated events.
2. Test with real logs and large files, and check the dark theme, mobile and screen readers.
3. Optional: add a copy or export of an incident summary.
4. Optional: recognise more log formats (JSON logs, IPv4-in-IPv6, IPv6 zone IDs) and more Cisco timezone abbreviations beyond UTC/GMT.

## Stage 5: auth-gated serving

`syslog-lens.html` is now served by Express (`GET /` and `GET /syslog-lens.html`, both behind `requirePage`) instead of being opened as a bare file — see README.md's "Routes" and "Cookie model" sections for the full route table and how the httpOnly `sl_token` cookie works. Key points for future work:

- `server/app.js` only statically serves `public/` (login/register assets); everything else outside `/api/*` and the two explicit page routes is a plain 404, so `server/`, `.env` and the SQLite DB are never reachable over HTTP.
- `server/middleware/auth.js` now exports `requireAuth` (API, 401 JSON), `requirePage` (HTML, 302 to `/login` + clears a bad cookie), and the shared `resolveUser` helper both build on. Both accept either the `sl_token` cookie or a Bearer header.
- `syslog-lens.html` itself only gained a small self-contained IIFE at the end of its `<script>` (signed-in-as + logout, `pageshow`/bfcache re-check) — parsing, grouping, timeline and styling are untouched. That block is a deliberate no-op when `fetch` doesn't exist (the jsdom test loader) or fails for non-HTTP reasons (`file://`), so `syslog-lens.html` still works standalone for local dev/testing.
- New tests: `test/auth-boundary.test.js` (server-side route/cookie boundary checks) and `test/auth-e2e.test.js` (Playwright: register → login → use the app → logout → back-button/direct-URL checks). `npm test` is 104/104 as of this stage (the 36/36 count above predates Stages 2-5).
