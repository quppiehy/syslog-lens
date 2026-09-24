// Shared helpers for login.html and register.html. Plain script, no
// bundler/framework — matches the rest of the project.
'use strict';

// Renders a message into an aria-live region using textContent only (never
// innerHTML), since the text can include server-provided error strings.
function setMessage(el, text, kind) {
  el.textContent = text || '';
  el.classList.remove('error', 'success');
  if (kind) el.classList.add(kind);
}

async function postJson(url, body) {
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(body),
    });
  } catch (err) {
    return { ok: false, status: 0, data: { error: 'Could not reach the server. Check your connection and try again.' } };
  }

  let data = null;
  try {
    data = await res.json();
  } catch (err) {
    data = null;
  }

  return { ok: res.ok, status: res.status, data };
}

function qs(name) {
  return new URLSearchParams(window.location.search).get(name);
}
