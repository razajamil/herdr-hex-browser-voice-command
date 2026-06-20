// Voice Router — background service worker.
//
// Two jobs:
//   1. Stream the active tab's URL to the daemon so it knows which project you were
//      looking at when a recording happened.
//   2. Health-check the daemon and reflect its status in the toolbar badge.
//
// (Recording gestures from content.js are forwarded as optional accuracy hints; the
//  daemon routes transcripts on its own by watching Hex, so this never has to fire.)

const DAEMON = 'http://127.0.0.1:8137';

async function post(path, body) {
  try {
    const res = await fetch(DAEMON + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return res.ok;
  } catch (_e) {
    return false;
  }
}

// ---- settings (mirrored to the daemon as config) ----
const DEFAULT_SETTINGS = { requireBrowserFocus: true };

async function getSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  return { ...DEFAULT_SETTINGS, ...(settings || {}) };
}

async function pushConfig() {
  const s = await getSettings();
  await post('/config', { requireBrowserFocus: s.requireBrowserFocus });
}

async function reportFocus(focused) {
  await post('/focus', { focused: !!focused, ts: Date.now() });
}

function isTrackable(url) {
  return !!url && (url.startsWith('http://') || url.startsWith('https://'));
}

async function reportTab(tab) {
  if (!tab || !isTrackable(tab.url)) return;
  await post('/active-url', { url: tab.url, tabId: tab.id, title: tab.title || null, ts: Date.now() });
}

async function reportActive() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (tab) await reportTab(tab);
  } catch (_e) {}
}

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  try {
    const tab = await chrome.tabs.get(tabId);
    await reportTab(tab);
  } catch (_e) {}
});

chrome.tabs.onUpdated.addListener((_tabId, info, tab) => {
  if (info.status === 'complete' || info.url) reportTab(tab);
});

chrome.windows.onFocusChanged.addListener((winId) => {
  const focused = winId !== chrome.windows.WINDOW_ID_NONE;
  reportFocus(focused);
  if (focused) reportActive();
});

// Keep the daemon in sync whenever the user toggles a setting in the popup.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.settings) pushConfig();
});

// Optional: key gestures from the content script -> recording phases.
chrome.runtime.onMessage.addListener((msg, sender) => {
  if (!msg || msg.type !== 'gesture') return;
  const tab = sender.tab || {};
  if (msg.gesture === 'meta-double') {
    post('/recording', { phase: 'start', url: tab.url, title: tab.title, tabId: tab.id, ts: Date.now() });
  } else if (msg.gesture === 'meta-single') {
    post('/recording', { phase: 'finish', ts: Date.now() });
  } else if (msg.gesture === 'escape') {
    post('/recording', { phase: 'abort', ts: Date.now() });
  }
});

// Health -> badge. Empty badge = healthy; red "!" = daemon unreachable.
async function healthCheck() {
  let healthy = false;
  try {
    const res = await fetch(DAEMON + '/health');
    healthy = res.ok;
  } catch (_e) {}
  await chrome.action.setBadgeBackgroundColor({ color: healthy ? '#1a7f37' : '#cf222e' });
  await chrome.action.setBadgeText({ text: healthy ? '' : '!' });
  // Re-sync settings each tick so the daemon recovers config after a restart.
  if (healthy) pushConfig();
}

async function init() {
  await pushConfig();
  try {
    const w = await chrome.windows.getLastFocused();
    await reportFocus(!!(w && w.focused));
  } catch (_e) {}
  await reportActive();
  await healthCheck();
}

chrome.runtime.onInstalled.addListener(init);
chrome.runtime.onStartup.addListener(init);
chrome.alarms.create('health', { periodInMinutes: 0.25 });
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === 'health') healthCheck();
});

// Kick once on worker spin-up.
init();
