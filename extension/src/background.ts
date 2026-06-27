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
  attachScreenshot: false,
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
  await post('/config', { requireBrowserFocus: s.requireBrowserFocus, attachScreenshot: s.attachScreenshot, routes: s.routes });
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
  void maybeCaptureScreenshot(tab);
}

// When the screenshot feature is on, capture the visible tab and stream it to the daemon.
// Piggybacks on the same tab-activate / focus / load events that report the URL, throttled
// so a burst of onUpdated events during a page load doesn't spam captures.
const SHOT_MIN_INTERVAL_MS = 600;
let lastShotAt = 0;

async function captureAndPost(tab: chrome.tabs.Tab): Promise<void> {
  try {
    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'jpeg', quality: 55 });
    await post('/screenshot', { dataUrl, url: tab.url, tabId: tab.id, ts: Date.now() });
  } catch (e) {
    // Protected page (chrome://, web store), window not focused, rate-limited, or host
    // access withheld. Log (visible in the service-worker console) rather than swallow.
    console.warn('[voice-router] captureVisibleTab failed:', (e as Error)?.message ?? e);
  }
}

// Post a frame the content script already encoded (the annotated Fabric canvas, composited on
// top of the base snapshot) to the daemon. Used by the draw-frame / draw-send paths so we never
// re-screenshot the live tab — and thus never capture our own overlay — while drawing.
async function postShot(dataUrl: string, tab: chrome.tabs.Tab): Promise<void> {
  await post('/screenshot', { dataUrl, url: tab.url, tabId: tab.id, ts: Date.now() });
}

async function maybeCaptureScreenshot(tab: chrome.tabs.Tab): Promise<void> {
  if (!isTrackable(tab.url) || !tab.active) return; // captureVisibleTab grabs the ACTIVE tab
  if (tab.id != null && tab.id === drawingTabId) return; // drawing → content pushes annotated frames
  const s = await getSettings();
  if (!s.attachScreenshot) return;
  const now = Date.now();
  if (now - lastShotAt < SHOT_MIN_INTERVAL_MS) return;
  lastShotAt = now;
  await captureAndPost(tab);
}

// On the recording-start gesture: capture the (possibly annotated) viewport at the moment
// the user starts speaking — there's no tab event between drawing and speaking, so this is
// the only chance to grab the final drawing. Then tell the tab to clear+exit drawing mode
// now that the frame is captured (a no-op if it isn't drawing).
async function captureOnRecordingStart(tab: chrome.tabs.Tab | undefined): Promise<void> {
  if (!tab) return;
  const s = await getSettings();
  // While drawing, the content script streams annotated frames itself (live captureVisibleTab
  // would grab the overlay), so only capture here when NOT drawing.
  const isDrawing = tab.id != null && tab.id === drawingTabId;
  if (!isDrawing && s.attachScreenshot && isTrackable(tab.url)) {
    lastShotAt = Date.now();
    await captureAndPost(tab);
  }
  if (tab.id != null) {
    try {
      await chrome.tabs.sendMessage(tab.id, { type: 'draw-clear-exit' });
    } catch {
      /* tab not drawing / no content script — fine */
    }
  }
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

// ---- clear-the-drawing watch ----
// The content script can't reliably see the recording gesture (the target app iframes its
// content, so keyboard events never reach the top-frame listener). So while a tab is in
// drawing mode we watch the daemon for a NEW routed transcript and tell the tab to clear.
let drawingTabId: number | null = null;
let baselineMatchId: string | null = null;
let drawPoll: ReturnType<typeof setInterval> | null = null;

async function currentMatchId(): Promise<string | null> {
  try {
    const h = await (await fetch(DAEMON + '/health')).json();
    return (h?.lastMatch?.transcriptId as string) ?? null;
  } catch {
    return null;
  }
}

async function startDrawWatch(tabId: number): Promise<void> {
  drawingTabId = tabId;
  baselineMatchId = await currentMatchId(); // only react to matches AFTER drawing began
  if (drawPoll == null) {
    drawPoll = setInterval(async () => {
      if (drawingTabId == null) return;
      const id = await currentMatchId();
      if (id && id !== baselineMatchId) {
        const tab = drawingTabId;
        stopDrawWatch();
        try {
          await chrome.tabs.sendMessage(tab, { type: 'draw-clear-exit' });
        } catch {
          /* tab gone */
        }
      }
    }, 1200);
  }
}

function stopDrawWatch(): void {
  drawingTabId = null;
  if (drawPoll != null) {
    clearInterval(drawPoll);
    drawPoll = null;
  }
}

// Messages from the content script: recording gestures, on-draw capture requests, and
// draw-mode lifecycle (to drive the clear-watch above).
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.type !== 'string') return;
  const tab = sender.tab;

  if (msg.type === 'gesture') {
    if (msg.gesture === 'meta-double') {
      post('/recording', { phase: 'start', url: tab?.url, title: tab?.title, tabId: tab?.id, ts: Date.now() });
      void captureOnRecordingStart(tab);
    } else if (msg.gesture === 'meta-single') {
      post('/recording', { phase: 'finish', ts: Date.now() });
    } else if (msg.gesture === 'escape') {
      post('/recording', { phase: 'abort', ts: Date.now() });
    }
    return;
  }

  // Grab a pristine screenshot for the content script to annotate on top of. Requested before
  // the overlay is injected, so the shot is clean; higher quality than the keep-fresh stream
  // since it becomes the canvas everything is drawn on and re-encoded from.
  if (msg.type === 'capture-base') {
    (async () => {
      try {
        if (!tab) return sendResponse({ error: 'no-tab' });
        const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'jpeg', quality: 80 });
        sendResponse({ dataUrl });
      } catch (e) {
        console.warn('[voice-router] capture-base failed:', (e as Error)?.message ?? e);
        sendResponse({ error: 'capture-failed' });
      }
    })();
    return true; // async sendResponse
  }

  // Keep-fresh stream: the content script composites the annotated frame and hands it to us to
  // store on the daemon (so the speak path has the latest drawing). No captureVisibleTab here.
  if (msg.type === 'draw-frame') {
    (async () => {
      if (tab && typeof msg.dataUrl === 'string') await postShot(msg.dataUrl, tab);
      sendResponse({ ok: true });
    })();
    return true; // async sendResponse
  }

  if (msg.type === 'draw-started') {
    if (tab?.id != null) void startDrawWatch(tab.id);
    return;
  }
  if (msg.type === 'draw-stopped') {
    stopDrawWatch();
    return;
  }

  // Send button: store the content-supplied annotated frame, then deliver it to the matching
  // pane now.
  if (msg.type === 'draw-send') {
    (async () => {
      if (!tab || !isTrackable(tab.url)) return sendResponse({ delivered: false, reason: 'no-route' });
      if (typeof msg.dataUrl === 'string') await postShot(msg.dataUrl, tab);
      sendResponse(await sendScreenshot(tab.url));
    })();
    return true; // async sendResponse
  }
});

// Ask the daemon to deliver the latest screenshot to the pane matching `url`.
async function sendScreenshot(url: string): Promise<{ delivered: boolean; reason: string }> {
  try {
    const res = await fetch(DAEMON + '/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    });
    const j = await res.json();
    const status = j?.delivery?.status;
    return { delivered: status === 'delivered', reason: j?.delivery?.reason || status || j?.reason || 'failed' };
  } catch {
    return { delivered: false, reason: 'daemon-unreachable' };
  }
}

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
