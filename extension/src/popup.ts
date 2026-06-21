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

// ---- drawing mode (per-tab; lives in the content script) ----
const drawBtn = document.getElementById('drawBtn') as HTMLButtonElement;

async function activeTab(): Promise<chrome.tabs.Tab | null> {
  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    return tab ?? null;
  } catch {
    return null;
  }
}

function setDrawBtn(state: 'on' | 'off' | 'unavailable'): void {
  drawBtn.disabled = state === 'unavailable';
  drawBtn.classList.toggle('active', state === 'on');
  drawBtn.textContent =
    state === 'on' ? '■ Stop drawing' : state === 'off' ? '✏️ Draw on this page' : 'Drawing not available here';
}

async function refreshDrawBtn(): Promise<void> {
  const tab = await activeTab();
  if (!tab?.id || !(tab.url || '').startsWith('http')) return setDrawBtn('unavailable');
  try {
    const r = (await chrome.tabs.sendMessage(tab.id, { type: 'draw-query' })) as { drawing?: boolean } | undefined;
    setDrawBtn(r?.drawing ? 'on' : 'off');
  } catch {
    // content script not present yet (page loaded before install/reload). Allow a try anyway.
    setDrawBtn('off');
  }
}

drawBtn.addEventListener('click', async () => {
  const tab = await activeTab();
  if (!tab?.id) return;
  const turningOn = !drawBtn.classList.contains('active');
  if (turningOn) {
    // The annotation only reaches the agent if screenshots are attached — ensure it's on.
    const { settings } = (await chrome.storage.local.get('settings')) as { settings?: Partial<Config> };
    if (!settings?.attachScreenshot) {
      await chrome.storage.local.set({ settings: { ...(settings ?? {}), attachScreenshot: true } });
      attachShotEl.checked = true;
    }
  }
  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'draw', on: turningOn });
  } catch {
    drawBtn.textContent = '↻ Reload the page, then draw';
    return;
  }
  if (turningOn) window.close(); // get out of the way so the user can draw
  else setDrawBtn('off');
});

refreshDrawBtn();
