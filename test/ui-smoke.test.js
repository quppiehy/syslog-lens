'use strict';
// Light headless-browser smoke test: loads the real single HTML file in
// Chromium, pastes the sample network-incidents.log, and checks that the
// app renders the expected incident list and detail view end-to-end.
// Uses the `playwright-core` browser driver directly (not the
// @playwright/test runner) so it can run under Node's built-in test runner
// alongside the other suites.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const APP_PATH = path.join(__dirname, '..', 'syslog-lens.html');
const LOG_PATH = path.join(__dirname, '..', 'test-data', 'network-incidents.log');

let chromium;
try {
  ({ chromium } = require('playwright-core'));
} catch {
  chromium = null;
}

test('UI smoke: paste network-incidents.log and see the expected incident count', { skip: !chromium && 'playwright-core is not installed' }, async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(pathToFileURL(APP_PATH).href);

    const logText = fs.readFileSync(LOG_PATH, 'utf8');
    await page.fill('#paste', logText);
    await page.click('#parse');

    // The app should leave the intake screen and show the severity rail.
    await page.waitForSelector('#app:not([hidden])');
    const metaText = await page.locator('#meta').innerText();
    assert.match(metaText, /84 events/);

    // Click through to severity 5 (Notice), which has the most incidents,
    // and confirm at least one incident card renders with a title.
    await page.click('.sv[data-s="5"]');
    await page.waitForSelector('#list .inc');
    const firstTitle = await page.locator('#list .inc .t').first().innerText();
    assert.ok(firstTitle.length > 0);

    // Open the first incident and confirm the detail pane renders sections.
    await page.click('#list .inc');
    await page.waitForSelector('#detail .sec[data-sec="sum"]');
    const heading = await page.locator('#detail h2').innerText();
    assert.ok(heading.length > 0);
  } finally {
    await browser.close();
  }
});
