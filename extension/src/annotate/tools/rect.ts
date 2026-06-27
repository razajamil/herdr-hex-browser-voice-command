import { Rect } from 'fabric';
import type { TPointerEvent, TPointerEventInfo } from 'fabric';
import { MIN_RECT, PEN, SELECTION_STYLE, STROKE_WIDTH } from '../constants';
import type { Tool, ToolContext } from './types';

// Drag on empty canvas to draw a rectangle; click an existing object to select/move/resize it
// (Fabric supplies the corner handles). The 0×0 rect created on mousedown is wrapped in
// begin()/commit() so it isn't recorded until it has a final size on mouseup.
export function createRectTool(): Tool {
  let ctx: ToolContext | null = null;
  let rect: Rect | null = null;
  let originX = 0;
  let originY = 0;

  const onDown = (opt: TPointerEventInfo<TPointerEvent>): void => {
    if (!ctx || opt.target) return; // hit an existing object → let Fabric select/move it
    const p = opt.scenePoint;
    originX = p.x;
    originY = p.y;
    ctx.begin();
    rect = new Rect({
      left: originX,
      top: originY,
      originX: 'left', // Fabric's default origin is CENTER; anchor by top-left so left/top is the corner
      originY: 'top',
      width: 0,
      height: 0,
      fill: 'transparent',
      stroke: PEN,
      strokeWidth: STROKE_WIDTH,
      strokeUniform: true,
      ...SELECTION_STYLE,
    });
    ctx.canvas.add(rect);
  };

  const onMove = (opt: TPointerEventInfo<TPointerEvent>): void => {
    if (!ctx || !rect) return;
    const p = opt.scenePoint;
    rect.set({
      left: Math.min(originX, p.x),
      top: Math.min(originY, p.y),
      width: Math.abs(p.x - originX),
      height: Math.abs(p.y - originY),
    });
    ctx.canvas.requestRenderAll();
  };

  const onUp = (): void => {
    if (!ctx || !rect) return;
    const finished = rect;
    rect = null;
    if (finished.width < MIN_RECT && finished.height < MIN_RECT) {
      ctx.canvas.remove(finished); // discard an accidental tiny rect
      ctx.cancel();
    } else {
      finished.setCoords();
      ctx.canvas.setActiveObject(finished);
      ctx.commit();
    }
  };

  return {
    name: 'rect',
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
      rect = null;
      ctx = null;
    },
  };
}
