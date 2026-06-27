import { DEFAULT_LABEL, PEN, TOOLBAR_AUTO_COLLAPSE_MS, TOOLBAR_RECOLLAPSE_MS, TOOLBAR_Z } from './constants';
import type { ToolName } from './tools/types';

export interface ToolbarCallbacks {
  onTool(name: ToolName): void;
  onUndo(): void;
  onClear(): void;
  onSend(): void;
  onCancel(): void;
}

type Variant = 'default' | 'primary' | 'danger';

// The floating editing toolbar (bottom-left). Pure DOM, separate from the canvas — and because
// frames are exported from the Fabric canvas (not re-screenshotted from the tab), the toolbar is
// never in a captured frame and so never needs to be hidden.
//
// It starts fully expanded, then collapses to a small dot after a few idle seconds to stay out of
// the way; hovering the dot expands it again. The root shrink-wraps whichever of `content`/`dot`
// is shown, so a single mouseenter/leave on the root drives the whole thing.
export class Toolbar {
  readonly el: HTMLDivElement;
  private readonly content: HTMLDivElement;
  private readonly dot: HTMLDivElement;
  private readonly label: HTMLSpanElement;
  private readonly toolButtons: Record<ToolName, HTMLButtonElement>;
  private statusTimer: number | null = null;
  private collapseTimer: number | null = null;
  private hovered = false;

  constructor(cb: ToolbarCallbacks) {
    const bar = document.createElement('div');
    Object.assign(bar.style, {
      position: 'fixed',
      bottom: '16px',
      left: '16px',
      zIndex: TOOLBAR_Z,
    } as CSSStyleDeclaration);

    // The full toolbar row, shown when expanded.
    const content = document.createElement('div');
    Object.assign(content.style, {
      display: 'flex',
      gap: '6px',
      alignItems: 'center',
      padding: '6px 8px',
      background: '#fff',
      borderRadius: '10px',
      boxShadow: '0 2px 14px rgba(0,0,0,.28)',
      border: '1px solid #d0d7de',
    } as CSSStyleDeclaration);

    const pen = this.toolButton('✏️ Pen', 'P', 'Freehand pen (P)', () => cb.onTool('pen'));
    const text = this.toolButton('Text', 'T', 'Click the page, then type; drag to move (T)', () => cb.onTool('text'));
    const rect = this.toolButton('▭ Box', 'B', 'Drag to draw; select to move/resize (B)', () => cb.onTool('rect'));
    this.toolButtons = { pen, text, rect };

    this.label = document.createElement('span');
    this.label.textContent = DEFAULT_LABEL;
    Object.assign(this.label.style, {
      font: '12px -apple-system, system-ui, sans-serif',
      color: '#57606a',
      margin: '0 6px',
    } as CSSStyleDeclaration);

    content.append(
      pen,
      text,
      rect,
      this.divider(),
      this.button('Undo', 'Undo last (⌘Z)', cb.onUndo),
      this.button('Clear', 'Clear all', cb.onClear),
      this.button('Send', 'Send the screenshot to the agent now', cb.onSend, 'primary'),
      this.button('Cancel', 'Discard annotations & exit', cb.onCancel, 'danger'),
      this.label
    );

    // The collapsed state: a small dot the user hovers to bring the toolbar back.
    const dot = document.createElement('div');
    dot.title = 'Annotation tools — hover to expand';
    Object.assign(dot.style, {
      display: 'none',
      width: '22px',
      height: '22px',
      borderRadius: '50%',
      background: PEN,
      border: '2px solid #fff',
      boxShadow: '0 2px 10px rgba(0,0,0,.3)',
      cursor: 'pointer',
    } as CSSStyleDeclaration);

    bar.append(content, dot);
    bar.addEventListener('mouseenter', () => {
      this.hovered = true;
      this.clearCollapseTimer();
      this.expand();
    });
    bar.addEventListener('mouseleave', () => {
      this.hovered = false;
      this.scheduleCollapse(TOOLBAR_RECOLLAPSE_MS);
    });

    document.documentElement.appendChild(bar);
    this.el = bar;
    this.content = content;
    this.dot = dot;

    // Visible on entry, then fold away if the user doesn't engage with it.
    this.scheduleCollapse(TOOLBAR_AUTO_COLLAPSE_MS);
  }

