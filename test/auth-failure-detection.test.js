'use strict';
// Covers the vendor-neutral isAuthFailure() predicate (syslog-lens.html) that the 'auth'
// INCIDENT_RULES entry uses to count failed logins in its summary text. Before this fix, the
// summary's count regex only recognised OpenSSH wording ("Failed password" / "authentication
// failure"), so a Cisco SEC_LOGIN/LOGIN_FAILED incident (test-data/cisco_syslog_test.log's
// bastion01 group) reported "0 failed logins" despite being grouped and titled correctly.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadApp } = require('./helpers/load-app');

const { SyslogLens } = loadApp();
const { parse, isAuthFailure } = SyslogLens;

function distinctIncidents(parsed) {
  return [...new Set(parsed.by.flat())];
}

test('isAuthFailure is exposed on window.SyslogLens', () => {
  assert.equal(typeof isAuthFailure, 'function');
});

test('bastion01 incident in cisco_syslog_test.log reports exactly 5 failed logins (was 0 before the fix)', () => {
  const logPath = path.join(__dirname, '..', 'test-data', 'cisco_syslog_test.log');
  const logText = fs.readFileSync(logPath, 'utf8');
  const incidents = distinctIncidents(parse(logText));
  const inc = incidents.find(i => i.host === 'bastion01' && i.ev.some(e => e.msg.includes('Login failed')));
  assert.ok(inc, 'expected a bastion01 SEC_LOGIN incident');
  assert.equal(inc.ev.length, 6, '5 LOGIN_FAILED + 1 QUIET_MODE_ON');
  assert.equal(inc.title, 'Repeated authentication failures — source 192.0.2.50');
  assert.match(inc.summary, /includes 5 failed logins/, `summary should count 5 failed logins, got: ${inc.summary}`);
});

test('isAuthFailure: positive examples across vendors', () => {
  const positives = [
    // OpenSSH
    { proc: 'sshd', msg: 'Failed password for root from 203.0.113.45 port 51102 ssh2' },
    { proc: 'sshd', msg: 'Failed password for invalid user admin from 203.0.113.45 port 51140 ssh2' },
    { proc: 'sshd', msg: 'pam_unix(sshd:auth): authentication failure; logname= uid=0 euid=0 rhost=203.0.113.45 user=root' },
    { proc: 'sshd', msg: 'Invalid user test from 203.0.113.45 port 51102' },
    // Cisco
    { proc: 'SEC_LOGIN', msg: 'Login failed [user: admin] [Source: 192.0.2.50] [localport: 22]' },
    { proc: 'SEC_LOGIN', msg: 'Login failed [user: netadmin] [Source: 192.0.2.50] [localport: 22]' },
    // Juniper
    { proc: 'sshd', msg: 'SSHD_LOGIN_FAILED: Login failed for user admin from host 198.51.100.9' },
    { proc: 'rpd', msg: 'LOGIN_FAILED: authentication failed for user admin' },
    // FortiGate
    { proc: 'event/system', msg: 'logdesc="Admin login failed" sn="1" user="admin" reason="invalid password"' },
    { proc: 'event/system', msg: 'devname="fgt1" action="login" status="failed" user="admin"' },
    // Generic auth-word-near-fail-word phrasing
    { proc: 'app', msg: 'logon denied for user bob' },
    { proc: 'app', msg: 'password rejected for account svc-deploy' },
  ];
  positives.forEach(e => assert.equal(isAuthFailure(e), true, `expected failure for: ${e.msg}`));
});

test('isAuthFailure: negative examples (no false positives)', () => {
  const negatives = [
    { proc: 'sshd', msg: 'Accepted password for root from 203.0.113.45 port 51102 ssh2' },
    { proc: 'sshd', msg: 'Login successful for user admin from 192.0.2.50' },
    { proc: 'pam', msg: 'authentication succeeded for user root' },
    { proc: 'pam', msg: 'password changed for user alice' },
    { proc: 'SEC_LOGIN', msg: 'Still time to wait, [user: admin] [Source: 192.0.2.50]' },
    { proc: 'SEC_LOGIN', msg: 'QUIET_MODE_ON: Still time to wait, [user: admin] [Source: 192.0.2.50]' },
    { proc: 'sshd', msg: 'error: maximum authentication attempts exceeded for root from 203.0.113.45 port 51188 ssh2 [preauth]' },
    { proc: 'sshd', msg: 'Connection closed by authenticating user root 203.0.113.45 port 51188 [preauth]' },
    { proc: 'fail2ban', msg: '[sshd] Ban 203.0.113.45' },
    { proc: 'stpd', msg: 'Spanning tree topology change on VLAN 20, port GigabitEthernet1/0/12' },
  ];
  negatives.forEach(e => assert.equal(isAuthFailure(e), false, `expected NOT a failure for: ${e.msg}`));
});

test('cisco_syslog_messy_stress_test.log: bastion01 wave counts are consistent with their LOGIN_FAILED line counts', () => {
  const logPath = path.join(__dirname, '..', 'test-data', 'cisco_syslog_messy_stress_test.log');
  const logText = fs.readFileSync(logPath, 'utf8');
  const parsed = parse(logText);
  const incidents = distinctIncidents(parsed).filter(i => i.host === 'bastion01' && i.title.startsWith('Repeated authentication failures'));
  assert.ok(incidents.length > 0, 'expected at least one bastion01 auth incident in the messy stress log');

  incidents.forEach(inc => {
    const loginFailedLines = inc.ev.filter(e => /LOGIN_FAILED/.test(e.raw) || /Login failed/.test(e.msg)).length;
    const m = inc.summary.match(/includes (\d+) failed logins/);
    assert.ok(m, `summary should report a failed-login count: ${inc.summary}`);
    assert.equal(Number(m[1]), loginFailedLines,
      `incident summary count should equal the number of LOGIN_FAILED lines in its event set (host=${inc.host}, n=${inc.ev.length})`);
  });
});
