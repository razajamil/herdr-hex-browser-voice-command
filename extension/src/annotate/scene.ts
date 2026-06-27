import { Canvas, FabricImage } from 'fabric';
import { CANVAS_Z, JPEG_QUALITY, PEN, TOOL_CURSOR, TOOL_GLYPH } from './constants';
import type { ToolName } from './tools/types';

// Owns the on-page DOM container + the Fabric canvas, the frozen page snapshot (set as the
// canvas background), HiDPI sizing, image export, and teardown. Knows nothing about tools, the
// toolbar, or messaging.
//
// Capture-once model: the screenshot is the canvas *background* and our toolbar is separate DOM,
// so `toDataURL` exports the snapshot + annotations and never the toolbar. That's what removes
// the old per-stroke re-capture + toolbar-hide flicker — we composite locally instead of asking
// the browser to re-screenshot the live tab on every change.
export class Scene {
  readonly canvas: Canvas;
  private readonly container: HTMLDivElement;
  private readonly dpr: number;
  private readonly chip: HTMLDivElement; // little glyph that trails the cursor showing the tool
  private activeTool: ToolName | null = null;
  private lastX = -1;
  private lastY = -1;
  private readonly onMove: (e: MouseEvent) => void;
  private readonly onOut: (e: MouseEvent) => void;

  private constructor(canvas: Canvas, container: HTMLDivElement, dpr: number, chip: HTMLDivElement) {
    this.canvas = canvas;
    this.container = container;
    this.dpr = dpr;
    this.chip = chip;

    // Track the pointer so the tool chip follows it; hide it when the cursor leaves the window.
    this.onMove = (e) => {
      this.lastX = e.clientX;
      this.lastY = e.clientY;
      this.positionChip();
    };
    this.onOut = (e) => {
      if (!e.relatedTarget) this.chip.style.display = 'none'; // left the document entirely
    };
    window.addEventListener('mousemove', this.onMove, true);
    document.addEventListener('mouseout', this.onOut, true);
  }

  static async create(baseDataUrl: string): Promise<Scene> {
    const dpr = window.devicePixelRatio || 1;
    const width = window.innerWidth;
    const height = window.innerHeight;

    const container = document.createElement('div');
    // tabIndex makes the overlay programmatically focusable so we can pull focus off the page's
    // inputs (or out of an iframe) on entry — otherwise keyboard shortcuts are swallowed by the
    // editor guard until the user clicks something. outline:none hides the focus ring.
    container.tabIndex = -1;
    Object.assign(container.style, {
      position: 'fixed',
      inset: '0',
      zIndex: CANVAS_Z,
      touchAction: 'none',
      outline: 'none',
    } as CSSStyleDeclaration);
    const el = document.createElement('canvas');
    container.appendChild(el);

    // A small chip trailing the cursor with the active tool's glyph. Lives inside the (fixed,
    // CANVAS_Z) container so it sits above the canvas but below the editor/toolbar, is removed
    // with the container on teardown, and — being DOM — is never part of the exported frame.
    const chip = document.createElement('div');
    Object.assign(chip.style, {
      position: 'fixed',
      display: 'none',
      pointerEvents: 'none',
      font: '12px Helvetica, Arial, sans-serif',
      fontWeight: '600',
      lineHeight: '1',
      color: PEN,
      background: 'rgba(255,255,255,0.95)',
      border: `1px solid ${PEN}`,
      borderRadius: '5px',
      padding: '2px 5px',
      boxShadow: '0 1px 4px rgba(0,0,0,.25)',
      userSelect: 'none',
    } as CSSStyleDeclaration);
    container.appendChild(chip);

    document.documentElement.appendChild(container);

    const canvas = new Canvas(el, {
      width,
      height,
      enableRetinaScaling: true, // render at devicePixelRatio so annotations + export stay crisp
      preserveObjectStacking: true,
      uniformScaling: true, // corner-drag keeps aspect (text scales proportionally; rects use edge handles for free w/h)
      selection: false, // no drag-to-marquee — empty-drag is the rect tool; objects still select individually
    });

    // The screenshot is in physical pixels (≈ viewport × dpr); scale it to cover the logical
    // canvas. With retina scaling on, that maps 1:1 to the backing store → no blur.
    const img = await FabricImage.fromURL(baseDataUrl);
    img.set({ originX: 'left', originY: 'top', selectable: false, evented: false });
    img.scaleX = width / (img.width || width);
    img.scaleY = height / (img.height || height);
    canvas.backgroundImage = img;
    canvas.requestRenderAll();

    return new Scene(canvas, container, dpr, chip);
  }

  // Set the cursor shape (I-beam for text, crosshair for the drawing tools, default for none) and
  // the trailing chip's glyph. Setting both defaultCursor and freeDrawingCursor covers the pen's
  // drawing-mode cursor too; setCursor applies it now rather than only on the next pointer move.
  setTool(name: ToolName | null): void {
    this.activeTool = name;
    const cursor = name ? TOOL_CURSOR[name] : 'default';
    this.canvas.defaultCursor = cursor;
    this.canvas.freeDrawingCursor = cursor;
    this.canvas.setCursor(cursor);
    if (name) this.chip.textContent = TOOL_GLYPH[name];
    this.positionChip();
  }

  // Place the chip just below-right of the pointer so it doesn't sit under the crosshair/I-beam
  // hotspot. Hidden when there's no active tool or the pointer hasn't been seen yet.
  private positionChip(): void {
    if (!this.activeTool || this.lastX < 0) {
      this.chip.style.display = 'none';
      return;
    }
    this.chip.style.display = 'block';
    this.chip.style.left = `${this.lastX + 14}px`;
    this.chip.style.top = `${this.lastY + 16}px`;
  }

  // Composite (snapshot + annotations) at the screenshot's native resolution. Selection handles
  // and borders are drawn on Fabric's upper canvas and are never part of toDataURL output.
  exportDataURL(): string {
    return this.canvas.toDataURL({ format: 'jpeg', quality: JPEG_QUALITY, multiplier: this.dpr });
  }

  // Pull keyboard focus onto the overlay so tool shortcuts work immediately, instead of being
  // eaten by a page input (or trapped in an iframe) that still held focus when draw mode started.
  focus(): void {
    this.container.focus({ preventScroll: true });
  }

  resize(): void {
    const width = window.innerWidth;
    const height = window.innerHeight;
    this.canvas.setDimensions({ width, height });
    const img = this.canvas.backgroundImage;
    if (img) {
      img.scaleX = width / (img.width || width);
      img.scaleY = height / (img.height || height);
    }
    this.canvas.requestRenderAll();
  }

  destroy(): void {
    window.removeEventListener('mousemove', this.onMove, true);
    document.removeEventListener('mouseout', this.onOut, true);
    void this.canvas.dispose();
    this.container.remove(); // takes the chip with it
  }
}
