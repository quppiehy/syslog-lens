'use strict';
// The "Try a sample log" button embeds network-incidents.log verbatim in
// syslog-lens.html (fetch() can't read local files under file://). This test
// asserts the embedded copy is byte-identical to the source file, so they
// can't silently drift apart.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const APP_PATH = path.join(__dirname, '..', 'syslog-lens.html');
const LOG_PATH = path.join(__dirname, '..', 'test-data', 'network-incidents.log');

test('the embedded SAMPLE_LOG string is identical to test-data/network-incidents.log', () => {
  const html = fs.readFileSync(APP_PATH, 'utf8');
  const m = html.match(/const SAMPLE_LOG=("(?:[^"\\]|\\.)*")/);
  assert.ok(m, 'SAMPLE_LOG constant not found in syslog-lens.html');
  const embedded = JSON.parse(m[1]);
  const fileText = fs.readFileSync(LOG_PATH, 'utf8');
  assert.equal(embedded, fileText);
});

test('the sample button loads SAMPLE_LOG, not fetch(), and names the file network-incidents.log', () => {
  const html = fs.readFileSync(APP_PATH, 'utf8');
  assert.match(html, /\$\('#demo'\)\.onclick=\(\)=>load\(SAMPLE_LOG,'network-incidents\.log'\);/);
  // Guard against a regression back to a fetch()-based sample loader, which
  // silently fails under file:// (the app's primary supported context).
  assert.doesNotMatch(html, /\$\('#demo'\)\.onclick=[^;]*fetch\(/);
});
