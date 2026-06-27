import { Canvas, FabricImage } from 'fabric';
import { CANVAS_Z, JPEG_QUALITY } from './constants';

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

  private constructor(canvas: Canvas, container: HTMLDivElement, dpr: number) {
    this.canvas = canvas;
    this.container = container;
    this.dpr = dpr;
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

    return new Scene(canvas, container, dpr);
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
    void this.canvas.dispose();
    this.container.remove();
  }
}
