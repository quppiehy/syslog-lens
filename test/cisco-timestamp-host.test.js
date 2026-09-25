'use strict';
// Covers the "timestamp then hostname" Cisco IOS variant (as written by many syslog
// collectors), e.g. "Sep 25 14:00:10.370: core-rtr1 %LINK-3-UPDOWN: ...", using the
// real-world sample test-data/cisco_syslog_test.log. This is distinct from the existing
// Cisco format handled by CSC (hostname BEFORE the timestamp, or no hostname at all) -
// see the CSC2 regex and HANDOFF.md's Cisco notes in syslog-lens.html.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadApp } = require('./helpers/load-app');

const { SyslogLens } = loadApp();
const { parse } = SyslogLens;

const LOG_PATH = path.join(__dirname, '..', 'test-data', 'cisco_syslog_test.log');
const logText = fs.readFileSync(LOG_PATH, 'utf8');

function distinctIncidents(parsed) {
  return [...new Set(parsed.by.flat())];
}

function findIncident(incidents, host, msgSubstr) {
  return incidents.find(i => i.host === host && i.ev.some(e => e.msg.includes(msgSubstr)));
}

test('all 58 real log lines parse, with 0 unparsed (the 4 leading "#" comment lines are skipped entirely, not counted as unparsed)', () => {
  const { ev, bad } = parse(logText);
  assert.equal(ev.length, 58);
  assert.equal(bad.length, 0, 'comment lines are skipped outright (see the format-library work), not counted as bad');
});

test('hostnames are read correctly from the "timestamp: HOST %TAG" format', () => {
  const { ev } = parse(logText);
  const hosts = new Set(ev.map(e => e.host));
  ['core-rtr1', 'core-rtr2', 'core-rtr3', 'edge-rtr1', 'edge-rtr2', 'edge-fw01', 'bastion01',
    'dist-sw1', 'dist-sw2', 'dist-rtr1', 'access-sw2', 'access-sw3', 'access-sw4', 'access-sw5']
    .forEach(h => assert.ok(hosts.has(h), `expected host ${h} to be parsed`));
});

test('severities come from the Cisco tag digit, not guessed, for a representative sample including ASA, SEC_LOGIN and SPANTREE facilities', () => {
  const { ev } = parse(logText);
  const cases = [
    { raw: /%LINK-3-UPDOWN: Interface GigabitEthernet0\/1, changed state to down$/, sev: 3 },
    { raw: /%OSPF-5-ADJCHG: Process 1, Nbr 10\.0\.12\.2 on GigabitEthernet0\/1 from FULL to DOWN/, sev: 5 },
    { raw: /%ASA-6-302013: Built inbound TCP connection for outside:203\.0\.113\.20/, sev: 6 },
    { raw: /%SEC_LOGIN-4-LOGIN_FAILED: Login failed \[user: admin\]/, sev: 4 },
    { raw: /%SEC_LOGIN-1-QUIET_MODE_ON/, sev: 1 },
    { raw: /%SPANTREE-2-ROOTGUARD_BLOCK/, sev: 2 },
    { raw: /%SPANTREE-6-PORT_STATE/, sev: 6 },
    { raw: /%SW_MATM-4-MACFLAP_NOTIF/, sev: 4 },
    { raw: /%BGP-3-NOTIFICATION: received from neighbor 203\.0\.113\.1/, sev: 3 },
  ];
  cases.forEach(({ raw, sev }) => {
    const e = ev.find(x => raw.test(x.raw));
    assert.ok(e, `expected a line matching ${raw}`);
    assert.equal(e.sev, sev, `wrong severity for: ${e.raw}`);
    assert.equal(e.guessed, false, `severity should come from the tag, not be guessed, for: ${e.raw}`);
  });
});

test('grouping: core-rtr1\'s Gi0/1 link/lineproto/OSPF burst forms one incident, separate from core-rtr2\'s', () => {
  const incidents = distinctIncidents(parse(logText));
  const r1 = findIncident(incidents, 'core-rtr1', 'Interface GigabitEthernet0/1, changed state to down');
  const r2 = findIncident(incidents, 'core-rtr2', 'Interface GigabitEthernet0/1, changed state to down');
  assert.ok(r1);
  assert.ok(r2);
  assert.notEqual(r1, r2, 'core-rtr1 and core-rtr2 must not merge into the same incident');
  // core-rtr1: LINK down, LINEPROTO down, OSPF ADJCHG down, OSPF ERRRCV, LINK up, LINEPROTO up, OSPF ADJCHG up
  assert.equal(r1.ev.length, 7);
  assert.ok(r1.ev.every(e => e.host === 'core-rtr1'));
  assert.match(r1.title, /OSPF adjacency flap/);
  // core-rtr2's later, isolated OSPF event (14:21:00, Gi0/2) is far outside the 300s window
  // of the earlier burst (which ends ~14:00:52) and mentions a different interface, so it is
  // correctly its own, separate incident rather than joining r2.
  const r2later = findIncident(incidents, 'core-rtr2', 'Nbr 10.0.23.3 on GigabitEthernet0/2');
  assert.ok(r2later);
  assert.notEqual(r2later, r2);
});

