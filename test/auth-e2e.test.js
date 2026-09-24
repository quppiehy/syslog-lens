'use strict';
// End-to-end Playwright coverage for Stage 5: the full register -> login ->
// use the app -> logout flow, driven through a real headless Chromium
// browser against a real Express server (random port, in-memory DB, test
// JWT secret) — not just unit/integration assertions against fetch().
//
// Uses `playwright-core` directly (not the @playwright/test runner), same
// approach as test/ui-smoke.test.js, so it runs under Node's built-in test
// runner alongside the other suites.

process.env.DB_STORAGE = ':memory:';
process.env.JWT_SECRET = 'e2e-test-jwt-secret-at-least-32-characters-long';
process.env.JWT_EXPIRES_IN = '8h';
process.env.COOKIE_SECURE = 'false';

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
  const { port } = server.address();
  baseUrl = `http://127.0.0.1:${port}`;
});

test.after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (sequelize) await sequelize.close();
});

let counter = 0;
function uniqueEmployeeNumber() {
  counter += 1;
  return `E2E-${process.pid}-${counter}`;
}

test(
  'end-to-end: register, login, use the app, and log out through the real UI',
  { skip: !chromium && 'playwright-core is not installed' },
  async () => {
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage();

      const requests = [];
      page.on('request', (req) => {
        requests.push({ url: req.url(), postData: req.postData() });
      });

      const employeeNumber = uniqueEmployeeNumber();
      const name = 'E2E Test User';
      const password = 'correct horse battery staple';

      // 1. Register via the UI -> redirected to login.
      await page.goto(`${baseUrl}/register`);
      await page.fill('#name', name);
      await page.fill('#employeeNumber', employeeNumber);
      await page.fill('#password', password);
      await page.fill('#confirmPassword', password);
      await page.click('#submitBtn');
      await page.waitForURL(/\/login\?registered=1/);
      const notice = await page.locator('#notice').innerText();
      assert.match(notice, /registration complete/i);

      // 2. A wrong password shows an error and stays on /login.
      await page.fill('#employeeNumber', employeeNumber);
      await page.fill('#password', 'not-the-right-password');
      await page.click('#submitBtn');
      await page.waitForSelector('#error:not(:empty)');
      const loginError = await page.locator('#error').innerText();
      assert.match(loginError, /invalid employee number or password/i);
      assert.match(page.url(), /\/login/);

      // 3. The correct login lands on the app, which shows the user's name.
      await page.fill('#password', password);
      await page.click('#submitBtn');
      await page.waitForURL(`${baseUrl}/`);
      await page.waitForSelector('#whoami:not([hidden])');
      const whoami = await page.locator('#whoami').innerText();
      assert.ok(whoami.includes(name), `expected whoami to include "${name}", got "${whoami}"`);
      assert.ok(whoami.includes(employeeNumber));

      // 4. Reload stays in (the app, not bounced to /login).
      await page.reload();
      await page.waitForSelector('#whoami:not([hidden])');
      assert.match(page.url(), new RegExp(`${baseUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/?$`));

      // 5. Paste the sample log and confirm incidents render (existing
      // functionality untouched), while recording network requests so we
      // can assert none of them ever carry the raw log text.
      const logText = fs.readFileSync(LOG_PATH, 'utf8');
      requests.length = 0; // only care about requests from here on
      await page.fill('#paste', logText);
      await page.click('#parse');
      await page.waitForSelector('#app:not([hidden])');
      const metaText = await page.locator('#meta').innerText();
      assert.match(metaText, /84 events/);

      const distinctiveLogFragment = 'GigabitEthernet0/0/1 changed state to down';
      for (const req of requests) {
        if (req.postData) {
          assert.ok(
            !req.postData.includes(distinctiveLogFragment),
            `request to ${req.url} must not carry log text in its body`
          );
        }
      }
      // Parsing is entirely client-side: no network request at all should
      // have been made for it (only, if any, the auth-cookie-carrying
      // /api/auth/* calls from the header script).
      const nonAuthRequests = requests.filter((r) => !r.url.includes('/api/auth/'));
      assert.equal(nonAuthRequests.filter((r) => r.postData).length, 0, 'no non-auth request should carry a body');

      // 6. Logout -> ends at /login.
      await page.click('#logoutb');
      await page.waitForURL(/\/login$/);

      // 7. page.goBack() does NOT show the app; it stays/ends on /login.
      await page.goBack();
      await page.waitForTimeout(300); // let any client-side redirect settle
      assert.match(page.url(), /\/login/);
      const appHidden = await page.evaluate(() => {
        const el = document.getElementById('app');
        return !el || el.hidden;
      });
      assert.ok(appHidden !== false, 'the app pane must not be visible after going back post-logout');

      // 8. Going directly to /syslog-lens.html while logged out -> /login.
      await page.goto(`${baseUrl}/syslog-lens.html`);
      await page.waitForURL(/\/login$/);
    } finally {
      await browser.close();
    }
  }
);
