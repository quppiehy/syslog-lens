'use strict';
// The pane-divider width should be remembered across visits via localStorage,
// clamped to the usual min-width limits on restore, and the app should work
// normally when storage throws (e.g. blocked in some browser contexts).
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const APP_PATH = path.join(__dirname, '..', 'syslog-lens.html');
const APP_URL = pathToFileURL(APP_PATH).href;
const LOG = '<30>Sep 24 03:01:12 host1 proc[1]: a message';

let chromium;
try {
  ({ chromium } = require('playwright-core'));
} catch {
  chromium = null;
}

test('the pane-divider width is saved to localStorage and restored (clamped) after a reload', { skip: !chromium && 'playwright-core is not installed' }, async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.setViewportSize({ width: 1400, height: 900 });
    await page.goto(APP_URL);
    await page.fill('#paste', LOG);
    await page.click('#parse');
    await page.waitForSelector('#app:not([hidden])');

    // Move the divider to its maximum width via the keyboard (End key),
    // which should persist the new width.
    const rz = page.locator('#rz');
    await rz.focus();
    await page.keyboard.press('End');
    const valuenow = await rz.getAttribute('aria-valuenow');
    assert.ok(Number(valuenow) > 260, 'expected the divider to have moved past the minimum width');

    const stored = await page.evaluate(() => localStorage.getItem('syslog-lens-mid'));
    assert.ok(stored, 'expected the width to be written to localStorage');
    assert.equal(Number(stored), Number(valuenow));

    // Reload and re-parse the log; the saved width should be restored.
    await page.reload();
    await page.fill('#paste', LOG);
    await page.click('#parse');
    await page.waitForSelector('#app:not([hidden])');
    const restoredMid = await page.evaluate(() => getComputedStyle(document.getElementById('app')).getPropertyValue('--mid').trim());
    assert.equal(restoredMid, `${stored}px`);
  } finally {
    await browser.close();
  }
});

test('a nonsense/out-of-range stored width is clamped to the minimum on restore', { skip: !chromium && 'playwright-core is not installed' }, async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.setViewportSize({ width: 1400, height: 900 });
    await page.addInitScript(() => {
      try { localStorage.setItem('syslog-lens-mid', '5'); } catch {}
    });
    await page.goto(APP_URL);
    await page.fill('#paste', LOG);
    await page.click('#parse');
    await page.waitForSelector('#app:not([hidden])');
    const mid = await page.evaluate(() => getComputedStyle(document.getElementById('app')).getPropertyValue('--mid').trim());
    // MIN is 260px in the app's resize logic; a stored value below that must
    // still be clamped up to the minimum, not applied verbatim.
    assert.equal(mid, '260px');
  } finally {
    await browser.close();
  }
});

test('the app loads and functions normally when localStorage throws on every access', { skip: !chromium && 'playwright-core is not installed' }, async () => {
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
    await page.fill('#paste', LOG);
    await page.click('#parse');
    await page.waitForSelector('#app:not([hidden])');
    // The app should still be fully usable: incident list and detail work.
    const meta = await page.locator('#meta').innerText();
    assert.match(meta, /1 event/);

    // Resizing via the keyboard should still work even though persistence
    // throws internally on every save/restore attempt.
    const rz = page.locator('#rz');
    await rz.focus();
    await page.keyboard.press('End');
    const valuenow = await rz.getAttribute('aria-valuenow');
    assert.ok(Number(valuenow) > 260);
  } finally {
    await browser.close();
  }
});
