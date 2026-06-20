import { ConfigSchema, type Config } from '../../shared/config-schema';

const DAEMON = 'http://127.0.0.1:8137';

const dotEl = document.getElementById('dot')!;
const statusEl = document.getElementById('status')!;
const bodyEl = document.getElementById('body')!;

function esc(s: string | null | undefined): string {
  const map: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
  return (s || '').replace(/[&<>"]/g, (c) => map[c]);
}
function row(k: string, v: unknown): string {
  return `<div class="row"><span class="k">${k}</span><span class="v">${v ?? '—'}</span></div>`;
}
function shortUrl(u: string | null | undefined): string | null {
  if (!u) return null;
  try {
    const x = new URL(u);
    return esc(x.host + x.pathname);
  } catch {
    return esc(u);
  }
}
function ago(ts: number): string {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  return m < 60 ? `${m}m ago` : `${Math.round(m / 60)}h ago`;
}

async function load(): Promise<void> {
  let h: any;
  try {
    const res = await fetch(DAEMON + '/health');
    h = await res.json();
  } catch {
    dotEl.className = 'dot';
    statusEl.textContent = 'daemon not reachable';
    bodyEl.className = 'muted';
    bodyEl.innerHTML =
      'Start it with:<br><code>launchctl kickstart -k gui/$(id -u)/com.razajamil.voicerouter</code><br>or re-run <code>install.sh</code>.';
    return;
  }

  dotEl.className = 'dot ok';
  statusEl.textContent = `daemon up · v${esc(h.version)} · ${h.uptimeSec}s`;

  // Validate the config we received back from the daemon.
  const cfgParsed = ConfigSchema.safeParse(h.config);
  const routeCount: number | string = cfgParsed.success ? cfgParsed.data.routes?.length ?? 0 : '—';

  let html = '';
  html += row('Transcripts', h.transcriptCount);
  html += row('Hex readable', h.hexHistoryReadable ? 'yes' : '<span style="color:#cf222e">NO</span>');
  html += row('URL timeline', h.timelineSize);
  html += row('Current URL', shortUrl(h.currentUrl));
  html += row('Browser focused', h.browserFocused === null ? 'unknown' : h.browserFocused ? 'yes' : 'no');
  html += row('Routes', routeCount);

  // Screenshot indicator (only when the feature is on). lastScreenshotAt = the daemon
  // actually received a shot (true end-to-end); the extension's own status surfaces the
  // capture error when nothing is getting through.
  if (h.config?.attachScreenshot) {
    const shotStatus = (await chrome.storage.local.get('screenshotStatus')).screenshotStatus as
      | { ok: boolean; ts: number; error?: string }
      | undefined;
    let v: string;
    if (h.lastScreenshotAt) v = `${ago(h.lastScreenshotAt)} · ${h.screenshotCount} buffered`;
    else if (shotStatus && !shotStatus.ok) v = '<span style="color:#cf222e">capture failing</span>';
    else v = '<span class="muted">none yet</span>';
    html += row('Screenshots', v);
    if (!h.lastScreenshotAt && shotStatus && !shotStatus.ok && shotStatus.error) {
      html += `<div class="card" style="color:#cf222e">${esc(shotStatus.error)}</div>`;
    }
  }

  if (h.lastMatch) {
    const shot = h.lastMatch.screenshot ? ' <span title="screenshot attached">📷</span>' : '';
    html +=
      `<div class="card"><div class="k" style="margin-bottom:4px">last routed → ${shortUrl(h.lastMatch.url) || '(no url)'}${shot}</div>` +
      `<div>"${esc(h.lastMatch.textPreview)}"</div></div>`;
  } else {
    html += '<div class="card muted">no recordings routed yet</div>';
  }
  bodyEl.className = '';
  bodyEl.innerHTML = html;
}

load();

// ---- settings ----
const reqFocusEl = document.getElementById('requireFocus') as HTMLInputElement;
const attachShotEl = document.getElementById('attachScreenshot') as HTMLInputElement;

async function loadSettings(): Promise<void> {
  const stored = (await chrome.storage.local.get('settings')).settings as Partial<Config> | undefined;
  reqFocusEl.checked = stored ? stored.requireBrowserFocus !== false : true;
  attachShotEl.checked = !!stored?.attachScreenshot;
}

reqFocusEl.addEventListener('change', async () => {
  const { settings } = await chrome.storage.local.get('settings');
  await chrome.storage.local.set({
    settings: { ...(settings ?? {}), requireBrowserFocus: reqFocusEl.checked },
  });
});

attachShotEl.addEventListener('change', async () => {
  const { settings } = await chrome.storage.local.get('settings');
  await chrome.storage.local.set({
    settings: { ...(settings ?? {}), attachScreenshot: attachShotEl.checked },
  });
});

document.getElementById('manageRoutes')!.addEventListener('click', () => chrome.runtime.openOptionsPage());

loadSettings();
