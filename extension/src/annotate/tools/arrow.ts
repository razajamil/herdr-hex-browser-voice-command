import { classRegistry, Control, FabricObject, Point, util } from 'fabric';
import type { TPointerEvent, TPointerEventInfo, Transform } from 'fabric';
import { MIN_RECT, PEN, STROKE_WIDTH } from '../constants';
import type { Tool, ToolContext } from './types';

// A straight arrow with independently draggable endpoints — the standard line-tool interaction,
// not a scalable bounding box.
//
// It's a custom FabricObject (not a Path) so we fully control rendering and selection: it stores
// its two endpoints, draws the shaft + an open-V head in `_render`, and exposes two endpoint
// Controls (no scale/rotate handles). Endpoints are kept in LOCAL space (relative to the bbox
// centre), so dragging the body just moves left/top and the arrow translates rigidly; dragging an
// endpoint recomputes the bbox while pinning the other end.
//
// We register it with Fabric's classRegistry under type 'arrow' so it round-trips through undo
// (history serializes via toObject → util.enlivenObjects, which looks the class up by type).

const HEAD_ANGLE = Math.PI / 7; // ~26° barbs
const MAX_HEAD = 18; // arrowhead length cap (px); short arrows get a proportionally smaller head

interface Pt {
  x: number;
  y: number;
}

// Arrowhead barb endpoints for a shaft running a→b, in the same coordinate space as a/b.
function barbs(a: Pt, b: Pt): { l: Pt; r: Pt } {
  const angle = Math.atan2(b.y - a.y, b.x - a.x);
  const head = Math.min(MAX_HEAD, Math.hypot(b.x - a.x, b.y - a.y) * 0.5);
  return {
    l: { x: b.x - head * Math.cos(angle - HEAD_ANGLE), y: b.y - head * Math.sin(angle - HEAD_ANGLE) },
    r: { x: b.x - head * Math.cos(angle + HEAD_ANGLE), y: b.y - head * Math.sin(angle + HEAD_ANGLE) },
  };
}

