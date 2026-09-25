'use strict';
// Down->recovery pairing (interface link, OSPF adjacency, BGP session): see HANDOFF.md's
// "Down->recovery pairing" section. A DOWN for a resource (interface / OSPF neighbour / BGP
// peer) is linked to its matching RECOVERY on the same host even when they're more than the
// normal 300s (WIN) grouping window apart, as long as it's within MAX_RECOVERY (1h). Only the
// recovery event itself is bridged; normal WIN-based chaining then pulls in each side's close
// neighbours, so a scenario that would otherwise split into two incidents (a slow down/up cycle)
// becomes one. This file also covers the new titles (interface down/flap), the duration/
// no-recovery summary sentences, and the same-host "possibly related" hint.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadApp } = require('./helpers/load-app');

const { SyslogLens } = loadApp();
const { parse } = SyslogLens;

// Same de-duplication approach as the other grouping tests: an incident is filed under every
// severity it spans, so collapse by its raw-line set.
function distinctIncidents(parsed) {
  const seen = new Map();
  parsed.by.forEach(bucket => {
    bucket.forEach(inc => {
      const key = inc.ev.map(e => e.raw).sort().join('|');
      if (!seen.has(key)) seen.set(key, inc);
    });
  });
  return [...seen.values()];
}

test('scenario A: a slow interface+OSPF down/up cycle (>300s apart) becomes one incident with an OSPF-appropriate title and a ~6m 20s duration sentence', () => {
  const log = [
    'Sep 25 14:00:10 core-rtr1 %LINK-3-UPDOWN: Interface GigabitEthernet0/1, changed state to down',
    'Sep 25 14:00:12 core-rtr1 %LINEPROTO-5-UPDOWN: Line protocol on Interface GigabitEthernet0/1, changed state to down',
    'Sep 25 14:00:15 core-rtr1 %OSPF-5-ADJCHG: Process 1, Nbr 10.0.12.2 on GigabitEthernet0/1 from FULL to DOWN, Neighbor Down: Interface down or detached',
    'Sep 25 14:06:30 core-rtr1 %LINK-3-UPDOWN: Interface GigabitEthernet0/1, changed state to up',
    'Sep 25 14:06:32 core-rtr1 %LINEPROTO-5-UPDOWN: Line protocol on Interface GigabitEthernet0/1, changed state to up',
    'Sep 25 14:06:35 core-rtr1 %OSPF-5-ADJCHG: Process 1, Nbr 10.0.12.2 on GigabitEthernet0/1 from LOADING to FULL, Loading Done',
  ].join('\n');

  const parsed = parse(log);
  const incidents = distinctIncidents(parsed);
  assert.equal(incidents.length, 1, 'should form a single incident, not two');
  const inc = incidents[0];
  assert.equal(inc.ev.length, 6);
  assert.match(inc.title, /^(Interface flap|OSPF adjacency flap)/);
  assert.match(inc.summary, /was down for approximately 6m 20s before recovering/);
});

test('a >1h gap between DOWN and RECOVERY is not paired: two incidents remain, and the summary says the recovery was late, not absent', () => {
  const log = [
    'Sep 25 14:00:10 core-rtr1 %LINK-3-UPDOWN: Interface GigabitEthernet0/1, changed state to down',
    'Sep 25 15:05:10 core-rtr1 %LINK-3-UPDOWN: Interface GigabitEthernet0/1, changed state to up',
  ].join('\n');

  const parsed = parse(log);
  const incidents = distinctIncidents(parsed);
  assert.equal(incidents.length, 2, 'DOWN and RECOVERY more than 1h apart must stay separate incidents');
  const down = incidents.find(i => i.ev[0].msg.includes('changed state to down'));
  // A recovery DID arrive in this log - it's just outside the 1h correlation window - so saying
  // "no recovery was seen" would be false. The summary must say it recovered late instead.
  assert.doesNotMatch(down.summary, /no recovery was seen/);
  assert.match(down.summary, /did not recover within 1 hour; a later recovery at .+ is outside the correlation window\./);
});