  setActiveTool(name: ToolName): void {
    (Object.keys(this.toolButtons) as ToolName[]).forEach((n) => this.styleTool(this.toolButtons[n], n === name));
  }

  // Briefly show a status message (e.g. a send failure), then revert to the default label. Expands
  // the toolbar first so a collapsed dot doesn't hide the message, then lets it re-collapse.
  flashStatus(text: string): void {
    if (this.statusTimer != null) clearTimeout(this.statusTimer);
    this.clearCollapseTimer();
    this.expand();
    this.label.textContent = text;
    this.label.style.color = '#cf222e';
    this.statusTimer = window.setTimeout(() => {
      this.label.textContent = DEFAULT_LABEL;
      this.label.style.color = '#57606a';
      this.statusTimer = null;
      if (!this.hovered) this.scheduleCollapse(TOOLBAR_RECOLLAPSE_MS);
    }, 1800);
  }

  destroy(): void {
    if (this.statusTimer != null) clearTimeout(this.statusTimer);
    this.clearCollapseTimer();
    this.el.remove();
  }

  // ---- collapse/expand ----
  private expand(): void {
    this.content.style.display = 'flex';
    this.dot.style.display = 'none';
  }

  private collapse(): void {
    if (this.hovered) return; // never fold away while the pointer is on it
    this.content.style.display = 'none';
    this.dot.style.display = 'block';
  }

  private scheduleCollapse(delay: number): void {
    this.clearCollapseTimer();
    this.collapseTimer = window.setTimeout(() => {
      this.collapseTimer = null;
      this.collapse();
    }, delay);
  }

  private clearCollapseTimer(): void {
    if (this.collapseTimer != null) {
      clearTimeout(this.collapseTimer);
      this.collapseTimer = null;
    }
  }

  // ---- DOM builders ----
  private button(label: string, title: string, onClick: () => void, variant: Variant = 'default'): HTMLButtonElement {
    const b = document.createElement('button');
    b.textContent = label;
    b.title = title;
    const v = {
      default: { bg: '#f6f8fa', border: '#d0d7de', color: '#1f2328', weight: '400' },
      primary: { bg: '#0969da', border: '#0969da', color: '#fff', weight: '600' },
      danger: { bg: '#ffebe9', border: '#ff8182', color: '#cf222e', weight: '600' },
    }[variant];
    Object.assign(b.style, {
      font: '13px -apple-system, system-ui, sans-serif',
      fontWeight: v.weight,
      padding: '5px 10px',
      border: `1px solid ${v.border}`,
      borderRadius: '6px',
      background: v.bg,
      color: v.color,
      cursor: 'pointer',
    } as CSSStyleDeclaration);
    b.addEventListener('pointerdown', (ev) => ev.stopPropagation());
    b.addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      onClick();
    });
    return b;
  }

  // A tool button with its keyboard shortcut shown as a keycap (e.g. "Pen [P]").
  private toolButton(label: string, key: string, title: string, onClick: () => void): HTMLButtonElement {
    const b = this.button(label, title, onClick);
    const kbd = document.createElement('span');
    kbd.textContent = key;
    Object.assign(kbd.style, {
      marginLeft: '6px',
      fontSize: '10px',
      fontWeight: '600',
      opacity: '0.55',
      border: '1px solid currentColor',
      borderRadius: '3px',
      padding: '0 4px',
    } as CSSStyleDeclaration);
    b.append(kbd);
    return b;
  }

  private styleTool(btn: HTMLButtonElement, active: boolean): void {
    btn.style.background = active ? '#ffe3e0' : '#f6f8fa';
    btn.style.borderColor = active ? '#ff8182' : '#d0d7de';
    btn.style.color = active ? '#cf222e' : '#1f2328';
    btn.style.fontWeight = active ? '600' : '400';
  }

  private divider(): HTMLSpanElement {
    const d = document.createElement('span');
    Object.assign(d.style, {
      width: '1px',
      height: '18px',
      background: '#e1e4e8',
      margin: '0 3px',
    } as CSSStyleDeclaration);
    return d;
  }
}
