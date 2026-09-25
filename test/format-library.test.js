'use strict';
// Format test library: one test suite per fixture in test-data/formats/, each a small
// synthetic sample "as it arrives at a syslog collector" for a vendor/format not previously
// covered (or only partly covered) by the existing tests. For every fixture this asserts:
// every non-comment line parses (0 unparsed), hosts are read correctly, severities are
// correct for that format's own severity source, timestamps parse to the right instant, and
// at least one sensible incident groups as expected. See HANDOFF.md for the parser changes
// (NXR/CSC-with-year/CSC2-with-year/FortiGate key=value parsing, Junos BGP/OSPF message-text
// matching, interface-name normalisation) each fixture exercises.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadApp } = require('./helpers/load-app');

const { SyslogLens } = loadApp();
const { parse } = SyslogLens;

const DIR = path.join(__dirname, '..', 'test-data', 'formats');
const read = name => fs.readFileSync(path.join(DIR, name), 'utf8');

function distinctIncidents(parsed) {
  return [...new Set(parsed.by.flat())];
}
function findIncident(incidents, host, msgSubstr) {
  return incidents.find(i => i.host === host && i.ev.some(e => e.msg.includes(msgSubstr)));
}
function byMsg(ev, substr) {
  const found = ev.find(e => e.msg.includes(substr));
  assert.ok(found, `expected an event whose message includes ${JSON.stringify(substr)}`);
  return found;
}
// Cisco/Juniper 3164-ish lines with no explicit timezone parse as *local* time (same rule as
// the rest of the app - see HANDOFF.md's "Time handling"), so the expected instant must be
// built the same way (the local Date constructor), not compared against a fixed UTC string.
const local = (y, mo, d, h, mi, s, ms) => new Date(y, mo - 1, d, h, mi, s, ms || 0).getTime();

// --- Cisco IOS (classic collector format) ---------------------------------

test('cisco-ios.log: every line parses, hosts and tag-digit severities are correct', () => {
  const { ev, bad } = parse(read('cisco-ios.log'));
  assert.equal(bad.length, 0);
  assert.equal(ev.length, 12);
  const hosts = new Set(ev.map(e => e.host));
  ['access-rtr1', 'branch-rtr2', 'dist-sw9', 'core-rtr9'].forEach(h => assert.ok(hosts.has(h)));

  const link = byMsg(ev, 'Interface FastEthernet0/1, changed state to down');
  assert.equal(link.sev, 3);
  assert.equal(link.guessed, false);
  assert.equal(link.t.getTime(), local(2026, 9, 25, 9, 0, 1, 114));

  const rootguard = byMsg(ev, 'Root guard blocking port Gi1/0/5');
  assert.equal(rootguard.sev, 2);
  assert.equal(rootguard.guessed, false);
});

test('cisco-ios.log: grouping - access-rtr1\'s LINK/LINEPROTO flap and branch-rtr2\'s SEC_LOGIN failures each form one incident', () => {
  const incidents = distinctIncidents(parse(read('cisco-ios.log')));
  const link = findIncident(incidents, 'access-rtr1', 'FastEthernet0/1, changed state to down');
  assert.ok(link);
  assert.equal(link.ev.length, 4);

  const auth = findIncident(incidents, 'branch-rtr2', 'Login failed');
  assert.ok(auth);
  assert.equal(auth.ev.length, 3, '2 LOGIN_FAILED + 1 QUIET_MODE_ON');
  assert.match(auth.title, /Repeated authentication failures — source 198\.51\.100\.77/);

  // dist-sw9's two SPANTREE events use the abbreviated "Gi1/0/5" and canonical
  // "GigabitEthernet1/0/5" spellings of the same port; interface-name normalisation for
  // grouping keys (normIface() in syslog-lens.html) makes them share a key.
  const spantree = findIncident(incidents, 'dist-sw9', 'Root guard blocking port Gi1/0/5');
  assert.ok(spantree);
  assert.equal(spantree.ev.length, 2);
});

