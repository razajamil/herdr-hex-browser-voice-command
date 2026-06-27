// Shared constants for the annotation overlay. Kept in one place so colours/sizes/z-indexes
// don't drift across the tools, toolbar, and scene.

export const PEN = '#ff2d2d';
export const STROKE_WIDTH = 3;
export const FONT_PX = 17;
// A CONCRETE font family, not the `-apple-system`/`system-ui` keywords. Chrome's canvas resolves
// those keywords differently for measureText vs. fillText, so Fabric (which sizes the selection
// box from measureText) ends up with a box that doesn't match the rendered glyphs. Helvetica/Arial
// measure and render identically. Used for both the entry box (CSS) and the Fabric label (canvas)
// so they stay WYSIWYG.
export const FONT_FAMILY = 'Helvetica, Arial, sans-serif';

// A tiny drag is treated as a misclick rather than a rectangle.
export const MIN_RECT = 4;

// Re-encode quality for the exported (snapshot + annotations) JPEG.
export const JPEG_QUALITY = 0.7;

// Debounce before pushing a fresh annotated frame to the daemon after a change.
export const CAPTURE_DEBOUNCE_MS = 500;

// After ⌘⌘ starts a recording, auto-exit if the background's clear-exit never arrives.
export const RECORDING_EXIT_MS = 1500;

// Layering: canvas below, then the text-entry editor box, then the toolbar on top.
export const CANVAS_Z = '2147483645';
export const EDITOR_Z = '2147483646';
export const TOOLBAR_Z = '2147483647';

// Selection chrome for annotation objects (Fabric never exports these into toDataURL output,
// so they're purely on-screen editing affordances).
export const SELECTION_STYLE = {
  borderColor: PEN,
  cornerColor: '#fff',
  cornerStrokeColor: PEN,
  cornerSize: 10,
  transparentCorners: false,
  cornerStyle: 'rect' as const,
};

export const DEFAULT_LABEL = 'speak or Send';
