'use strict';
// The "many lines weren't recognised" hint (see renderMeta() in syslog-lens.html): when 20%
// or more of the non-comment lines in a loaded log couldn't be parsed, a short notice appears
// near the existing "N lines could not be parsed" chip, set via textContent (never innerHTML)
// so it can't be mistaken for trusted markup. Drives the real page (window.load(), the same
// function the paste/file-drop handlers call) rather than calling parse() directly, since the
// hint is rendered by renderMeta(), a DOM function not exposed on window.SyslogLens.
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadApp } = require('./helpers/load-app');

function meta(window) {
  return window.document.querySelector('#meta');
}

test('at or above the 20% unparsed threshold, the hint appears with the expected text', () => {
  const { window } = loadApp();
  // 4 parseable RFC 3164 lines, 1 unparsed line: 1/5 = 20%, at the threshold.
  const lines = [
    'Sep 25 09:00:00 host1 proc[1]: one',
    'Sep 25 09:00:01 host1 proc[1]: two',
    'Sep 25 09:00:02 host1 proc[1]: three',
    'Sep 25 09:00:03 host1 proc[1]: four',
    'this line matches no supported format at all',
  ].join('\n');
  window.load(lines, 'mostly-ok.log');
  const html = meta(window).innerHTML;
  assert.match(html, /1 line could not be parsed/);
  const hint = window.document.querySelector('#parseHint');
  assert.ok(hint, 'expected the hint element to be present at exactly the 20% threshold');
  assert.match(hint.textContent, /Many lines weren't recognised\. Supported formats:/);
  // Set via textContent, not innerHTML: no child elements/markup, just the text node.
  assert.equal(hint.children.length, 0);
});

test('below the 20% threshold, the chip still shows but the hint does not appear', () => {
  const { window } = loadApp();
  // 9 parseable lines, 1 unparsed: 1/10 = 10%, below the threshold.
  const good = Array.from({ length: 9 }, (_, i) => `Sep 25 09:00:0${i} host1 proc[1]: event ${i}`);
  const lines = [...good, 'this line matches no supported format at all'].join('\n');
  window.load(lines, 'mostly-ok-2.log');
  assert.match(meta(window).innerHTML, /1 line could not be parsed/);
  assert.equal(window.document.querySelector('#parseHint'), null, 'the hint should not appear below the 20% threshold');
});

test('a log with no unparsed lines shows neither the chip nor the hint', () => {
  const { window } = loadApp();
  window.load('Sep 25 09:00:00 host1 proc[1]: all good\n', 'clean.log');
  assert.doesNotMatch(meta(window).innerHTML, /could not be parsed/);
  assert.equal(window.document.querySelector('#parseHint'), null);
});

test('comment lines and blank lines never count toward the 20% unparsed threshold', () => {
  const { window } = loadApp();
  // 4 comment lines + 4 parseable lines + 1 unparsed line: unparsed share is 1/5 (comments
  // and blanks don't count as "lines" for this calculation at all), not 1/9.
  const lines = [
    '# comment one',
    '# comment two',
    '',
    '   # comment three (indented)',
    'Sep 25 09:00:00 host1 proc[1]: one',
    'Sep 25 09:00:01 host1 proc[1]: two',
    'Sep 25 09:00:02 host1 proc[1]: three',
    'Sep 25 09:00:03 host1 proc[1]: four',
    'this line matches no supported format at all',
  ].join('\n');
  window.load(lines, 'with-comments.log');
  const hint = window.document.querySelector('#parseHint');
  assert.ok(hint, 'expected the hint at the 20% threshold once comments/blanks are excluded from the denominator');
});