// --- Cisco IOS-XE (year + timezone in the timestamp) -----------------------

test('cisco-iosxe.log: every line parses, with a year and TZ in the timestamp honoured (UTC)', () => {
  const { ev, bad } = parse(read('cisco-iosxe.log'));
  assert.equal(bad.length, 0);
  assert.equal(ev.length, 13);

  const link = byMsg(ev, 'Interface GigabitEthernet0/0/2, changed state to down');
  assert.equal(link.host, 'edge-rtr5');
  assert.equal(link.sev, 3);
  assert.equal(link.guessed, false);
  assert.equal(link.t.toISOString(), '2026-09-25T10:00:05.100Z');
});

test('cisco-iosxe.log: grouping - edge-rtr5\'s OSPF/LINK/LINEPROTO burst forms one incident; Te1/1/1 and TenGigabitEthernet1/1/1 normalise to the same key', () => {
  const incidents = distinctIncidents(parse(read('cisco-iosxe.log')));
  const ospf = findIncident(incidents, 'edge-rtr5', 'Nbr 192.0.2.9 on GigabitEthernet0/0/2');
  assert.ok(ospf);
  assert.equal(ospf.ev.length, 6);
  assert.match(ospf.title, /^OSPF adjacency flap/);

  const auth = findIncident(incidents, 'bastion05', 'Login failed');
  assert.ok(auth);
  assert.equal(auth.ev.length, 3);
  assert.match(auth.title, /Repeated authentication failures — source 203\.0\.113\.90/);

  const macflap = findIncident(incidents, 'dist-sw6', 'is flapping between port Te1/1/1');
  assert.ok(macflap);
  assert.equal(macflap.ev.length, 2, 'MACFLAP (Te1/1/1) and SPANTREE (TenGigabitEthernet1/1/1) should share a normalised grouping key');
});

// --- Cisco NX-OS (leading year) ---------------------------------------------

test('cisco-nxos.log: every line parses, with the leading-year timestamp read correctly', () => {
  const { ev, bad } = parse(read('cisco-nxos.log'));
  assert.equal(bad.length, 0);
  assert.equal(ev.length, 12);

  const down = byMsg(ev, 'Interface Ethernet1/1 is down');
  assert.equal(down.host, 'core-sw7');
  assert.equal(down.proc, 'ETHPORT');
  assert.equal(down.sev, 3);
  assert.equal(down.guessed, false);
  assert.equal(down.t.getTime(), local(2026, 9, 25, 11, 0, 1));

  const errrcv = byMsg(ev, 'mismatch area ID');
  assert.equal(errrcv.sev, 4);
});

test('cisco-nxos.log: grouping - core-sw7\'s Ethernet1/1 burst, and Eth1/0/5/Ethernet1/0/5 normalise to the same key', () => {
  const incidents = distinctIncidents(parse(read('cisco-nxos.log')));
  const eth = findIncident(incidents, 'core-sw7', 'Interface Ethernet1/1 is down');
  assert.ok(eth);
  assert.equal(eth.ev.length, 4);

  const stp = findIncident(incidents, 'access-sw11', 'Root guard blocking port Eth1/0/5');
  assert.ok(stp);
  assert.equal(stp.ev.length, 2, 'Eth1/0/5 (NX-OS abbreviation) and Ethernet1/0/5 should share a normalised key');

  const auth = findIncident(incidents, 'bastion09', 'Login failed');
  assert.ok(auth);
  assert.equal(auth.ev.length, 3);
});

// --- Cisco ASA (%ASA-SEV-msgnum, with and without <PRI>/hostname) ----------

test('cisco-asa.log: every line parses, with and without a <PRI>/hostname, tag-digit severities correct', () => {
  const { ev, bad } = parse(read('cisco-asa.log'));
  assert.equal(bad.length, 0);
  assert.equal(ev.length, 10);

  const withHost = byMsg(ev, 'src outside:203.0.113.40/51022');
  assert.equal(withHost.host, 'edge-fw02');
  assert.equal(withHost.sev, 4);
  assert.equal(withHost.guessed, false);

  // Hostless ASA lines (no <PRI>, no hostname token) fall back to the documented
  // "unknown-host" placeholder, same as any other hostless Cisco line.
  const hostless = byMsg(ev, 'Built inbound TCP connection 5521');
  assert.equal(hostless.host, 'unknown-host');
  assert.equal(hostless.sev, 6);
  assert.equal(hostless.guessed, false);
});

