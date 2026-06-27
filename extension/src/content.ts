// Content script: best-effort recording-gesture detection + the on-page annotation overlay.
//
// This file is intentionally thin and lightweight — it's injected into every http/https page at
// document_start, so it must stay small. It owns two things:
//   1. the ⌘⌘ / Escape recording gestures (forwarded to the background), and
//   2. the popup/background messaging that toggles drawing mode.
//
// The annotation engine (Fabric.js, ~410KB) lives in ./annotate and is built as a SEPARATE ESM
// chunk (dist/annotate.js). It's loaded lazily via dynamic import() the first time the user
// starts drawing, so Fabric is never parsed on pages where you don't draw.

import type { Annotator } from './annotate';

(() => {
  // ---- recording gestures ----
  const DOUBLE_TAP_MS = 400;
  let lastMetaUp = 0;

  // ---- lazy annotation engine ----
  let annotator: Annotator | null = null;
  let loadPromise: Promise<Annotator> | null = null;

  // Load the Fabric-based engine on demand. The chunk runs in this same isolated world, so it
  // can use chrome.runtime.* directly. import() of a web-accessible resource isn't subject to
  // the page's CSP (the isolated world has the extension's CSP).
  function loadAnnotator(): Promise<Annotator> {
    if (annotator) return Promise.resolve(annotator);
    if (!loadPromise) {
      loadPromise = (import(chrome.runtime.getURL('dist/annotate.js')) as Promise<typeof import('./annotate')>)
        .then((mod) => (annotator ??= new mod.Annotator()))
        .catch((e) => {
          loadPromise = null; // allow a retry on the next toggle
          throw e;
        });
    }
    return loadPromise;
  }

  function send(gesture: string): void {
    try {
      chrome.runtime.sendMessage({ type: 'gesture', gesture });
    } catch {
      // background worker asleep / extension reloading — ignore.
    }
  }

  // Double-tap of the left ⌘ starts a recording. (Iframed apps never deliver this to the
  // top-frame listener — capture there is driven by annotating instead. See ./annotate.)
  document.addEventListener(
    'keyup',
    (e) => {
      if (e.code !== 'MetaLeft') return;
      const now = e.timeStamp;
      if (now - lastMetaUp <= DOUBLE_TAP_MS) {
        lastMetaUp = 0;
        send('meta-double');
        annotator?.onRecordingStart();
      } else {
        lastMetaUp = now;
      }
    },
    true
  );

  document.addEventListener(
    'keydown',
    (e) => {
      if (annotator?.active) return; // while annotating, ./annotate owns the keyboard
      if (e.key === 'Escape') send('escape'); // abort a recording when not annotating
    },
    true
  );

  // ---- messages from the popup (toggle/query) and background (clear after capture) ----
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || typeof msg.type !== 'string') return;
    if (msg.type === 'draw-query') {
      sendResponse({ drawing: !!annotator?.active });
    } else if (msg.type === 'draw') {
      if (msg.on) {
        void loadAnnotator()
          .then((a) => a.enter())
          .catch((e) => console.warn('[voice-router] annotation engine failed to load:', e));
      } else {
        annotator?.exit();
      }
      sendResponse({ ok: true, drawing: !!msg.on }); // load/enter is async; report intent
    } else if (msg.type === 'draw-clear-exit') {
      annotator?.exit();
    }
  });
})();
