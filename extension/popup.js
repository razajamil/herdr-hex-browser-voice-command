const DAEMON = 'http://127.0.0.1:8137';

const dotEl = document.getElementById('dot');
const statusEl = document.getElementById('status');
const bodyEl = document.getElementById('body');

function esc(s) {
  return (s || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
function row(k, v) {
  return `<div class="row"><span class="k">${k}</span><span class="v">${v ?? '—'}</span></div>`;
}
function shortUrl(u) {
  if (!u) return null;
  try {
    const x = new URL(u);
    return esc(x.host + x.pathname);
  } catch {
    return esc(u);
  }
}

async function load() {
  let h;
  try {
    const res = await fetch(DAEMON + '/health');
    h = await res.json();
  } catch (_e) {
    dotEl.className = 'dot';
    statusEl.textContent = 'daemon not reachable';
    bodyEl.className = 'muted';
    bodyEl.innerHTML =
      'Start it with:<br><code>launchctl kickstart -k gui/$(id -u)/com.razajamil.voicerouter</code><br>or re-run <code>install.sh</code>.';
    return;
  }

  dotEl.className = 'dot ok';
  statusEl.textContent = `daemon up · v${esc(h.version)} · ${h.uptimeSec}s`;

  let html = '';
  html += row('Transcripts', h.transcriptCount);
  html += row('Hex readable', h.hexHistoryReadable ? 'yes' : '<span style="color:#cf222e">NO</span>');
  html += row('URL timeline', h.timelineSize);
  html += row('Current URL', shortUrl(h.currentUrl));
  html += row('Browser focused', h.browserFocused === null ? 'unknown' : h.browserFocused ? 'yes' : 'no');
  html += row('Routes', h.config && Array.isArray(h.config.routes) ? h.config.routes.length : '—');

  if (h.lastMatch) {
    html +=
      `<div class="card"><div class="k" style="margin-bottom:4px">last routed → ${shortUrl(h.lastMatch.url) || '(no url)'}</div>` +
      `<div>“${esc(h.lastMatch.textPreview)}”</div></div>`;
  } else {
    html += '<div class="card muted">no recordings routed yet</div>';
  }
  bodyEl.className = '';
  bodyEl.innerHTML = html;
}

load();

// ---- settings ----
const DEFAULT_SETTINGS = { requireBrowserFocus: true };
const reqFocusEl = document.getElementById('requireFocus');

async function loadSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  const s = { ...DEFAULT_SETTINGS, ...(settings || {}) };
  reqFocusEl.checked = s.requireBrowserFocus;
}

reqFocusEl.addEventListener('change', async () => {
  const { settings } = await chrome.storage.local.get('settings');
  await chrome.storage.local.set({
    settings: { ...(settings || {}), requireBrowserFocus: reqFocusEl.checked },
  });
});

document.getElementById('manageRoutes').addEventListener('click', () => chrome.runtime.openOptionsPage());

loadSettings();
