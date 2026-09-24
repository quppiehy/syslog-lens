'use strict';
// A line with no <PRI> gets its severity guessed from keywords; the app must
// flag that visibly (not by colour alone) wherever the event's severity is
// shown. Unit-tests the parser's `guessed` flag, then drives a real browser
// to check the flag actually renders in the timeline and raw-details sections.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { loadApp } = require('./helpers/load-app');

const { SyslogLens } = loadApp();
const { parse } = SyslogLens;

test('parse() marks events with no <PRI> as guessed, and PRI-bearing events as not guessed', () => {
  const withPri = '<84>Sep 24 03:20:11 bastion01 sshd[2211]: Failed password for root from 203.0.113.45 port 51102 ssh2';
  const withoutPri = 'Sep 24 03:20:11 bastion01 sshd[2211]: Failed password for root from 203.0.113.45 port 51102 ssh2';

  const a = parse(withPri).ev[0];
  const b = parse(withoutPri).ev[0];

  assert.equal(a.guessed, false);
  assert.equal(b.guessed, true);
  // With <PRI>, severity comes from the header (84 & 7 = 4, Warning).
  assert.equal(a.sev, 4);
  // Without <PRI>, severity is guessed from the message text ("fail" -> Error).
  assert.equal(b.sev, 3);
});

const APP_PATH = path.join(__dirname, '..', 'syslog-lens.html');

let chromium;
try {
  ({ chromium } = require('playwright-core'));
} catch {
  chromium = null;
}

test('UI: a guessed severity shows a visible "guessed" tag in the timeline and raw details, a PRI severity does not', { skip: !chromium && 'playwright-core is not installed' }, async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(pathToFileURL(APP_PATH).href);

    // One line with <PRI> decoding to severity 4 (Warning), one without a
    // <PRI> whose message contains "warning" so guess() also lands on 4.
    // Different hosts/processes so they land in separate incidents and are
    // easy to tell apart in the detail pane.
    const log = [
      '<84>Sep 24 03:20:11 bastion01 sshd[2211]: Failed password for root from 203.0.113.45 port 51102 ssh2',
      'Sep 24 03:25:11 edge-rtr9 ifmgr[200]: CPU warning threshold reached on uplink',
    ].join('\n');
    await page.fill('#paste', log);
    await page.click('#parse');
    await page.waitForSelector('#app:not([hidden])');

    await page.click('.sv[data-s="4"]');
    await page.waitForSelector('#list .inc');

    const incidents = page.locator('#list .inc');
    const count = await incidents.count();
    assert.ok(count >= 2, `expected at least 2 incidents at severity 4, got ${count}`);

    let sawGuessedTag = false;
    let sawUnflagged = false;
    for (let i = 0; i < count; i++) {
      await page.click(`#list .inc >> nth=${i}`);
      await page.waitForSelector('#detail .sec[data-sec="tl"]');
      const tagCount = await page.locator('#detail .sec[data-sec="tl"] .tl > li .tag').count();
      if (tagCount > 0) sawGuessedTag = true; else sawUnflagged = true;
    }
    assert.ok(sawGuessedTag, 'expected at least one timeline event to carry a "guessed" tag');
    assert.ok(sawUnflagged, 'expected the PRI-bearing event to render without a "guessed" tag');

    // The tag communicates via visible text/title, not colour alone.
    const tag = page.locator('#detail .sec[data-sec="tl"] .tl > li .tag').first();
    await tag.waitFor();
    assert.match((await tag.innerText()).toLowerCase(), /guess/);
    const title = await tag.getAttribute('title');
    assert.ok(title && title.length > 0);

    // Raw event details section also flags the guessed line.
    const rawSection = page.locator('#detail .sec[data-sec="raw"]');
    await rawSection.locator('summary').click();
    const rawTag = rawSection.locator('.tag').first();
    const rawTagCount = await rawSection.locator('.tag').count();
    assert.ok(rawTagCount > 0, 'expected the Raw event details section to flag the guessed line too');

    // The tag must stay visible but be excluded from a text selection/copy of
    // the raw block, so copying the raw lines never picks up "guessed".
    const userSelect = await rawTag.evaluate(el => getComputedStyle(el).userSelect);
    assert.equal(userSelect, 'none', 'the "guessed" tag inside Raw event details must be non-selectable');
    await expectVisible(rawTag);
  } finally {
    await browser.close();
  }
});

async function expectVisible(locator) {
  const box = await locator.boundingBox();
  assert.ok(box && box.width > 0 && box.height > 0, 'the "guessed" tag must remain visible even though it is non-selectable');
}
