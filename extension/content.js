// Voice Router — OPTIONAL recording-gesture detector (best-effort).
//
// Detects a left-Command double-tap (you starting a Hex recording) and Escape (abort),
// and forwards them to the background worker so the daemon can capture the URL you were
// on at the *start* of a recording.
//
// This is purely an accuracy hint:
//   - It only fires while a normal http(s) page is focused (content scripts don't run
//     on chrome://, the New Tab page, the PDF viewer, etc.).
//   - The daemon routes transcripts fine WITHOUT it, by watching Hex's history file and
//     attributing each recording to the URL active during its window.
//
// We deliberately do NOT emit a single-tap "finish" gesture: a lone Command tap is far
// too common to treat as a signal, and "finished recording" is detected reliably by the
// new transcript appearing in Hex.

(() => {
  const DOUBLE_TAP_MS = 400;
  let lastMetaUp = 0;

  function send(gesture) {
    try {
      chrome.runtime.sendMessage({ type: 'gesture', gesture });
    } catch (_e) {
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