test('an unmatched DOWN (no recovery at all) gets the "no recovery seen" sentence', () => {
  const log = [
    'Sep 25 14:00:10 core-rtr1 %LINK-3-UPDOWN: Interface GigabitEthernet0/3, changed state to down',
    'Sep 25 14:00:12 core-rtr1 %LINEPROTO-5-UPDOWN: Line protocol on Interface GigabitEthernet0/3, changed state to down',
  ].join('\n');

  const parsed = parse(log);
  const incidents = distinctIncidents(parsed);
  assert.equal(incidents.length, 1);
  assert.match(incidents[0].summary, /GigabitEthernet0\/3 went down and no recovery was seen in this log\./);
});

test('a recovery for a DIFFERENT interface does not pair with an unrelated DOWN', () => {
  const log = [
    'Sep 25 14:00:10 core-rtr1 %LINK-3-UPDOWN: Interface GigabitEthernet0/1, changed state to down',
    'Sep 25 14:10:10 core-rtr1 %LINK-3-UPDOWN: Interface GigabitEthernet0/2, changed state to up',
  ].join('\n');

  const parsed = parse(log);
  const incidents = distinctIncidents(parsed);
  assert.equal(incidents.length, 2, 'different interfaces must never bridge into one incident');
  incidents.forEach(inc => assert.doesNotMatch(inc.summary, /before recovering/));
});

test('unrelated events within the hour stay separate (no accidental interface-rule bridging)', () => {
  const log = [
    'Sep 25 14:00:10 core-rtr1 %LINK-3-UPDOWN: Interface GigabitEthernet0/1, changed state to down',
    'Sep 25 14:20:10 core-rtr1 dhcpd 640 DHCPACK: DHCPACK on 10.20.1.44 to 3c:22:fb:00:1a:04 via vlan99',
  ].join('\n');

  const parsed = parse(log);
  const incidents = distinctIncidents(parsed);
  assert.equal(incidents.length, 2);
});

test('scenario B: LINK/LINEPROTO down on two different interfaces within 0.5s stays two incidents, each with an interface-specific title and a related hint pointing at the other', () => {
  const log = [
    'Sep 25 14:00:10.000 core-rtr1 %LINK-3-UPDOWN: Interface GigabitEthernet0/1, changed state to down',
    'Sep 25 14:00:10.100 core-rtr1 %LINEPROTO-5-UPDOWN: Line protocol on Interface GigabitEthernet0/1, changed state to down',
    'Sep 25 14:00:10.400 core-rtr1 %LINK-3-UPDOWN: Interface GigabitEthernet0/2, changed state to down',
    'Sep 25 14:00:10.500 core-rtr1 %LINEPROTO-5-UPDOWN: Line protocol on Interface GigabitEthernet0/2, changed state to down',
  ].join('\n');

  const parsed = parse(log);
  const incidents = distinctIncidents(parsed);
  assert.equal(incidents.length, 2);

  const gi1 = incidents.find(i => i.subject === 'GigabitEthernet0/1');
  const gi2 = incidents.find(i => i.subject === 'GigabitEthernet0/2');
  assert.ok(gi1 && gi2);
  assert.equal(gi1.title, 'Interface down — GigabitEthernet0/1');
  assert.equal(gi2.title, 'Interface down — GigabitEthernet0/2');

  assert.equal(gi1.related.length, 1);
  assert.equal(gi1.related[0].subject, 'GigabitEthernet0/2');
  assert.equal(gi2.related.length, 1);
  assert.equal(gi2.related[0].subject, 'GigabitEthernet0/1');
});

test('a BGP peer Established after 10 minutes pairs into one incident', () => {
  const log = [
    'Sep 25 13:00:10 mx1 rpd[1234]: RPD_BGP_NEIGHBOR_STATE_CHANGED: BGP peer 198.51.100.50 (External AS 64520) changed state from Established to Idle (event Stop)',
    'Sep 25 13:10:10 mx1 rpd[1234]: RPD_BGP_NEIGHBOR_STATE_CHANGED: BGP peer 198.51.100.50 (External AS 64520) changed state from Idle to Established (event RecvKeepAlive)',
  ].join('\n');

  const parsed = parse(log);
  const incidents = distinctIncidents(parsed);
  assert.equal(incidents.length, 1, 'a BGP down->Established pair 10 minutes apart (>300s, <1h) should bridge into one incident');
  assert.match(incidents[0].summary, /BGP peer 198\.51\.100\.50 was down for approximately 10m/);
});

