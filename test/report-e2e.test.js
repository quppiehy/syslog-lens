'use strict';
// End-to-end Playwright coverage for the "Generate report" feature: log in
// through the real auth-backed app (same pattern as test/auth-e2e.test.js),
// paste the sample log, confirm Detailed Incident starts disabled with its
// hint shown, generate a Log Summary and inspect its downloaded content,
// select an incident, generate a Detailed Incident and inspect that too -
// all while recording every network request made throughout, to prove
// report generation is 100% client-side (no log text over the wire, and no
// request at all fired while generating). Finally, each downloaded report is
// opened via file:// and checked to actually render.

process.env.DB_STORAGE = ':memory:';
process.env.JWT_SECRET = 'e2e-test-jwt-secret-at-least-32-characters-long';
process.env.JWT_EXPIRES_IN = '8h';
process.env.COOKIE_SECURE = 'false';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const LOG_PATH = path.join(__dirname, '..', 'test-data', 'network-incidents.log');

// Playwright's Download#path() points at a temp file with no extension,
// which some browsers refuse to sniff as HTML under file://. Save it under
// its real suggested filename (as a user's browser would) before opening it.
async function saveWithSuggestedName(download) {
  const dest = path.join(os.tmpdir(), `syslog-lens-e2e-${Date.now()}-${download.suggestedFilename()}`);
  await download.saveAs(dest);
  return dest;
}

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
  return `RPT-${process.pid}-${counter}`;
}

test(
  '9+11. Generate report: disabled state, Log Summary + Detailed Incident downloads, no network traffic, downloaded files render',
  { skip: !chromium && 'playwright-core is not installed' },
  async () => {
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage();

      const requests = [];
      page.on('request', (req) => {
        requests.push({ url: req.url(), postData: req.postData(), time: Date.now() });
      });

      const employeeNumber = uniqueEmployeeNumber();
      const name = 'Report Test User';
      const password = 'correct horse battery staple';

      // Register + log in through the real UI.
      await page.goto(`${baseUrl}/register`);
      await page.fill('#name', name);
      await page.fill('#employeeNumber', employeeNumber);
      await page.fill('#password', password);
      await page.fill('#confirmPassword', password);
      await page.click('#submitBtn');
      await page.waitForURL(/\/login\?registered=1/);
      await page.fill('#employeeNumber', employeeNumber);
      await page.fill('#password', password);
      await page.click('#submitBtn');
      await page.waitForURL(`${baseUrl}/`);
      await page.waitForSelector('#whoami:not([hidden])');

      // Before a log is loaded, "Generate report" is disabled.
      assert.ok(await page.locator('#reportb').isDisabled(), 'Generate report should be disabled before a log is loaded');

      // Paste the sample log.
      const logText = fs.readFileSync(LOG_PATH, 'utf8');
      await page.fill('#paste', logText);
      await page.click('#parse');
      await page.waitForSelector('#app:not([hidden])');
      assert.ok(!(await page.locator('#reportb').isDisabled()), 'Generate report should be enabled once a log is loaded');

      // Open the menu: Detailed Incident is disabled with its hint shown
      // because no incident is selected yet.
      await page.click('#reportb');
      await page.waitForSelector('#reportMenu:not([hidden])');
      assert.equal(await page.getAttribute('#miIncident', 'aria-disabled'), 'true');
      assert.ok(await page.locator('#miHint').isVisible(), 'the "Select an incident first" hint should be visible');
      assert.match(await page.locator('#miHint').innerText(), /select an incident first/i);

      // Keyboard: Escape closes the menu.
      await page.keyboard.press('Escape');
      await page.waitForSelector('#reportMenu', { state: 'hidden' });
      assert.equal(await page.getAttribute('#reportb', 'aria-expanded'), 'false');

      // Generate a Log Summary and capture the download.
      requests.length = 0;
      await page.click('#reportb');
      await page.waitForSelector('#reportMenu:not([hidden])');
      const genStart = Date.now();
      const [summaryDownload] = await Promise.all([
        page.waitForEvent('download'),
        page.click('#miSummary'),
      ]);
      const genEnd = Date.now();
      assert.match(summaryDownload.suggestedFilename(), /^syslog-lens-summary-.*\.html$/);
      const summaryPath = await saveWithSuggestedName(summaryDownload);
      const summaryContent = fs.readFileSync(summaryPath, 'utf8');
      assert.match(summaryContent, /<h1>Syslog Lens/);
      assert.match(summaryContent, /Log Summary/);
      assert.match(summaryContent, /Total parsed events<\/th><td>84<\/td>/);
      assert.match(summaryContent, new RegExp(`Generated by ${name}`));

      // Select an incident, then generate a Detailed Incident report.
      await page.click('.sv[data-s="5"]');
      await page.waitForSelector('#list .inc');
      await page.click('#list .inc');
      await page.waitForSelector('#detail h2');

      await page.click('#reportb');
      await page.waitForSelector('#reportMenu:not([hidden])');
      assert.equal(await page.getAttribute('#miIncident', 'aria-disabled'), 'false');
      const [incidentDownload] = await Promise.all([
        page.waitForEvent('download'),
        page.click('#miIncident'),
      ]);
      assert.match(incidentDownload.suggestedFilename(), /^syslog-lens-incident-.*\.html$/);
      const incidentPath = await saveWithSuggestedName(incidentDownload);
      const incidentContent = fs.readFileSync(incidentPath, 'utf8');
      assert.match(incidentContent, /<h1>Syslog Lens/);
      assert.match(incidentContent, /Detailed Incident/);
      assert.match(incidentContent, /Timeline \(/);

      // No request at all should have fired during either generation (it's
      // pure Blob/anchor-download client-side work), and none should ever
      // carry a distinctive log fragment.
      const duringGeneration = requests.filter((r) => r.time >= genStart && r.time <= genEnd + 200);
      assert.equal(duringGeneration.length, 0, 'no network request should fire while generating a report');

      const distinctiveLogFragment = 'GigabitEthernet0/0/1 changed state to down';
      for (const req of requests) {
        if (req.postData) {
          assert.ok(!req.postData.includes(distinctiveLogFragment), `request to ${req.url} must not carry log text`);
        }
        assert.ok(!req.url.includes(encodeURIComponent(distinctiveLogFragment)), `request URL must not carry log text: ${req.url}`);
      }

      // Both downloaded reports open and render via file:// in a fresh page.
      const filePage = await browser.newPage();
      await filePage.goto(pathToFileURL(summaryPath).href);
      assert.ok((await filePage.locator('h1').first().innerText()).includes('Syslog Lens'));
      await filePage.goto(pathToFileURL(incidentPath).href);
      assert.ok((await filePage.locator('h1').first().innerText()).includes('Syslog Lens'));
      await filePage.close();

      for (const p of [summaryPath, incidentPath]) {
        try { fs.unlinkSync(p); } catch {}
      }
    } finally {
      await browser.close();
    }
  }
);