// Draw an endpoint handle as a small filled circle (clearer than a square for "grab this point").
function renderEndpoint(
  ctx: CanvasRenderingContext2D,
  left: number,
  top: number,
  _style: unknown,
  obj: FabricObject
): void {
  const r = (obj.cornerSize ?? 10) / 2;
  ctx.save();
  ctx.fillStyle = obj.cornerColor ?? '#fff';
  ctx.strokeStyle = obj.cornerStrokeColor ?? PEN;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(left, top, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

// Map a local (centre-relative, unscaled) point to canvas/viewport coords for control placement.
function endpointPosition(obj: ArrowShape, local: Pt): Point {
  const scene = util.transformPoint(new Point(local.x, local.y), obj.calcTransformMatrix());
  const vpt = obj.canvas?.viewportTransform;
  return vpt ? util.transformPoint(scene, vpt) : scene;
}

function endpointAction(which: 'tail' | 'tip') {
  return (_e: TPointerEvent, transform: Transform, x: number, y: number): boolean => {
    (transform.target as unknown as ArrowShape).setEndpoint(which, x, y); // x,y are scene coords
    return true;
  };
}

// Shared across instances — the controls key off transform.target, so they hold no per-arrow state.
const tailControl = new Control({
  positionHandler: (_dim, _m, obj) => endpointPosition(obj as ArrowShape, (obj as ArrowShape).p1),
  actionHandler: endpointAction('tail'),
  actionName: 'modifyArrow',
  cursorStyle: 'all-scroll',
  render: renderEndpoint,
});
const tipControl = new Control({
  positionHandler: (_dim, _m, obj) => endpointPosition(obj as ArrowShape, (obj as ArrowShape).p2),
  actionHandler: endpointAction('tip'),
  actionName: 'modifyArrow',
  cursorStyle: 'all-scroll',
  render: renderEndpoint,
});

interface ArrowOptions {
  x1?: number;
  y1?: number;
  x2?: number;
  y2?: number;
  p1?: Pt;
  p2?: Pt;
  stroke?: string;
  strokeWidth?: number;
  [k: string]: unknown;
}

export class ArrowShape extends FabricObject {
  static type = 'arrow';
  declare p1: Pt; // tail, local coords (relative to bbox centre)
  declare p2: Pt; // tip, local coords

  constructor(options: ArrowOptions = {}) {
    super(options as Record<string, never>);
    this.originX = 'center'; // so left/top IS the bbox centre — matches our endpoint maths
    this.originY = 'center';
    this.stroke = options.stroke ?? PEN;
    this.strokeWidth = options.strokeWidth ?? STROKE_WIDTH;
    this.fill = '';
    this.hasBorders = false; // just the two endpoint handles when selected — no box chrome
    this.cornerColor = '#fff';
    this.cornerStrokeColor = PEN;
    this.cornerSize = 11;
    this.transparentCorners = false;
    this.lockRotation = true;
    this.lockScalingX = true;
    this.lockScalingY = true;
    this.objectCaching = false;
    // Hit-test against the painted pixels (the shaft + head), not the bounding box, so crossing
    // arrows don't steal each other's clicks and the empty space around a diagonal arrow stays
    // clickable for drawing a new one. Fabric still bbox-checks first, then refines per-pixel
    // within the canvas's targetFindTolerance band (set in Scene).
    this.perPixelTargetFind = true;
    this.controls = { p1: tailControl, p2: tipControl };
    if (!this.p1) this.p1 = { x: 0, y: 0 };
    if (!this.p2) this.p2 = { x: 0, y: 0 };
    if (
      typeof options.x1 === 'number' &&
      typeof options.y1 === 'number' &&
      typeof options.x2 === 'number' &&
      typeof options.y2 === 'number'
    ) {
      this.setPoints(options.x1, options.y1, options.x2, options.y2);
    }
  }

  // Set both ends from absolute scene coords (used while drawing).
  setPoints(x1: number, y1: number, x2: number, y2: number): void {
    this.recompute({ x: x1, y: y1 }, { x: x2, y: y2 });
  }

  // Move one end to an absolute scene point, pinning the other where it currently is.
  setEndpoint(which: 'tail' | 'tip', x: number, y: number): void {
    const tailAbs = which === 'tail' ? { x, y } : { x: this.left + this.p1.x, y: this.top + this.p1.y };
    const tipAbs = which === 'tip' ? { x, y } : { x: this.left + this.p2.x, y: this.top + this.p2.y };
    this.recompute(tailAbs, tipAbs);
  }

  // Recompute the bbox (centre + size) from absolute endpoints and re-express the ends locally.
  private recompute(a: Pt, b: Pt): void {
    const { l, r } = barbs(a, b);
    const pad = (this.strokeWidth || STROKE_WIDTH) / 2 + 1;
    const xs = [a.x, b.x, l.x, r.x];
    const ys = [a.y, b.y, l.y, r.y];
    const minX = Math.min(...xs) - pad;
    const maxX = Math.max(...xs) + pad;
    const minY = Math.min(...ys) - pad;
    const maxY = Math.max(...ys) + pad;
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    this.set({ left: cx, top: cy, width: Math.max(1, maxX - minX), height: Math.max(1, maxY - minY) });
    this.p1 = { x: a.x - cx, y: a.y - cy };
    this.p2 = { x: b.x - cx, y: b.y - cy };
    this.dirty = true;
    this.setCoords();
  }

  // ctx origin is the object centre, so local endpoints draw directly.
  _render(ctx: CanvasRenderingContext2D): void {
    const { p1, p2 } = this;
    const { l, r } = barbs(p1, p2);
    ctx.lineWidth = this.strokeWidth;
    ctx.strokeStyle = (this.stroke as string) || PEN;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(p1.x, p1.y); // shaft
    ctx.lineTo(p2.x, p2.y);
    ctx.moveTo(l.x, l.y); // open-V head: left barb → tip → right barb
    ctx.lineTo(p2.x, p2.y);
    ctx.lineTo(r.x, r.y);
    ctx.stroke();
  }

  // Persist the endpoints (everything else is standard object state) so undo can rebuild us.
  toObject(propertiesToInclude: string[] = []): Record<string, unknown> {
    return super.toObject(['p1', 'p2', ...propertiesToInclude]);
  }
}

classRegistry.setClass(ArrowShape, 'arrow');

// Drag on empty canvas to draw a straight arrow; click an existing object to select/move it, then
// drag either endpoint to reshape.
export function createArrowTool(): Tool {
  let ctx: ToolContext | null = null;
  let arrow: ArrowShape | null = null;
  let originX = 0;
  let originY = 0;
  let lastX = 0;
  let lastY = 0;

  const onDown = (opt: TPointerEventInfo<TPointerEvent>): void => {
    if (!ctx || opt.target) return; // hit an existing object → let Fabric select/move it
    const p = opt.scenePoint;
    originX = lastX = p.x;
    originY = lastY = p.y;
    ctx.begin();
    arrow = new ArrowShape({ x1: originX, y1: originY, x2: originX, y2: originY });
    ctx.canvas.add(arrow);
  };

  const onMove = (opt: TPointerEventInfo<TPointerEvent>): void => {
    if (!ctx || !arrow) return;
    const p = opt.scenePoint;
    lastX = p.x;
    lastY = p.y;
    arrow.setPoints(originX, originY, p.x, p.y);
    ctx.canvas.requestRenderAll();
  };

  const onUp = (): void => {
    if (!ctx || !arrow) return;
    const finished = arrow;
    arrow = null;
    if (Math.hypot(lastX - originX, lastY - originY) < MIN_RECT) {
      ctx.canvas.remove(finished); // discard an accidental click / tiny drag
      ctx.cancel();
    } else {
      ctx.canvas.setActiveObject(finished);
      ctx.commit();
    }
  };

  return {
    name: 'arrow',
    activate(c) {
      ctx = c;
      c.canvas.on('mouse:down', onDown);
      c.canvas.on('mouse:move', onMove);
      c.canvas.on('mouse:up', onUp);
    },
    deactivate(c) {
      c.canvas.off('mouse:down', onDown);
      c.canvas.off('mouse:move', onMove);
      c.canvas.off('mouse:up', onUp);
      arrow = null;
      ctx = null;
    },
  };
}
