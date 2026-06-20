// Voice Router — background service worker.
// Streams the active tab's URL + window focus to the daemon, mirrors settings to it as
// config (validated against the shared Zod schema), and reflects daemon health in the badge.

import { ConfigSchema, type Config } from '../../shared/config-schema';

const DAEMON = 'http://127.0.0.1:8137';

async function post(p: string, body: unknown): Promise<boolean> {
  try {
    const res = await fetch(DAEMON + p, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// ---- settings (validated, then mirrored to the daemon as config) ----
const DEFAULT_SETTINGS: Config = {
  requireBrowserFocus: true,
  routes: [
    { name: 'Payroll dev', urlPattern: 'http://{workspace}.payroll.localhost/*', tabName: 'main', paneName: 'agent' },
  ],
};

async function getSettings(): Promise<Config> {
  const { settings } = await chrome.storage.local.get('settings');
  const merged = { ...DEFAULT_SETTINGS, ...(settings ?? {}) };
  const parsed = ConfigSchema.safeParse(merged);
  return parsed.success ? { ...DEFAULT_SETTINGS, ...parsed.data } : DEFAULT_SETTINGS;
}

async function pushConfig(): Promise<void> {
  const s = await getSettings();
  await post('/config', { requireBrowserFocus: s.requireBrowserFocus, routes: s.routes });
}

async function reportFocus(focused: boolean): Promise<void> {
  await post('/focus', { focused, ts: Date.now() });
}

function isTrackable(url: string | undefined): url is string {
  return !!url && (url.startsWith('http://') || url.startsWith('https://'));
}

async function reportTab(tab: chrome.tabs.Tab | undefined): Promise<void> {
  if (!tab || !isTrackable(tab.url)) return;
  await post('/active-url', { url: tab.url, tabId: tab.id, title: tab.title || null, ts: Date.now() });
}

async function reportActive(): Promise<void> {
  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (tab) await reportTab(tab);
  } catch {
    /* ignore */
  }
}

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  try {
    const tab = await chrome.tabs.get(tabId);
    await reportTab(tab);
  } catch {
    /* ignore */
  }
});

chrome.tabs.onUpdated.addListener((_tabId, info, tab) => {
  if (info.status === 'complete' || info.url) reportTab(tab);
});

chrome.windows.onFocusChanged.addListener((winId) => {
  const focused = winId !== chrome.windows.WINDOW_ID_NONE;
  reportFocus(focused);
  if (focused) reportActive();
});

// Keep the daemon in sync whenever the user toggles a setting.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.settings) pushConfig();
});

// Optional: key gestures from the content script -> recording phases.
chrome.runtime.onMessage.addListener((msg, sender) => {
  if (!msg || msg.type !== 'gesture') return;
  const tab = sender.tab;
  if (msg.gesture === 'meta-double') {
    post('/recording', { phase: 'start', url: tab?.url, title: tab?.title, tabId: tab?.id, ts: Date.now() });
  } else if (msg.gesture === 'meta-single') {
    post('/recording', { phase: 'finish', ts: Date.now() });
  } else if (msg.gesture === 'escape') {
    post('/recording', { phase: 'abort', ts: Date.now() });
  }
});

// Health -> badge. Empty badge = healthy; red "!" = daemon unreachable.
async function healthCheck(): Promise<void> {
  let healthy = false;
  try {
    const res = await fetch(DAEMON + '/health');
    healthy = res.ok;
  } catch {
    /* ignore */
  }
  await chrome.action.setBadgeBackgroundColor({ color: healthy ? '#1a7f37' : '#cf222e' });
  await chrome.action.setBadgeText({ text: healthy ? '' : '!' });
  if (healthy) pushConfig(); // re-sync so the daemon recovers config after a restart
}

async function init(): Promise<void> {
  await pushConfig();
  try {
    const w = await chrome.windows.getLastFocused();
    await reportFocus(!!w.focused);
  } catch {
    /* ignore */
  }
  await reportActive();
  await healthCheck();
}

chrome.runtime.onInstalled.addListener(() => {
  init();
});
chrome.runtime.onStartup.addListener(() => {
  init();
});
chrome.alarms.create('health', { periodInMinutes: 0.25 });
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === 'health') healthCheck();
});

// Kick once on worker spin-up.
init();
