import type { ToolName } from './tools/types';

export interface KeyboardHandlers {
  setTool(name: ToolName): void;
  undo(): void;
  deleteSelection(): void;
}

// True while the user is typing into a text field — the label editor, or any page input. Tool
// shortcuts and delete must yield so the keys reach the field.
function isTypingTarget(): boolean {
  const el = document.activeElement as HTMLElement | null;
  return !!el && (el.isContentEditable || el.tagName === 'INPUT' || el.tagName === 'TEXTAREA');
}

// Tool shortcuts (P/T/B/A), undo (⌘/Ctrl+Z), and delete-selection while annotating. Returns a
// detach function. (Escape never leaves draw mode — too easy to hit by accident; the label
// editor handles its own Escape to cancel.)
export function attachKeyboard(handlers: KeyboardHandlers): () => void {
  const onKeyDown = (e: KeyboardEvent): void => {
    if (isTypingTarget()) return; // typing a label — keys belong to the editor
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      handlers.undo();
      return;
    }
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const k = e.key.toLowerCase();
    if (k === 'p' || k === 't' || k === 'b' || k === 'a') {
      e.preventDefault();
      e.stopPropagation();
      handlers.setTool(k === 'p' ? 'pen' : k === 't' ? 'text' : k === 'b' ? 'rect' : 'arrow');
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      handlers.deleteSelection();
    }
  };
  document.addEventListener('keydown', onKeyDown, true);
  return () => document.removeEventListener('keydown', onKeyDown, true);
}
