// Computes the sha256 CSP hash sources for every inline <script> block
// (i.e. <script> with no src attribute) in the app's own HTML pages, so
// script-src can allow exactly those blocks without resorting to
// 'unsafe-inline'. Run once at startup (app.js requires this module) and
// cached — the HTML files only change at deploy time, not per-request.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PROJECT_ROOT = path.join(__dirname, '..', '..');
const PUBLIC_DIR = path.join(PROJECT_ROOT, 'public');
const APP_HTML_PATH = path.join(PROJECT_ROOT, 'syslog-lens.html');

// Matches every <script ...>...</script> block, capturing its opening-tag
// attributes and exact inline content (including any leading/trailing
// whitespace, which is what the browser actually hashes). Blocks whose
// attributes include src="..." (external scripts) are filtered out below.
const INLINE_SCRIPT_RE = /<script([^>]*)>([\s\S]*?)<\/script>/gi;

function extractInlineScripts(html) {
  const scripts = [];
  let match;
  INLINE_SCRIPT_RE.lastIndex = 0;
  while ((match = INLINE_SCRIPT_RE.exec(html)) !== null) {
    const attrs = match[1];
    const body = match[2];
    if (/\bsrc\s*=/i.test(attrs)) continue; // external script, not inline
    if (body.trim().length === 0) continue; // nothing to hash / not a CSP-relevant block
    scripts.push(body);
  }
  return scripts;
}

function sha256Base64(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('base64');
}

// Returns a de-duplicated array of "'sha256-<base64>'" CSP source strings
// covering every inline script block across syslog-lens.html and every
// public/*.html page.
function computeInlineScriptHashes() {
  const files = [APP_HTML_PATH];
  for (const name of fs.readdirSync(PUBLIC_DIR)) {
    if (name.toLowerCase().endsWith('.html')) {
      files.push(path.join(PUBLIC_DIR, name));
    }
  }

  const hashes = new Set();
  for (const file of files) {
    const html = fs.readFileSync(file, 'utf8');
    for (const script of extractInlineScripts(html)) {
      hashes.add(`'sha256-${sha256Base64(script)}'`);
    }
  }
  return Array.from(hashes);
}

module.exports = { computeInlineScriptHashes, extractInlineScripts };
