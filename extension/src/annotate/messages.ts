// Thin, typed wrappers around chrome.runtime.sendMessage for the annotation ↔ background
// conversation. Keeping the message shapes here means the rest of the module never touches
// chrome.* directly.

export type SendResult = { delivered?: boolean; reason?: string };

// Grab a pristine screenshot of the tab (no overlay yet) to annotate on top of.
export async function requestBaseCapture(): Promise<string | null> {
  try {
    const res = (await chrome.runtime.sendMessage({ type: 'capture-base' })) as { dataUrl?: string } | undefined;
    return res?.dataUrl ?? null;
  } catch {
    return null; // background asleep / reloading
  }
}

// Lifecycle pings so the background can run its "clear the drawing on next routed match" watch.
export function notifyStarted(): void {
  try {
    chrome.runtime.sendMessage({ type: 'draw-started' });
  } catch {
    /* ignore */
  }
}

export function notifyStopped(): void {
  try {
    chrome.runtime.sendMessage({ type: 'draw-stopped' });
  } catch {
    /* ignore */
  }
}

// Keep-fresh push: hand the latest composited frame to the daemon (so the speak path has it).
export async function pushFrame(dataUrl: string): Promise<void> {
  try {
    await chrome.runtime.sendMessage({ type: 'draw-frame', dataUrl });
  } catch {
    /* ignore */
  }
}

// Send button: store the frame and deliver it to the matching pane right now.
export async function sendFrame(dataUrl: string): Promise<SendResult | undefined> {
  try {
    return (await chrome.runtime.sendMessage({ type: 'draw-send', dataUrl })) as SendResult;
  } catch {
    return undefined; // treat as a failure upstream
  }
}
