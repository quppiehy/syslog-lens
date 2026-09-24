'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const APP_PATH = path.join(__dirname, '..', '..', 'syslog-lens.html');

/**
 * Loads the real syslog-lens.html file into a jsdom window and runs its
 * inline <script>, so tests exercise the exact code shipped to users
 * (via the window.SyslogLens namespace it exposes for testing) rather
 * than a reimplementation.
 */
function loadApp() {
  const html = fs.readFileSync(APP_PATH, 'utf8');
  const dom = new JSDOM(html, {
    url: 'https://example.invalid/syslog-lens.html',
    runScripts: 'dangerously',
    resources: undefined,
    pretendToBeVisual: true,
  });
  const { window } = dom;
  if (!window.SyslogLens) {
    throw new Error('window.SyslogLens was not exposed by syslog-lens.html');
  }
  return { dom, window, SyslogLens: window.SyslogLens };
}

module.exports = { loadApp, APP_PATH };