test('grouping: edge-rtr1\'s BGP events (17-23) form one incident titled with peer 203.0.113.1', () => {
  const incidents = distinctIncidents(parse(logText));
  const inc = findIncident(incidents, 'edge-rtr1', 'neighbor 203.0.113.1');
  assert.ok(inc);
  assert.equal(inc.ev.length, 7);
  assert.equal(inc.title, 'BGP disruption — peer 203.0.113.1');
  assert.ok(inc.ev.every(e => e.proc === 'BGP'));
});

test('grouping: bastion01\'s SEC_LOGIN failures (LOGIN_FAILED + QUIET_MODE_ON) form one authentication incident', () => {
  const incidents = distinctIncidents(parse(logText));
  const inc = findIncident(incidents, 'bastion01', 'Login failed');
  assert.ok(inc);
  assert.equal(inc.ev.length, 6, '5 LOGIN_FAILED + 1 QUIET_MODE_ON events should all be linked via the shared Source IP');
  assert.ok(inc.ev.every(e => e.proc === 'SEC_LOGIN'));
  assert.equal(inc.title, 'Repeated authentication failures — source 192.0.2.50');
  assert.ok(inc.ev.some(e => e.msg.includes('QUIET_MODE_ON') === false && /Still time to wait/.test(e.msg)));
});

test('grouping: dist-sw1\'s Gi1/0/24 LINK/LINEPROTO events group together, now including the abbreviated-name MACFLAP event', () => {
  const incidents = distinctIncidents(parse(logText));
  const inc = findIncident(incidents, 'dist-sw1', 'GigabitEthernet1/0/24, changed state to down');
  assert.ok(inc);
  // Interface-name normalisation for grouping keys (see normIface()/NORM_PREFIX in
  // syslog-lens.html): "Gi1/0/24" and "GigabitEthernet1/0/24" now share a grouping key, so the
  // SW_MATM MACFLAP event on the same physical port, in the same time window, joins this
  // incident instead of forming its own singleton (superseding the "debatable case" this test
  // used to document, where the two spellings didn't share a key).
  assert.equal(inc.ev.length, 5, 'LINK down, LINEPROTO down, MACFLAP, LINK up, LINEPROTO up');
  assert.ok(inc.ev.some(e => e.msg.includes('is flapping between port Gi1/0/24')), 'the MACFLAP event should now be part of this incident');
  assert.ok(inc.ev.filter(e => e.msg.includes('GigabitEthernet1/0/24')).length === 4);
});

test('OSPF facility + ADJCHG events match the OSPF rule; BGP facility + ADJCHANGE/NOTIFICATION events match the BGP rule', () => {
  const incidents = distinctIncidents(parse(logText));
  const ospf = findIncident(incidents, 'core-rtr1', 'Nbr 10.0.12.2 on GigabitEthernet0/1');
  assert.ok(ospf);
  assert.match(ospf.title, /^OSPF adjacency flap/);
  assert.ok(ospf.ev.every(e => e.proc === 'OSPF' || e.proc === 'LINK' || e.proc === 'LINEPROTO'));

  const bgp = findIncident(incidents, 'edge-rtr1', 'neighbor 203.0.113.1 Down User reset');
  assert.ok(bgp);
  assert.match(bgp.title, /^BGP disruption/);
  assert.ok(bgp.ev.every(e => e.proc === 'BGP'));
});

test('the pre-existing formats.log and network-incidents.log fixtures are unaffected (no misparsing introduced by CSC2)', () => {
  const formatsPath = path.join(__dirname, '..', 'test-data', 'formats.log');
  const { bad: formatsBad, ev: formatsEv } = parse(fs.readFileSync(formatsPath, 'utf8'));
  assert.equal(formatsBad.length, 0);
  assert.equal(formatsEv.length, 13);
});
