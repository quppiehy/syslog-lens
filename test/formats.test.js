'use strict';
// New log-format coverage added on top of the Session 1 baseline: Cisco IOS-style messages
// (%FACILITY-SEV-MNEMONIC, with an optional sequence-number prefix, hostname, timezone and
// <PRI>), IPv6 grouping keys, and lowercase/Juniper/Linux interface names in interface-like
// contexts. Uses a dedicated fixture (test-data/formats.log) so network-incidents.log and
// expected-incidents.json, which the Session 1 grouping-rule tests depend on, stay untouched.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadApp } = require('./helpers/load-app');

const { SyslogLens } = loadApp();
const { parse, keys } = SyslogLens;

const LOG_PATH = path.join(__dirname, '..', 'test-data', 'formats.log');
const logText = fs.readFileSync(LOG_PATH, 'utf8');

function byMsg(ev, substr) {
  const found = ev.find(e => e.msg.includes(substr));
  assert.ok(found, `expected an event whose message includes ${JSON.stringify(substr)}`);
  return found;
}

// --- Cisco IOS format ---------------------------------------------------

test('Cisco IOS line with a sequence number, no <PRI>: severity comes from the %FACILITY-SEV-MNEMONIC tag and is not marked guessed', () => {
  const line = '000123: *Mar  1 00:00:01.123: %LINK-3-UPDOWN: Interface GigabitEthernet0/1, changed state to down';
  const { ev, bad } = parse(line);
  assert.equal(bad.length, 0);
  assert.equal(ev.length, 1);
  const e = ev[0];
  assert.equal(e.proc, 'LINK', 'the facility (LINK) should be used as the process name');
  assert.equal(e.sev, 3, 'severity should come from the Cisco tag (%LINK-3-UPDOWN)');
  assert.equal(e.guessed, false, 'a severity read from the Cisco tag must not be marked as guessed');
  assert.equal(e.msg, 'Interface GigabitEthernet0/1, changed state to down');
});

test('Cisco IOS line with no sequence number and no hostname (dot freshness marker, no <PRI>)', () => {
  const line = '.Mar  1 00:00:05.500: %SYS-5-CONFIG_I: Configured from console by vty0';
  const { ev, bad } = parse(line);
  assert.equal(bad.length, 0);
  assert.equal(ev.length, 1);
  const e = ev[0];
  assert.equal(e.proc, 'SYS');
  assert.equal(e.sev, 5);
  assert.equal(e.guessed, false);
});

test('Cisco IOS line with <PRI>, a sequence number, a hostname and a timezone: PRI severity wins and is not marked guessed', () => {
  const line = '<189>45: core-rtr1: Sep 24 03:14:02.114 UTC: %OSPF-5-ADJCHG: Process 1, Nbr 10.255.0.1 on GigabitEthernet0/0/1 from FULL to DOWN, Neighbor Down: Interface down or detached';
  const { ev, bad } = parse(line);
  assert.equal(bad.length, 0);
  assert.equal(ev.length, 1);
  const e = ev[0];
  assert.equal(e.host, 'core-rtr1');
  assert.equal(e.proc, 'OSPF');
  assert.equal(e.sev, 189 & 7); // PRI wins over the Cisco tag's own "5"
  assert.equal(e.guessed, false);
  // The explicit "UTC" timezone should be honoured: the instant is midday-ish UTC on 2026-09-24.
  assert.equal(e.t.toISOString().slice(0, 19), '2026-09-24T03:14:02');
});

// --- IPv6 grouping --------------------------------------------------------

test('IPv6 addresses (full and "::"-compressed) are recognised as grouping keys, alongside IPv4', () => {
  const a = { msg: 'Neighbor 2001:db8::1 reachability confirmed' };
  const b = { msg: 'Full form: 2001:0db8:0000:0000:0000:0000:0000:0001 seen' };
  assert.ok(keys(a).includes('p:2001:db8::1'));
  assert.ok(keys(b).includes('p:2001:0db8:0000:0000:0000:0000:0000:0001'));
});

test('IPv6 recognition does not false-match a HH:MM:SS timestamp or a MAC address', () => {
  const timestamp = { msg: 'changed state to down at 03:14:02 sharp' };
  const mac = { msg: 'DHCPACK on 10.40.1.10 to aa:bb:cc:dd:ee:ff via bond0' };
  assert.equal(keys(timestamp).some(k => k.startsWith('p:') && k.includes(':')), false, 'a timestamp must not be read as an IPv6 address');
  // The MAC address itself must not become a "p:" key; the IPv4 address on the same line still should.
  const macKeys = keys(mac);
  assert.ok(!macKeys.includes('p:aa:bb:cc:dd:ee:ff'), 'a MAC address must not be read as an IPv6 address');
  assert.ok(macKeys.includes('p:10.40.1.10'), 'the IPv4 address on the same line should still be recognised');
});

test('grouping: two events on the same host sharing an IPv6 address merge into one incident', () => {
  const d = parse(logText);
  const incidents = [...new Set(d.by.flat())];
  const inc = incidents.find(i => i.host === 'v6-rtr1');
  assert.ok(inc);
  assert.equal(inc.ev.length, 2, 'the two v6-rtr1 events sharing 2001:db8::1 should merge');
  assert.ok(inc.ev.every(e => e.msg.includes('2001:db8::1')));

  // A neighbouring event on a different host, with a different (fe80::) IPv6 address, must
  // stay separate: different host, different key.
  const other = incidents.find(i => i.host === 'v6-rtr2');
  assert.ok(other);
  assert.equal(other.ev.length, 1);
});

// --- Lowercase / Juniper / Linux interface names --------------------------

test('grouping: lowercase Linux interface name (eth0) in an interface-like context links two events', () => {
  const d = parse(logText);
  const incidents = [...new Set(d.by.flat())];
  const inc = incidents.find(i => i.host === 'srv1');
  assert.ok(inc);
  assert.equal(inc.ev.length, 2);
  assert.ok(inc.ev.every(e => e.msg.includes('eth0')));
});

test('grouping: Juniper-style interface name (ge-0/0/0) links two events', () => {
  const d = parse(logText);
  const incidents = [...new Set(d.by.flat())];
  const inc = incidents.find(i => i.host === 'mx1');
  assert.ok(inc);
  assert.equal(inc.ev.length, 2);
  assert.ok(inc.ev.every(e => e.msg.includes('ge-0/0/0')));
});

test('grouping: lowercase Cisco-style interface name (gi0/1) links two events', () => {
  const d = parse(logText);
  const incidents = [...new Set(d.by.flat())];
  const inc = incidents.find(i => i.host === 'sw1');
  assert.ok(inc);
  assert.equal(inc.ev.length, 2);
  assert.ok(inc.ev.every(e => e.msg.includes('gi0/1')));
});

test('lowercase interface names are only recognised in interface-like contexts: "via bond0" is not treated as an interface', () => {
  const casual = { msg: 'DHCPACK on 10.40.1.10 to aa:bb:cc:dd:ee:ff via bond0' };
  assert.ok(!keys(casual).includes('i:bond0'), '"via bond0" is casual phrasing, not "Interface bond0" / "port bond0"');
});

test('the Session 1 regression still holds in this new fixture-adjacent check: the parser itself reports no bad lines for formats.log', () => {
  const { bad } = parse(logText);
  assert.equal(bad.length, 0);
});