test('cisco-asa.log: grouping - repeated Deny events share the denied IP, and the VPN session disconnect/establish pair link via the shared session IP', () => {
  const incidents = distinctIncidents(parse(read('cisco-asa.log')));
  const deny1 = findIncident(incidents, 'edge-fw02', '203.0.113.40/51022');
  assert.ok(deny1);
  assert.equal(deny1.ev.length, 2);

  const vpn = findIncident(incidents, 'edge-fw02', 'Session disconnected');
  assert.ok(vpn);
  assert.equal(vpn.ev.length, 2, 'the VPN disconnect and re-establish events share IP 198.51.100.66');
  assert.ok(vpn.ev.every(e => e.msg.includes('198.51.100.66')));
});

// --- Juniper Junos, RFC 3164 / BSD style -----------------------------------

test('juniper-junos-3164.log: every line parses; severities are keyword-guessed (no <PRI> in this format)', () => {
  const { ev, bad } = parse(read('juniper-junos-3164.log'));
  assert.equal(bad.length, 0);
  assert.equal(ev.length, 13);
  assert.ok(ev.every(e => e.guessed === true), 'BSD-style Junos lines carry no <PRI>, so severity is keyword-guessed');

  const bgpErr = byMsg(ev, "io error 'no route to host'");
  assert.equal(bgpErr.host, 'mx1');
  assert.equal(bgpErr.proc, 'rpd');
  assert.equal(bgpErr.t.getTime(), local(2026, 9, 25, 13, 0, 10));
});

test('juniper-junos-3164.log: grouping - mx1\'s BGP peer flap, mx2\'s OSPF flap and srx1\'s failed logins each form one incident', () => {
  const incidents = distinctIncidents(parse(read('juniper-junos-3164.log')));
  const bgp = findIncident(incidents, 'mx1', 'bgp peer 198.51.100.50');
  assert.ok(bgp);
  assert.equal(bgp.ev.length, 3);
  assert.match(bgp.title, /^BGP disruption/);

  const ospf = findIncident(incidents, 'mx2', 'OSPF neighbor 192.0.2.15');
  assert.ok(ospf);
  assert.equal(ospf.ev.length, 2);
  assert.match(ospf.title, /^OSPF adjacency flap/);

  const auth = findIncident(incidents, 'srx1', 'Failed password');
  assert.ok(auth);
  assert.equal(auth.ev.length, 3);
  assert.match(auth.title, /^Repeated authentication failures/);

  // mib2d's SNMP_TRAP_LINK_DOWN/UP pair on the same interface uses Junos's "ifName ge-0/0/1"
  // lead-in (not "interface "/"port "); IFR2 now accepts "ifName" as a lead-in too, so the pair
  // shares an interface grouping key and links into one incident.
  const link = findIncident(incidents, 'mx1', 'SNMP_TRAP_LINK_DOWN');
  assert.ok(link);
  assert.equal(link.ev.length, 2, 'SNMP_TRAP_LINK_DOWN and SNMP_TRAP_LINK_UP on "ifName ge-0/0/1" should link via IFR2');
  assert.ok(link.ev.some(e => e.msg.includes('SNMP_TRAP_LINK_UP')));
});

// --- Juniper Junos, RFC 5424 structured-data form --------------------------

