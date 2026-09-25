'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadApp } = require('./helpers/load-app');

const { SyslogLens } = loadApp();
const { parse, guess } = SyslogLens;

test('RFC 5424 with <PRI>: parses structured-data line and honours PRI severity', () => {
  const line = '<187>1 2026-09-24T03:14:02.114Z core-rtr1 ifmgr 150 LINK_STATE [synth@32473 eid="E012" synthetic="true"] Interface GigabitEthernet0/0/1 changed state to down';
  const { ev, bad } = parse(line);
  assert.equal(bad.length, 0);
  assert.equal(ev.length, 1);
  const e = ev[0];
  assert.equal(e.host, 'core-rtr1');
  assert.equal(e.proc, 'ifmgr');
  assert.equal(e.msg, 'Interface GigabitEthernet0/0/1 changed state to down');
  // PRI 187 = facility 23, severity 187 & 7 = 3
  assert.equal(e.sev, 3);
  assert.equal(e.t.toISOString(), '2026-09-24T03:14:02.114Z');
});

test('RFC 5424 without <PRI>: parses and falls back to keyword-guessed severity', () => {
  const line = '1 2026-09-24T03:14:02.114Z core-rtr1 ifmgr 150 LINK_STATE [synth@32473 eid="E012" synthetic="true"] Interface GigabitEthernet0/0/1 changed state to down';
  const { ev, bad } = parse(line);
  assert.equal(bad.length, 0);
  assert.equal(ev.length, 1);
  assert.equal(ev[0].host, 'core-rtr1');
  // No PRI, so severity must be guessed from the message text (contains "down").
  assert.equal(ev[0].sev, guess('ifmgr Interface GigabitEthernet0/0/1 changed state to down'));
});

test('RFC 3164 with <PRI>: parses BSD-style header and honours PRI severity', () => {
  const line = '<84>Sep 24 03:20:11 bastion01 sshd[2211]: Failed password for root from 203.0.113.45 port 51102 ssh2';
  const { ev, bad } = parse(line);
  assert.equal(bad.length, 0);
  assert.equal(ev.length, 1);
  const e = ev[0];
  assert.equal(e.host, 'bastion01');
  assert.equal(e.proc, 'sshd');
  assert.equal(e.msg, 'Failed password for root from 203.0.113.45 port 51102 ssh2');
  // PRI 84 = facility 10, severity 84 & 7 = 4
  assert.equal(e.sev, 4);
  // RFC 3164 has no year: the parser assumes the current year.
  assert.equal(e.t.getFullYear(), new Date().getFullYear());
  assert.equal(e.t.getMonth(), 8); // Sep
  assert.equal(e.t.getDate(), 24);
});

test('RFC 3164 without <PRI>: parses and falls back to keyword-guessed severity', () => {
  const line = 'Sep 24 03:20:11 bastion01 sshd[2211]: Failed password for root from 203.0.113.45 port 51102 ssh2';
  const { ev, bad } = parse(line);
  assert.equal(bad.length, 0);
  assert.equal(ev.length, 1);
  const e = ev[0];
  assert.equal(e.host, 'bastion01');
  assert.equal(e.proc, 'sshd');
  // "fail" in the message should guess Error (3).
  assert.equal(e.sev, 3);
  assert.equal(e.sev, guess('sshd Failed password for root from 203.0.113.45 port 51102 ssh2'));
});

test('unparseable lines are counted separately and do not become events', () => {
  const lines = [
    '<187>1 2026-09-24T03:14:02.114Z core-rtr1 ifmgr 150 LINK_STATE - a well-formed line',
    'this line has no timestamp or recognisable syslog header at all',
    '',
    '   ',
  ].join('\n');
  const { ev, bad } = parse(lines);
  assert.equal(ev.length, 1);
  // Blank/whitespace-only lines are skipped outright (not counted as bad);
  // the one genuinely unparseable line is counted.
  assert.equal(bad.length, 1);
  assert.ok(bad.includes('this line has no timestamp or recognisable syslog header at all'));
});

test('comment lines (optional leading whitespace, then "#") are skipped entirely, not counted as unparsed', () => {
  const lines = [
    '# a comment describing this fixture',
    '   # an indented comment',
    '###not a log line either, but still starts with "#"###',
    '<187>1 2026-09-24T03:14:02.114Z core-rtr1 ifmgr 150 LINK_STATE - a well-formed line',
  ].join('\n');
  const { ev, bad } = parse(lines);
  assert.equal(ev.length, 1);
  assert.equal(bad.length, 0, 'all three "#"-led lines should be skipped, not counted as bad');
});

test('guess() infers severity from keywords in the message', () => {
  assert.equal(guess('kernel panic - not syncing'), 0); // emerg/panic -> Emergency
  assert.equal(guess('this is an alert condition'), 1); // alert -> Alert
  assert.equal(guess('a critical failure occurred'), 2); // crit -> Critical
  assert.equal(guess('connection failed'), 3); // fail -> Error
  assert.equal(guess('access denied for user'), 3); // denied -> Error
  assert.equal(guess('link changed state to down'), 3); // \bdown\b -> Error
  assert.equal(guess('cpu warning threshold reached'), 4); // warn -> Warning
  assert.equal(guess('topology notice: change detected'), 5); // notice -> Notice
  assert.equal(guess('debug: arp table refresh'), 7); // debug -> Debug
  assert.equal(guess('routine informational message'), 6); // no keyword -> Informational (default)
});
