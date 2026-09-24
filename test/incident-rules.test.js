'use strict';
// Locks in the exact tailored titles/summaries the data-driven INCIDENT_RULES
// (in syslog-lens.html) must keep producing for the 8 expected incidents, and
// asserts the two background false-merges noted in HANDOFF.md as "known
// limitations" no longer happen now that grouping requires a shared interface
// or IP address, or both events matching the same incident-type rule.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadApp } = require('./helpers/load-app');

const { SyslogLens } = loadApp();
const { parse } = SyslogLens;

const LOG_PATH = path.join(__dirname, '..', 'test-data', 'network-incidents.log');
const EXPECTED_PATH = path.join(__dirname, '..', 'test-data', 'expected-incidents.json');

const logText = fs.readFileSync(LOG_PATH, 'utf8');
const expected = JSON.parse(fs.readFileSync(EXPECTED_PATH, 'utf8'));

function eidOf(rawLine) {
  const m = rawLine.match(/eid="([^"]+)"/);
  if (!m) throw new Error(`no eid found in line: ${rawLine}`);
  return m[1];
}

// Same de-duplication approach as test/integration.test.js: an incident is
// filed under every severity it spans, so collapse by its unique event-id set.
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

const EXPECTED_TEXT = {
  'INC-OSPF-01': {
    title: 'OSPF adjacency flap — GigabitEthernet0/0/1',
    summary: '<b>core-rtr1</b> logged 12 related events on <b>GigabitEthernet0/0/1</b> (neighbour <b>10.255.0.2</b>) over 2m 47s. The sequence includes 2 link-down events, the adjacency dropping 3 times, 1 dead-timer expiry, returning to FULL 3 times, and 2 SPF recalculations.',
  },
  'INC-OSPF-02': {
    title: 'OSPF adjacency flap — GigabitEthernet0/0/1',
    summary: '<b>core-rtr2</b> logged 10 related events on <b>GigabitEthernet0/0/1</b> (neighbour <b>10.255.0.1</b>) over 2m 47s. The sequence includes 2 link-down events, the adjacency dropping 3 times, 1 dead-timer expiry, and returning to FULL 3 times.',
  },
  'INC-OSPF-03': {
    title: 'OSPF adjacency flap — Vlan10',
    summary: '<b>dist-sw1</b> logged 2 related events on <b>Vlan10</b> (neighbour <b>10.255.0.1</b>) over 29s. The sequence includes the adjacency dropping 1 time, 1 dead-timer expiry, and returning to FULL 1 time.',
  },
  'INC-AUTH-01': {
    title: 'Repeated authentication failures — source 203.0.113.45',
    summary: '<b>bastion01</b> logged 13 related events from source <b>203.0.113.45</b> over 2m 30s. The sequence includes 10 failed logins targeting root and admin, the maximum-attempts limit being hit, and the source being banned.',
  },
  'INC-AUTH-02': {
    title: 'Repeated authentication failures — source 203.0.113.45',
    summary: '<b>bastion02</b> logged 3 related events from source <b>203.0.113.45</b> over 1m 17s. The sequence includes 3 failed logins targeting root.',
  },
  'INC-AUTH-03': {
    title: 'Repeated authentication failures — source 203.0.113.45',
    summary: '<b>bastion01</b> logged 2 related events from source <b>203.0.113.45</b> over 6s. The sequence includes 2 failed logins targeting root.',
  },
  'INC-BGP-01': {
    title: 'BGP disruption — peer 198.51.100.2',
    summary: '<b>edge-rtr1</b> logged 13 related events involving peer <b>198.51.100.2</b> over 3m 45s. The sequence includes delayed keepalives, a hold-timer expiry, the session going down 2 times, 3 failed reconnect attempts, a default-route loss and its restoration, and the session re-establishing 2 times.',
  },
  'INC-BGP-02': {
    title: 'BGP disruption — peer 198.51.100.6',
    summary: '<b>edge-rtr2</b> logged 3 related events involving peer <b>198.51.100.6</b> over 1m 3s. The sequence includes a hold-timer expiry, the session going down 1 time, and the session re-establishing 1 time.',
  },
};

test('the data-driven incident rules produce the exact expected title and summary for all 8 incidents', () => {
  const parsed = parse(logText);
  const found = distinctIncidents(parsed);

  assert.equal(Object.keys(EXPECTED_TEXT).length, expected.incidents.length);

  for (const exp of expected.incidents) {
    const key = [...exp.event_ids].sort().join(',');
    const inc = found.get(key);
    assert.ok(inc, `expected incident ${exp.id} was not found as its own group`);

    const wanted = EXPECTED_TEXT[exp.id];
    assert.ok(wanted, `no locked-in text fixture for ${exp.id}`);
    assert.equal(inc.title, wanted.title, `${exp.id}: title`);
    assert.equal(inc.summary, wanted.summary, `${exp.id}: summary`);
  }
});

test('background false merges from HANDOFF.md no longer happen: edge-fw01 config save vs connection summary stay separate', () => {
  const parsed = parse(logText);
  const found = distinctIncidents(parsed);

  // E003 = CONN_SUMMARY, E008 = CONFIG (both edge-fw01, proc "fw", no shared
  // interface/IP and neither matches an incident-type rule).
  const groupOfE003 = [...found.values()].find(inc => inc.ev.some(e => eidOf(e.raw) === 'E003'));
  const groupOfE008 = [...found.values()].find(inc => inc.ev.some(e => eidOf(e.raw) === 'E008'));
  assert.ok(groupOfE003);
  assert.ok(groupOfE008);
  assert.equal(groupOfE003.ev.length, 1, 'E003 (connection summary) should be its own singleton group');
  assert.equal(groupOfE008.ev.length, 1, 'E008 (config save) should be its own singleton group');
});

test('background false merges from HANDOFF.md no longer happen: two dhcp01 DHCPACK events stay separate', () => {
  const parsed = parse(logText);
  const found = distinctIncidents(parsed);

  // E006 and E007 are two unrelated DHCPACK leases on dhcp01, each to a
  // different client IP; "via vlan20" is casual phrasing, not a canonical
  // capitalised interface reference like "Vlan10", so it no longer counts as
  // a shared interface for grouping.
  const groupOfE006 = [...found.values()].find(inc => inc.ev.some(e => eidOf(e.raw) === 'E006'));
  const groupOfE007 = [...found.values()].find(inc => inc.ev.some(e => eidOf(e.raw) === 'E007'));
  assert.ok(groupOfE006);
  assert.ok(groupOfE007);
  assert.equal(groupOfE006.ev.length, 1, 'E006 (DHCPACK) should be its own singleton group');
  assert.equal(groupOfE007.ev.length, 1, 'E007 (DHCPACK) should be its own singleton group');
});
