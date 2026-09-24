'use strict';
// Detailed Incident report: built purely from one incident object (the same
// D.by[sel][cur] the app already renders), via
// window.SyslogLens.buildIncidentReport. Also proves the gap-from-previous
// helper (gapInfo) that both the app's timeline and this report now share
// keeps producing the exact same gap text as the timeline did before the
// extraction (see syslog-lens.html's show(), which now calls gapInfo too).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadApp } = require('./helpers/load-app');

const { SyslogLens } = loadApp();
const { parse, buildIncidentReport, gapInfo } = SyslogLens;

const LOG_PATH = path.join(__dirname, '..', 'test-data', 'network-incidents.log');
const EXPECTED_PATH = path.join(__dirname, '..', 'test-data', 'expected-incidents.json');
const logText = fs.readFileSync(LOG_PATH, 'utf8');
const expected = JSON.parse(fs.readFileSync(EXPECTED_PATH, 'utf8'));

function esc(s) {
  return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
function eidOf(rawLine) {
  const m = rawLine.match(/eid="([^"]+)"/);
  if (!m) throw new Error(`no eid found in line: ${rawLine}`);
  return m[1];
}
function distinctIncidents(parsed) {
  const seen = new Map();
  parsed.by.forEach(bucket => {
    bucket.forEach(inc => {
      const ids = inc.ev.map(e => eidOf(e.raw)).sort();
      const key = ids.join(',');
      if (!seen.has(key)) seen.set(key, inc);
    });
  });
  return seen;
}

// 5-8: for each of the 8 expected incidents, build a Detailed Incident report
// and check raw lines, row count, severities and gap text.
for (const exp of expected.incidents) {
  test(`5-8. Detailed Incident report for ${exp.id} (${exp.title}) includes every event, the right row count, severities and gaps`, () => {
    const D = parse(logText);
    const found = distinctIncidents(D);
    const key = [...exp.event_ids].sort().join(',');
    const inc = found.get(key);
    assert.ok(inc, `incident ${exp.id} not found as its own group`);

    const html = buildIncidentReport(inc, 'network-incidents.log', { name: 'Ada Lovelace', employeeNumber: 'EMP-001' }, new Date('2026-09-24T16:05:32Z'));

    // Every event's raw line appears, escaped.
    for (const e of inc.ev) {
      assert.ok(html.includes(esc(e.raw)), `raw line for ${eidOf(e.raw)} should appear escaped in the report`);
    }

    // Row count equals inc.ev.length: count <tr> in the timeline tbody.
    const tlMatch = html.match(/<h2>Timeline[^<]*<\/h2>\s*<table>.*?<tbody>([\s\S]*?)<\/tbody>/);
    assert.ok(tlMatch, 'timeline table not found');
    const rowCount = (tlMatch[1].match(/<tr>/g) || []).length;
    assert.equal(rowCount, inc.ev.length, 'timeline row count must equal inc.ev.length (no 300-event cap)');

    // Severities: every severity in inc.sevs appears in the severity table
    // with the correct per-severity event count.
    for (const sev of inc.sevs) {
      const count = inc.ev.filter(e => e.sev === sev).length;
      const re = new RegExp(`<td[^>]*>${sev}</td><td[^>]*>[^<]+</td><td>${count}</td>`);
      assert.match(html, re, `severity ${sev} row should show count ${count}`);
    }

    // Gaps: the report's per-row gap text must equal gapInfo(inc.ev, j).text
    // for every row (the same helper the timeline itself now calls).
    inc.ev.forEach((e, j) => {
      const expectedGap = j === 0 ? '—' : gapInfo(inc.ev, j).text;
      assert.ok(html.includes(`<td>${esc(expectedGap)}</td>`) || expectedGap === '—' && html.includes('<td>—</td>'),
        `row ${j} gap text should be "${expectedGap}"`);
    });
  });
}

test('a Detailed Incident report never produces an empty report (always has a heading and at least one timeline row)', () => {
  const D = parse(logText);
  const found = distinctIncidents(D);
  const inc = [...found.values()][0];
  const html = buildIncidentReport(inc, 'network-incidents.log', null, new Date());
  assert.match(html, /<h1>Syslog Lens/);
  assert.match(html, /<tbody>\s*<tr>/);
});

