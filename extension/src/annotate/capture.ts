import { CAPTURE_DEBOUNCE_MS } from './constants';
import { pushFrame, sendFrame, type SendResult } from './messages';

// Keeps the daemon's stored frame fresh as you annotate (debounced) and handles the explicit
// Send. Both paths export the Fabric canvas (snapshot + annotations) and hand the resulting data
// URL to the background worker — there's no captureVisibleTab and no toolbar hiding here, so
// neither path causes a flicker.
export class Capture {
  private timer: number | null = null;
  private inFlight = false;

  constructor(private readonly exportFrame: () => string) {}

  // Debounced keep-fresh push, called after each annotation change.
  schedule(): void {
    if (this.timer != null) clearTimeout(this.timer);
    this.timer = window.setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, CAPTURE_DEBOUNCE_MS);
  }

  // Push the current frame to the daemon immediately (used on recording-start).
  async flush(): Promise<void> {
    if (this.inFlight) return;
    this.inFlight = true;
    try {
      await pushFrame(this.exportFrame());
    } finally {
      this.inFlight = false;
    }
  }

  // Deliver the current frame to the matching pane right now (Send button).
  send(): Promise<SendResult | undefined> {
    this.cancel();
    return sendFrame(this.exportFrame());
  }

  cancel(): void {
    if (this.timer != null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