test('juniper-junos-5424.log: every line parses; severity comes from <PRI>, not guessed', () => {
  const { ev, bad } = parse(read('juniper-junos-5424.log'));
  assert.equal(bad.length, 0);
  assert.equal(ev.length, 12);
  assert.ok(ev.every(e => e.guessed === false), 'every line carries a <PRI>');

  const bgpErr = byMsg(ev, "io error 'no route to host'");
  assert.equal(bgpErr.host, 'mx4');
  assert.equal(bgpErr.sev, 187 & 7);
  assert.equal(bgpErr.t.toISOString(), '2026-09-25T14:00:10.370Z');

  const ospfDown = byMsg(ev, 'OSPF neighbor 192.0.2.40');
  assert.equal(ospfDown.sev, 188 & 7);
});

test('juniper-junos-5424.log: grouping - mx4\'s BGP peer flap and mx5\'s OSPF flap each form one incident', () => {
  const incidents = distinctIncidents(parse(read('juniper-junos-5424.log')));
  const bgp = findIncident(incidents, 'mx4', 'bgp peer 198.51.100.60');
  assert.ok(bgp);
  assert.equal(bgp.ev.length, 3);
  assert.match(bgp.title, /^BGP disruption/);

  const ospf = findIncident(incidents, 'mx5', 'OSPF neighbor 192.0.2.40');
  assert.ok(ospf);
  assert.equal(ospf.ev.length, 2);
  assert.match(ospf.title, /^OSPF adjacency flap/);

  const auth = findIncident(incidents, 'srx2', 'Failed password');
  assert.ok(auth);
  assert.equal(auth.ev.length, 3);
});

// --- FortiGate key=value ----------------------------------------------------

test('fortinet-fortigate.log: every line parses; host from devname=, severity from level= (not guessed, overriding keyword guessing)', () => {
  const { ev, bad } = parse(read('fortinet-fortigate.log'));
  assert.equal(bad.length, 0);
  assert.equal(ev.length, 15);
  assert.ok(ev.every(e => e.host === 'fgt1'));
  assert.ok(ev.every(e => e.guessed === false), 'FortiGate severity comes from level=, never keyword-guessed');

  const levelToSev = {
    'System entered into conserve mode due to low memory': 2, // critical
    'Admin admin logged in successfully from 10.30.0.6': 3,   // error
    'CPU usage high: 92 percent': 4,                          // warning
    'Scheduled configuration backup completed': 6,            // information
    'Power supply 2 failure detected': 0,                     // emergency
    'Heartbeat check completed': 7,                           // debug
    'HA member fgt2 heartbeat lost': 2,                        // critical
  };
  for (const [msgSubstr, sev] of Object.entries(levelToSev)) {
    const e = byMsg(ev, msgSubstr);
    assert.equal(e.sev, sev, `wrong severity for: ${msgSubstr}`);
  }
  // A quoted value containing a space (msg="...") is read correctly, not truncated at the space.
  assert.ok(ev.some(e => e.msg.includes('System entered into conserve mode due to low memory')));
});

// date=/time= are the FortiGate's own DEVICE-LOCAL time, not UTC. Preference order: (a)
// eventtime= epoch (unit by digit count: 10=s, 13=ms, 16=us, 19=ns); (b) date=+time=+tz=; (c)
// date=+time= with no tz=, read as the viewer's own local time (same convention as RFC
// 3164/Cisco lines with no timezone - see the `local()` helper above).
test('fortinet-fortigate.log: timestamp path (a) - eventtime= epoch, unit picked by digit count', () => {
  const { ev } = parse(read('fortinet-fortigate.log'));

  const seconds = byMsg(ev, 'System entered into conserve mode due to low memory'); // 10-digit eventtime=
  assert.equal(seconds.t.toISOString(), '2026-09-25T07:00:00.000Z');

  const millis = byMsg(ev, 'Scheduled configuration backup completed'); // 13-digit eventtime=
  assert.equal(millis.t.toISOString(), '2026-09-25T07:03:30.000Z');

  const micros = byMsg(ev, 'Config sync check via eventtime'); // 16-digit eventtime=
  assert.equal(micros.t.toISOString(), '2026-09-25T07:10:00.000Z');

  const nanos = byMsg(ev, 'HA member fgt2 heartbeat lost'); // 19-digit eventtime=, no date=/time= at all
  assert.equal(nanos.t.toISOString(), '2026-09-25T07:08:20.000Z');
});