test('a generic "<word> is down/up" wording (no real interface name) does not produce a false pairing', () => {
  const log = [
    'Sep 25 14:00:00 core-rtr1 someapp[123]: Link is down',
    'Sep 25 14:40:00 core-rtr1 someapp[123]: Link is up',
  ].join('\n');

  const parsed = parse(log);
  const incidents = distinctIncidents(parsed);
  assert.equal(incidents.length, 2, '"Link is down"/"Link is up" 40 minutes apart must not merge into one incident');
  incidents.forEach(inc => {
    assert.doesNotMatch(inc.summary, /before recovering/);
    assert.doesNotMatch(inc.summary, /did not recover within 1 hour/);
  });
});

test('other generic single-word "is down/up" wordings (Tunnel, Service) also do not pair or produce an iface state', () => {
  const { stateOf } = SyslogLens;
  assert.equal(stateOf({ msg: 'Tunnel is down', host: 'h1' }), null);
  assert.equal(stateOf({ msg: 'Service is up', host: 'h1' }), null);
});

test('a real interface name in "is down"/"is up" wording (no LINK/LINEPROTO "changed state") still pairs', () => {
  const log = [
    'Sep 25 14:00:00 core-sw7 %ETHPORT-3-IF_DOWN_LINK_FAILURE: Interface Ethernet1/1 is down (Link failure)',
    'Sep 25 14:40:05 core-sw7 %ETHPORT-3-IF_UP: Interface Ethernet1/1 is up',
  ].join('\n');

  const parsed = parse(log);
  const incidents = distinctIncidents(parsed);
  assert.equal(incidents.length, 1, 'a real interface name should still bridge DOWN and RECOVERY across the gap');
  assert.match(incidents[0].summary, /Ethernet1\/1 was down for approximately 40m 5s before recovering/);
});

test('related-hint computation stays fast for 20,000 single-event incidents across 50 hosts (no O(n^2) blowup)', () => {
  const HOSTS = 50, N = 20000;
  const lines = [];
  const base = new Date(2026, 8, 25, 0, 0, 0).getTime();
  for (let i = 0; i < N; i++) {
    const host = `host${i % HOSTS}`;
    // Each event names a distinct interface, so every event is its own incident (no WIN-based
    // grouping across events), and consecutive events on the same host are spaced 10s apart -
    // well outside the 5s related-hint window - so the *correct* related-hint output is empty
    // for all of them; what's under test is how long computing that takes.
    const t = new Date(base + i * 10000);
    const hh = String(t.getHours()).padStart(2, '0');
    const mi = String(t.getMinutes()).padStart(2, '0');
    const ss = String(t.getSeconds()).padStart(2, '0');
    lines.push(`Sep 25 ${hh}:${mi}:${ss} ${host} %LINK-3-UPDOWN: Interface GigabitEthernet0/${i}, changed state to down`);
  }
  const log = lines.join('\n');

  const start = Date.now();
  const parsed = parse(log);
  const elapsed = Date.now() - start;

  const incidents = distinctIncidents(parsed);
  assert.equal(incidents.length, N);
  assert.ok(incidents.every(inc => inc.related.length === 0), 'events 10s apart on the same host are outside the 5s related window');
  assert.ok(elapsed < 1000, `parse+related-hint computation took ${elapsed}ms, expected < 1000ms`);
});

test('network-incidents.log and expected-incidents.json are unaffected by the new pairing logic', () => {
  const LOG_PATH = path.join(__dirname, '..', 'test-data', 'network-incidents.log');
  const EXPECTED_PATH = path.join(__dirname, '..', 'test-data', 'expected-incidents.json');
  const logText = fs.readFileSync(LOG_PATH, 'utf8');
  const expected = JSON.parse(fs.readFileSync(EXPECTED_PATH, 'utf8'));

  const parsed = parse(logText);
  const incidents = distinctIncidents(parsed);

  function eidOf(rawLine) {
    const m = rawLine.match(/eid="([^"]+)"/);
    return m[1];
  }
  const byIds = new Map(incidents.map(inc => [inc.ev.map(e => eidOf(e.raw)).sort().join(','), inc]));
  expected.incidents.forEach(exp => {
    const key = [...exp.event_ids].sort().join(',');
    assert.ok(byIds.has(key), `expected incident ${exp.id} was not found as its own group`);
  });
});
