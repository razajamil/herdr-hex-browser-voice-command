// OPTIONAL recording-gesture detector (best-effort). Detects a left-Command double-tap
// (recording start) and Escape (abort) and forwards them to the background worker so the
// daemon can capture the URL active at the START of a recording. The daemon routes fine
// without this; it's only an accuracy hint, and only fires while an http(s) page is focused.

(() => {
  const DOUBLE_TAP_MS = 400;
  let lastMetaUp = 0;

  function send(gesture: string): void {
    try {
      chrome.runtime.sendMessage({ type: 'gesture', gesture });
    } catch {
      // background worker asleep / extension reloading — ignore.
    }
  }

  document.addEventListener(
    'keyup',
    (e) => {
      if (e.code !== 'MetaLeft') return;
      const now = e.timeStamp;
      if (now - lastMetaUp <= DOUBLE_TAP_MS) {
        lastMetaUp = 0;
        send('meta-double'); // start of a recording
      } else {
        lastMetaUp = now;
      }
    },
    true
  );

  document.addEventListener(
    'keydown',
    (e) => {
      if (e.key === 'Escape') send('escape'); // abort
    },
    true
  );
})();
