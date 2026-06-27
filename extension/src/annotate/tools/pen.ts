import { PencilBrush } from 'fabric';
import { PEN, STROKE_WIDTH } from '../constants';
import type { Tool } from './types';

// Freehand drawing via Fabric's built-in brush. Each finished stroke is added as a selectable
// Path (one `path:created` / `object:added` event), so no manual begin/commit is needed.
export const penTool: Tool = {
  name: 'pen',
  activate({ canvas }) {
    const brush = new PencilBrush(canvas);
    brush.color = PEN;
    brush.width = STROKE_WIDTH;
    canvas.freeDrawingBrush = brush;
    canvas.isDrawingMode = true;
  },
  deactivate({ canvas }) {
    canvas.isDrawingMode = false;
  },
};
