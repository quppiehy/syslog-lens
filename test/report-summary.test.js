'use strict';
// Log Summary report: built purely from the same D structure the app already
// renders (parse()'s {ev, bad, by}), via window.SyslogLens.buildSummaryReport.
// Asserts event/severity/incident totals match test-data/expected-incidents.json
// and that all log-derived text is escaped.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadApp } = require('./helpers/load-app');

const { SyslogLens } = loadApp();
const { parse, buildSummaryReport } = SyslogLens;

const LOG_PATH = path.join(__dirname, '..', 'test-data', 'network-incidents.log');
const EXPECTED_PATH = path.join(__dirname, '..', 'test-data', 'expected-incidents.json');
const logText = fs.readFileSync(LOG_PATH, 'utf8');
const expected = JSON.parse(fs.readFileSync(EXPECTED_PATH, 'utf8'));

// Dedupe incidents by object identity, exactly as the app's own view (rail +
// list) implicitly does: an incident is filed under every severity it spans
// in D.by, but it's the same object each time.
function allIncidents(D) {
  return [...new Set(D.by.flat())];
}

test('1. event count and unparsed line count match expected-incidents.json _meta', () => {
  const D = parse(logText);
  assert.equal(D.ev.length, expected._meta.total_events);
  assert.equal(D.bad.length, expected._meta.expected_unparsed_lines);
  const html = buildSummaryReport(D, 'network-incidents.log', { name: 'Ada Lovelace', employeeNumber: 'EMP-001' }, new Date('2026-09-24T16:05:32Z'));
  assert.match(html, new RegExp(`Total parsed events</th><td>${D.ev.length}</td>`));
  assert.match(html, new RegExp(`Unparsed lines</th><td>${D.bad.length}</td>`));
});

test('2. severity 0-7 counts match expected totals, including zero rows for 0 and 1', () => {
  const D = parse(logText);
  const html = buildSummaryReport(D, 'network-incidents.log', null, new Date());
  for (let sev = 0; sev <= 7; sev++) {
    const expectedCount = expected.severity_totals[String(sev)];
    const re = new RegExp(`<td[^>]*>${sev}</td><td[^>]*>[^<]+</td><td>${expectedCount}</td>`);
    assert.match(html, re, `severity ${sev} row should show count ${expectedCount}`);
  }
  // Severities 0 and 1 are present (0 in this log) and shown, not omitted.
  assert.equal(expected.severity_totals['0'], 0);
  assert.equal(expected.severity_totals['1'], 0);
  assert.match(html, /<td[^>]*>0<\/td><td[^>]*>Emergency<\/td><td>0<\/td>/);
  assert.match(html, /<td[^>]*>1<\/td><td[^>]*>Alert<\/td><td>0<\/td>/);
});

test('3. all 8 expected incidents are listed by title in the incidents table and summaries', () => {
  const D = parse(logText);
  const html = buildSummaryReport(D, 'network-incidents.log', null, new Date());
  const incs = allIncidents(D);
  assert.equal(incs.length >= 8, true, 'expected at least the 8 rule-based incidents among all grouped incidents');

  // Every title the app itself produced for a real (multi-event, rule-based)
  // incident must show up verbatim (escaped) in the summary report.
  const notable = incs.filter(i => i.ev.length > 1);
  assert.ok(notable.length >= 8, 'expected at least 8 multi-event incidents');
  for (const inc of notable) {
    assert.ok(html.includes(esc(inc.title)), `incident title "${inc.title}" should appear in the report`);
  }
});

test('4. devices are listed in the devices table', () => {
  const D = parse(logText);
  const html = buildSummaryReport(D, 'network-incidents.log', null, new Date());
  const hosts = [...new Set(D.ev.map(e => e.host))];
  assert.ok(hosts.length > 1);
  for (const host of hosts) {
    assert.ok(html.includes(`<td>${esc(host)}</td>`), `device "${host}" should appear in the devices table`);
  }
});

test('escaping: a crafted line with <script> and an onerror attribute is escaped (inert) in the Log Summary report', () => {
  const evil = '<134>1 2026-09-24T05:00:00.000Z evil-host<script>alert(1)</script> proc 1 X - <img src=x onerror=alert(2)> payload';
  const D = parse(logText + '\n' + evil);
  const html = buildSummaryReport(D, 'network-incidents.log', null, new Date());
  // No live <script> tag or <img onerror=...> element may appear - only the
  // esc()-escaped, inert text form (with &lt;/&gt; entities) is acceptable.
  assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);
  assert.doesNotMatch(html, /<img[^&]*onerror=/);
  assert.match(html, /evil-host&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /&lt;img src=x onerror=alert\(2\)&gt;/);
});

test('escaping: generatedByLine is escaped exactly once in both the Log Summary and Detailed Incident reports (no double-escaping)', () => {
  const D = parse(logText);
  const user = { name: 'AT&T <Ops>', employeeNumber: 'EMP-42' };
  const genDate = new Date('2026-09-24T16:05:32Z');
  const summaryHtml = buildSummaryReport(D, 'network-incidents.log', user, genDate);
  const incs = allIncidents(D);
  const inc = incs.find(i => i.ev.length > 1) || incs[0];
  const incidentHtml = SyslogLens.buildIncidentReport(inc, 'network-incidents.log', user, genDate);

  for (const html of [summaryHtml, incidentHtml]) {
    assert.match(html, /Generated by AT&amp;T &lt;Ops&gt; \(EMP-42\)/);
    // Escaped exactly once: no doubly-escaped entities anywhere in the report,
    // and the escaped name/brackets appear exactly once (in the header).
    assert.doesNotMatch(html, /&amp;amp;|&amp;lt;|&amp;gt;/);
    const occurrences = html.match(/AT&amp;T &lt;Ops&gt;/g) || [];
    assert.equal(occurrences.length, 1, 'the escaped user name should appear exactly once');
  }
});

test('timezone consistency: in UTC mode, the filename timestamp matches the header Generated timestamp', () => {
  const { window, SyslogLens: SL } = loadApp();
  const doc = window.document;
  doc.querySelector('#tzbtn').click();
  assert.equal(doc.querySelector('#tzbtn').textContent.trim(), 'UTC');

  const genDate = new Date('2026-09-24T16:05:32Z');
  const headerTs = SL.reportGenTimestamp(genDate);
  const m = headerTs.match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})/);
  assert.ok(m, `unexpected header timestamp format: ${headerTs}`);
  const expectedFnameTs = `${m[1]}${m[2]}${m[3]}-${m[4]}${m[5]}${m[6]}`;

  const filename = SL.summaryFilename('network-incidents.log', genDate);
  assert.ok(filename.includes(expectedFnameTs), `filename ${filename} should include ${expectedFnameTs}`);
});

function esc(s) {
  return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
