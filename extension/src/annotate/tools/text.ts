import { IText } from 'fabric';
import type { TPointerEvent, TPointerEventInfo } from 'fabric';
import { EDITOR_Z, FONT_FAMILY, FONT_PX, PEN, SELECTION_STYLE } from '../constants';
import type { Tool, ToolContext } from './types';

// Text ENTRY uses a native contentEditable box, not Fabric's in-canvas IText editing. Fabric's
// editing path (hidden-textarea + composition events on HiDPI) duplicates/garbles characters as
// you type in this overlay context. So we type into a plain DOM box (bulletproof), then render
// the committed string as a NON-editable Fabric IText — which is still selectable/movable and is
// exported with everything else. Click empty canvas to start a label; click an existing object
// to select/move it.
export function createTextTool(): Tool {
  let ctx: ToolContext | null = null;
  let editor: HTMLDivElement | null = null;
  let boxX = 0;
  let boxY = 0;

  function commitEditor(): void {
    if (!editor || !ctx) return;
    const el = editor;
    editor = null; // clear first so the blur handler doesn't re-enter
    const value = (el.textContent || '').replace(/ /g, ' ').trim();
    el.remove();
    if (!value) return;
    const text = new IText(value, {
      left: boxX,
      top: boxY,
      originX: 'left',
      originY: 'top',
      editable: false, // we never use Fabric's editing — re-edit by deleting + retyping
      fill: PEN,
      fontSize: FONT_PX,
      fontFamily: FONT_FAMILY,
      objectCaching: false,
      ...SELECTION_STYLE,
    });
    // Corners only — no single-axis edge handles, so resizing can't stretch the glyphs (with
    // uniformScaling on, corner drags scale proportionally). objectCaching:false keeps it crisp.
    text.setControlsVisibility({ ml: false, mr: false, mt: false, mb: false });
    ctx.begin();
    ctx.canvas.add(text);
    ctx.canvas.setActiveObject(text);
    ctx.commit();
  }

  function cancelEditor(): void {
    if (!editor) return;
    const el = editor;
    editor = null;
    el.remove();
  }

  // A floating contentEditable at the click point; Enter/blur commits, Escape cancels. Styled to
  // match the rendered label so it's WYSIWYG.
  function openEditor(x: number, y: number): void {
    commitEditor(); // commit any already-open box first
    boxX = x;
    boxY = y;
    const el = document.createElement('div');
    el.contentEditable = 'true';
    el.spellcheck = false;
    Object.assign(el.style, {
      position: 'fixed',
      left: `${x}px`,
      top: `${y}px`,
      font: `${FONT_PX}px ${FONT_FAMILY}`,
      lineHeight: `${FONT_PX}px`,
      letterSpacing: 'normal',
      textTransform: 'none',
      color: PEN,
      caretColor: PEN,
      background: 'rgba(255,45,45,0.07)',
      padding: '0',
      margin: '0',
      border: 'none',
      outline: 'none',
      minWidth: '2px',
      maxWidth: '90vw',
      whiteSpace: 'pre',
      zIndex: EDITOR_Z,
    } as CSSStyleDeclaration);
    el.addEventListener('keydown', (ev) => {
      ev.stopPropagation(); // keep the page's shortcuts out of the editor
      if (ev.key === 'Enter') {
        ev.preventDefault();
        commitEditor();
      } else if (ev.key === 'Escape') {
        ev.preventDefault();
        cancelEditor();
      }
    });
    el.addEventListener('blur', () => commitEditor());
    editor = el;
    document.documentElement.appendChild(el);
    el.focus();
  }

  const onDown = (opt: TPointerEventInfo<TPointerEvent>): void => {
    if (!ctx || opt.target) return; // existing object → Fabric selects/moves it
    // Stop the mousedown's default action from stealing focus back from the editor we're about
    // to focus (otherwise it blurs instantly and the box vanishes before you can type).
    opt.e.preventDefault();
    const p = opt.scenePoint; // canvas has no zoom/pan, so scene coords == viewport px
    openEditor(p.x, p.y);
  };

  return {
    name: 'text',
    activate(c) {
      ctx = c;
      c.canvas.on('mouse:down', onDown);
    },
    deactivate(c) {
      commitEditor(); // commit any open box before leaving the tool
      c.canvas.off('mouse:down', onDown);
      ctx = null;
    },
  };
}