test('fortinet-fortigate.log: timestamp path (b) - date=+time= combined with tz= (device-local time placed on the UTC timeline)', () => {
  const { ev } = parse(read('fortinet-fortigate.log'));

  const plusNoColon = byMsg(ev, 'Admin admin logged in successfully from 10.30.0.6'); // tz="+0800"
  assert.equal(plusNoColon.t.toISOString(), '2026-09-25T07:00:30.000Z');

  const minus = byMsg(ev, 'Power supply 2 failure detected'); // tz="-0500"
  assert.equal(minus.t.toISOString(), '2026-09-25T07:06:40.000Z');

  const plusColon = byMsg(ev, 'Heartbeat check completed'); // tz="+08:00"
  assert.equal(plusColon.t.toISOString(), '2026-09-25T07:07:30.000Z');
});

test('fortinet-fortigate.log: timestamp path (c) - date=+time= with no tz= is read as the viewer\'s own local time', () => {
  const { ev } = parse(read('fortinet-fortigate.log'));
  const noTz = byMsg(ev, 'CPU usage high: 92 percent');
  assert.equal(noTz.t.getTime(), local(2026, 9, 25, 15, 2, 0));
});

test('fortinet-fortigate.log: the same instant reached via eventtime= and via date=+time=+tz= agree', () => {
  const { ev } = parse(read('fortinet-fortigate.log'));
  const viaEventtime = byMsg(ev, 'Config sync check via eventtime');
  const viaDateTime = byMsg(ev, 'Config sync check via date and time');
  assert.equal(viaEventtime.t.getTime(), viaDateTime.t.getTime());
  assert.equal(viaDateTime.t.toISOString(), '2026-09-25T07:10:00.000Z');
});

test('FortiGate detection requires the key=value payload to START the line (after <PRI>/whitespace) with date=/logver=/timestamp=/eventtime=, not just contain devname= anywhere', () => {
  // An RFC 5424 line whose structured-data/message merely quotes FortiGate-style config
  // (devname=/date=/time=) must still parse as RFC 5424, not be misdetected as FortiGate.
  const line = '<134>1 2026-09-25T10:00:00.000Z cfgmgr app1 1234 ID1 - Backing up FortiGate config: devname="fgt1" date=2026-09-25 time=10:00:00 devid="FGT1"';
  const { ev, bad } = parse(line);
  assert.equal(bad.length, 0);
  assert.equal(ev.length, 1);
  assert.equal(ev[0].host, 'cfgmgr'); // the RFC 5424 HOSTNAME field, not devname=
  assert.equal(ev[0].t.toISOString(), '2026-09-25T10:00:00.000Z');
});

test('fortinet-fortigate.log: grouping - the VPN tunnel-down/tunnel-up pair links via the shared remip=', () => {
  const incidents = distinctIncidents(parse(read('fortinet-fortigate.log')));
  const vpn = findIncident(incidents, 'fgt1', 'IPsec tunnel down');
  assert.ok(vpn);
  assert.equal(vpn.ev.length, 2, 'tunnel-down and tunnel-up should link via the shared remip=198.51.100.20');
  assert.ok(vpn.ev.some(e => e.msg.includes('IPsec tunnel up')));
  assert.ok(vpn.ev.every(e => e.msg.includes('198.51.100.20')));
});

// --- Cross-cutting: comment lines and the "many unparsed" hint threshold ---

test('every fixture file in test-data/formats/ has its comment-header lines skipped (not counted as bad)', () => {
  fs.readdirSync(DIR).filter(f => f.endsWith('.log')).forEach(f => {
    const text = read(f);
    const commentLines = text.split(/\r?\n/).filter(l => /^\s*#/.test(l));
    assert.ok(commentLines.length > 0, `${f} should have at least one "#" header comment`);
    const { bad } = parse(text);
    assert.ok(bad.every(l => !/^\s*#/.test(l)), `${f}: a comment line ended up in bad[]`);
  });
});
