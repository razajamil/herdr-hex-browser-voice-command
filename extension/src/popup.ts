import { type Config, type Route } from '../../shared/config-schema';
import { matchRoute } from '../../shared/url-match';

const DAEMON = 'http://127.0.0.1:8137';
const checksEl = document.getElementById('checks')!;

function esc(s: string | null | undefined): string {
  const map: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
  return (s || '').replace(/[&<>"]/g, (c) => map[c]);
}
function ago(ts: number): string {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  return m < 60 ? `${m}m ago` : `${Math.round(m / 60)}h ago`;
}

type DotState = 'ok' | 'bad' | 'warn' | 'off';
function check(state: DotState, label: string, value: string, title?: string): string {
  const cls = state === 'off' ? '' : ` ${state}`;
  const t = title ? ` title="${esc(title)}"` : '';
  return (
    `<div class="check"${t}><span class="dot${cls}"></span>` +
    `<span class="label">${label}</span><span class="val">${value}</span></div>`
  );
}

async function currentTabUrl(): Promise<string | null> {
  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    return tab?.url ?? null;
  } catch {
    return null;
  }
}

// Routes from the daemon's synced config when up, else from local settings (offline view).
async function routesFrom(h: any): Promise<Route[]> {
  if (h?.config?.routes) return h.config.routes as Route[];
  const stored = (await chrome.storage.local.get('settings')).settings as Partial<Config> | undefined;
  return (stored?.routes as Route[] | undefined) ?? [];
}

async function renderStatus(): Promise<void> {
  let h: any = null;
  try {
    h = await (await fetch(DAEMON + '/health')).json();
  } catch {
    h = null;
  }

  const url = await currentTabUrl();
  const matched = matchRoute(url, await routesFrom(h));

  let html = '';
  html += check(h ? 'ok' : 'bad', 'Daemon', h ? 'up' : 'not reachable');
  html += check(
    h ? (h.hexHistoryReadable ? 'ok' : 'bad') : 'off',
    'Hex',
    h ? (h.hexHistoryReadable ? 'available' : 'unreadable') : '—'
  );

  const lm = h?.lastMatch;
  const value = lm ? ago(lm.at) + (lm.screenshot ? ' 📷' : '') : 'none yet';
  html += check(lm ? 'ok' : 'off', 'Last match', value, lm?.textPreview);

  html += check(
    matched ? 'ok' : 'warn',
    'Current tab',
    matched ? esc(matched.route.name) : 'no rule matches',
    url || undefined
  );

  if (!h) {
    html +=
      '<div class="hintcard">Daemon down — restart:<br>' +
      '<code>launchctl kickstart -k gui/$(id -u)/com.razajamil.voicerouter</code></div>';
  }
  checksEl.className = '';
  checksEl.innerHTML = html;
}

renderStatus();

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