test('escaping: a crafted log line with <script> and an onerror attribute is escaped (inert) in the Detailed Incident report', () => {
  const evil = '<131>1 2026-09-24T03:14:10.000Z core-rtr1 ifmgr 150 X - Interface GigabitEthernet0/0/1 <script>alert(1)</script> <img src=x onerror=alert(2)> changed state to down';
  const D = parse(logText + '\n' + evil);
  // The crafted line groups with INC-OSPF-01 (same host/interface, within
  // window). Search directly by object identity instead of distinctIncidents
  // (which requires every event to carry a test-only eid; the crafted line
  // deliberately doesn't).
  const inc = [...new Set(D.by.flat())].find(i => i.ev.some(e => e.raw.includes('onerror')));
  assert.ok(inc, 'crafted event should have grouped into an incident');
  const html = buildIncidentReport(inc, 'network-incidents.log', null, new Date());
  // No live <script> tag or <img onerror=...> element may appear - only the
  // esc()-escaped, inert text form (with &lt;/&gt; entities) is acceptable.
  assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);
  assert.doesNotMatch(html, /<img[^&]*onerror=/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /&lt;img src=x onerror=alert\(2\)&gt;/);
});

test('the live-rendered timeline (.gap spans) matches gapInfo() text exactly, for all 8 sample incidents', () => {
  // Drives the actual app UI (not just window.SyslogLens) in a fresh jsdom
  // instance: paste the sample log, open each severity/incident pair, and
  // compare the rendered <span class="gap"> text against gapInfo() output -
  // the same equivalence show() itself now relies on.
  const { window, SyslogLens: SL2 } = loadApp();
  const doc = window.document;
  doc.querySelector('#paste').value = logText;
  doc.querySelector('#parse').click();

  const D = SL2.parse(logText);
  const found = distinctIncidents(D);

  for (const exp of expected.incidents) {
    const key = [...exp.event_ids].sort().join(',');
    const inc = found.get(key);
    assert.ok(inc);
    const sev = inc.sevs[0];
    doc.querySelector(`.sv[data-s="${sev}"]`).click();
    // The list's data-i is the incident's own index into D.by[sev] (object
    // identity), the same key the app's own list()/show() use - robust even
    // when two incidents share both title and host (e.g. the two
    // "bastion01" auth-failure waves, INC-AUTH-01 and INC-AUTH-03).
    const k = D.by[sev].indexOf(inc);
    assert.ok(k >= 0, `incident "${inc.title}" (${inc.host}) not found in D.by[${sev}]`);
    const target = doc.querySelector(`#list .inc[data-i="${k}"]`);
    assert.ok(target, `no rendered list item for data-i="${k}" at severity ${sev}`);
    target.click();

    const gapEls = [...doc.querySelectorAll('#detail .tl .gap')];
    assert.equal(gapEls.length, inc.ev.length - 1, 'one .gap span per event after the first');
    inc.ev.slice(1).forEach((e, j) => {
      const expectedText = gapInfo(inc.ev, j + 1).text;
      assert.equal(gapEls[j].textContent, expectedText, `${exp.id}: rendered gap text for event ${j + 1}`);
    });
  }
});

// Extra assurance the extracted gap helper matches the formula the timeline
// used inline before the refactor, for all 8 sample incidents' full event
// sequences (not just a couple of rows).
test('gapInfo() gap text matches "+" + dur(gap ms) for every event in all 8 sample incidents (timeline formula unchanged)', () => {
  const D = parse(logText);
  const found = distinctIncidents(D);
  function dur(ms) {
    const s = Math.round(ms / 1e3);
    if (s < 1) return '0s';
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
    return (h ? h + 'h ' : '') + (m ? m + 'm ' : '') + (r || !(h || m) ? r + 's' : '');
  }
  for (const exp of expected.incidents) {
    const key = [...exp.event_ids].sort().join(',');
    const inc = found.get(key);
    assert.ok(inc);
    inc.ev.forEach((e, j) => {
      const gi = gapInfo(inc.ev, j);
      if (j === 0) {
        assert.equal(gi.text, '');
        assert.equal(gi.ms, 0);
      } else {
        const expectedMs = inc.ev[j].t - inc.ev[j - 1].t;
        assert.equal(gi.ms, expectedMs);
        assert.equal(gi.text, '+' + dur(expectedMs));
      }
    });
  }
});
