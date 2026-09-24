'use strict';
// Timestamps default to the viewer's local time; a header button toggles every displayed
// timestamp to UTC instead, and the choice is remembered in localStorage (best-effort).
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const APP_PATH = path.join(__dirname, '..', 'syslog-lens.html');
const APP_URL = pathToFileURL(APP_PATH).href;
// A single RFC 5424 event with an explicit UTC offset, so its displayed hour differs
// predictably between the two display modes as long as the test machine isn't in UTC itself.
const LOG = '<134>1 2026-09-24T13:14:02.000Z host1 proc 1 MSG - a message';

let chromium;
try {
  ({ chromium } = require('playwright-core'));
} catch {
  chromium = null;
}

test('the UTC/local toggle defaults to local and switches the displayed timestamp to UTC', { skip: !chromium && 'playwright-core is not installed' }, async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(APP_URL);

    // Defaults to local: the button is not labelled "UTC".
    const btn = page.locator('#tzbtn');
    await btn.waitFor();
    assert.notEqual((await btn.textContent()).trim(), 'UTC');

    await page.fill('#paste', LOG);
    await page.click('#parse');
    await page.waitForSelector('#app:not([hidden])');

    const localMeta = await page.locator('#meta').innerText();

    await btn.click();
    assert.equal((await btn.textContent()).trim(), 'UTC');

    const utcMeta = await page.locator('#meta').innerText();
    // 13:14:02 UTC on 2026-09-24 is a fixed instant; displaying it in UTC must show "13:14:02"
    // somewhere in the meta line, regardless of the test machine's own timezone.
    assert.match(utcMeta, /13:14:02/);

    // Toggling only changes display, not the underlying event count/order.
    assert.equal(localMeta.includes('1 event'), utcMeta.includes('1 event'));
  } finally {
    await browser.close();
  }
});

test('the UTC/local choice is persisted to localStorage and restored after a reload', { skip: !chromium && 'playwright-core is not installed' }, async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(APP_URL);
    await page.click('#tzbtn');
    const stored = await page.evaluate(() => localStorage.getItem('syslog-lens-tz'));
    assert.equal(stored, 'utc');

    await page.reload();
    const btn = page.locator('#tzbtn');
    await btn.waitFor();
    assert.equal((await btn.textContent()).trim(), 'UTC');
  } finally {
    await browser.close();
  }
});

test('the app loads and the toggle still works when localStorage throws on every access', { skip: !chromium && 'playwright-core is not installed' }, async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.addInitScript(() => {
      const boom = () => { throw new Error('storage disabled'); };
      Object.defineProperty(window, 'localStorage', {
        get() { return { getItem: boom, setItem: boom, removeItem: boom }; },
      });
    });
    await page.goto(APP_URL);
    const btn = page.locator('#tzbtn');
    await btn.waitFor();
    await btn.click();
    assert.equal((await btn.textContent()).trim(), 'UTC');
  } finally {
    await browser.close();
  }
});
