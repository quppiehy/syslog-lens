'use strict';
// End-to-end Playwright coverage proving the Stage A Content-Security-Policy
// (server/app.js + server/lib/csp.js) doesn't break the app: registers,
// logs in, uses the app, and downloads a report through the real UI in a
// real headless Chromium browser, while listening for (a) any
// `securitypolicyviolation` event fired on any page and (b) any console
// message mentioning a CSP violation ("Content Security Policy" / "Refused
// to"). Both must be empty at the end, and every step must still work.

process.env.DB_STORAGE = ':memory:';
process.env.JWT_SECRET = 'csp-e2e-test-jwt-secret-at-least-32-characters';
process.env.JWT_EXPIRES_IN = '8h';
process.env.COOKIE_SECURE = 'false';
process.env.INVITE_CODE = 'csp-e2e-test-invite-code-12345';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const LOG_PATH = path.join(__dirname, '..', 'test-data', 'network-incidents.log');

let chromium;
try {
  ({ chromium } = require('playwright-core'));
} catch {
  chromium = null;
}

let sequelize;
let app;
let server;
let baseUrl;

test.before(async () => {
  sequelize = require('../server/db');
  app = require('../server/app');
  await sequelize.sync({ force: true });
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (sequelize) await sequelize.close();
});

let counter = 0;
function uniqueEmployeeNumber() {
  counter += 1;
  return `CSP-${process.pid}-${counter}`;
}

// Attaches CSP-violation collection to a page: a real `securitypolicyviolation`
// listener (added before any navigation, via addInitScript, so it's present
// on every document the page loads) plus a console-message scan for the
// phrasing Chromium logs when it blocks something under CSP.
async function watchForCspViolations(page, violations) {
  await page.exposeFunction('__reportCspViolation', (detail) => {
    violations.push({ type: 'securitypolicyviolation', ...detail });
  });
  await page.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', (e) => {
      window.__reportCspViolation({
        violatedDirective: e.violatedDirective,
        blockedURI: e.blockedURI,
        sourceFile: e.sourceFile,
      });
    });
  });
  page.on('console', (msg) => {
    const text = msg.text();
    if (/content security policy|refused to (execute|load|apply)/i.test(text)) {
      violations.push({ type: 'console', text });
    }
  });
}

test(
  'CSP e2e: register, login, use the app, and download reports with zero CSP violations',
  { skip: !chromium && 'playwright-core is not installed' },
  async () => {
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage();
      const violations = [];
      await watchForCspViolations(page, violations);

      const employeeNumber = uniqueEmployeeNumber();
      const name = 'CSP Test User';
      const password = 'correct horse battery staple';

      // Register.
      await page.goto(`${baseUrl}/register`);
      await page.fill('#name', name);
      await page.fill('#employeeNumber', employeeNumber);
      await page.fill('#password', password);
      await page.fill('#confirmPassword', password);
      await page.fill('#inviteCode', process.env.INVITE_CODE);
      await page.click('#submitBtn');
      await page.waitForURL(/\/login\?registered=1/);

      // Login.
      await page.fill('#employeeNumber', employeeNumber);
      await page.fill('#password', password);
      await page.click('#submitBtn');
      await page.waitForURL(`${baseUrl}/`);
      await page.waitForSelector('#whoami:not([hidden])');

      // Use the app: paste the sample log and confirm it parses.
      const logText = fs.readFileSync(LOG_PATH, 'utf8');
      await page.fill('#paste', logText);
      await page.click('#parse');
      await page.waitForSelector('#app:not([hidden])');

      // Generate + download both report types (client-side blob downloads).
      await page.click('#reportb');
      await page.waitForSelector('#reportMenu:not([hidden])');
      const [summaryDownload] = await Promise.all([page.waitForEvent('download'), page.click('#miSummary')]);
      assert.match(summaryDownload.suggestedFilename(), /^syslog-lens-summary-.*\.html$/);

      await page.click('.sv[data-s="5"]');
      await page.waitForSelector('#list .inc');
      await page.click('#list .inc');
      await page.waitForSelector('#detail h2');
      await page.click('#reportb');
      await page.waitForSelector('#reportMenu:not([hidden])');
      const [incidentDownload] = await Promise.all([page.waitForEvent('download'), page.click('#miIncident')]);
      assert.match(incidentDownload.suggestedFilename(), /^syslog-lens-incident-.*\.html$/);

      // Logout, back to /login.
      await page.click('#logoutb');
      await page.waitForURL(/\/login$/);

      assert.deepEqual(violations, [], `expected zero CSP violations, got: ${JSON.stringify(violations, null, 2)}`);
    } finally {
      await browser.close();
    }
  }
);
