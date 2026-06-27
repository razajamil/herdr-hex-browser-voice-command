import { IText } from 'fabric';
import { Capture } from './capture';
import { RECORDING_EXIT_MS, SELECTION_STYLE, TOOLBAR_Z } from './constants';
import { sendFailureMessage } from './errors';
import { History } from './history';
import { attachKeyboard } from './keyboard';
import { notifyStarted, notifyStopped, requestBaseCapture } from './messages';
import { Scene } from './scene';
import { Toolbar } from './toolbar';
import { createRectTool, createTextTool, penTool } from './tools';
import type { Tool, ToolContext, ToolName } from './tools/types';

// Top-level annotation controller. Owns the Scene (Fabric canvas + frozen snapshot), Toolbar,
// Tools, undo History, and the daemon Capture pipeline, and wires them together. This is the
// only surface the content script touches.
//
// Flow: enter() grabs a clean screenshot, builds a Fabric canvas with it as the background, and
// lets the user annotate on top. Changes are debounced into a keep-fresh push to the daemon, and
// the explicit Send exports the composited canvas. Nothing re-screenshots the live tab while
// drawing, so the toolbar never has to be hidden — which is what eliminated the flicker.
export class Annotator {
  private scene: Scene | null = null;
  private toolbar: Toolbar | null = null;
  private history: History | null = null;
  private capture: Capture | null = null;
  private ctx: ToolContext | null = null;
  private tools: Record<ToolName, Tool> | null = null;
  private current: Tool | null = null;

  private tracking = true; // gate for change → (history + keep-fresh); tools pause it mid-drag
  private entering = false;
  private aborted = false;
  private sending = false;
  private detachKeyboard: (() => void) | null = null;
  private detachResize: (() => void) | null = null;
  private recordingExit: number | null = null;

  get active(): boolean {
    return this.scene != null;
  }

  async enter(): Promise<void> {
    if (this.scene || this.entering) return;
    this.entering = true;
    this.aborted = false;

    // Snapshot the pristine page BEFORE injecting any overlay, so the base never contains our
    // canvas or toolbar. Everything afterwards is composited on top of this frozen frame.
    const base = await requestBaseCapture();
    this.entering = false;
    if (this.aborted) return;
    if (!base) {
      this.toast("Couldn't capture this page to draw on");
      return;
    }

    const scene = await Scene.create(base);
    if (this.aborted) {
      scene.destroy();
      return;
    }
    this.scene = scene;
    this.history = new History(scene.canvas);
    this.capture = new Capture(() => scene.exportDataURL());

    this.ctx = {
      canvas: scene.canvas,
      begin: () => {
        this.tracking = false;
      },
      commit: () => {
        this.tracking = true;
        this.history?.record();
        this.capture?.schedule();
      },
      cancel: () => {
        this.tracking = true;
      },
    };
    this.tools = { pen: penTool, rect: createRectTool(), text: createTextTool() };

    const onChange = (): void => {
      if (!this.tracking || this.history?.isRestoring) return;
      this.history?.record();
      this.capture?.schedule();
    };
    scene.canvas.on('object:added', onChange);
    scene.canvas.on('object:modified', onChange);
    scene.canvas.on('object:removed', onChange);
    scene.canvas.on('path:created', (e) => e.path.set(SELECTION_STYLE)); // match pen strokes' handles
    // Annotation objects don't rotate — lock it and hide the rotate handle (incl. on restored
    // objects, since control visibility isn't serialized). Fires for rect, text, and pen paths.
    scene.canvas.on('object:added', (e) => {
      e.target.lockRotation = true;
      e.target.setControlsVisibility({ mtr: false });
    });

    this.toolbar = new Toolbar({
      onTool: (n) => this.setTool(n),
      onUndo: () => void this.undo(),
      onClear: () => void this.clear(),
      onSend: () => void this.send(),
      onCancel: () => this.exit(),
    });

    this.detachKeyboard = attachKeyboard({
      setTool: (n) => this.setTool(n),
      undo: () => void this.undo(),
      deleteSelection: () => this.deleteSelection(),
    });

    const onResize = (): void => scene.resize();
    window.addEventListener('resize', onResize);
    this.detachResize = () => window.removeEventListener('resize', onResize);

    this.setTool('pen');
    scene.focus(); // grab focus so P/T/B work before the first click (see Scene.focus)
    notifyStarted();
  }

  exit(): void {
    if (this.entering) {
      this.aborted = true; // cancel an in-flight enter()
      return;
    }
    if (!this.scene) return;
    this.capture?.cancel();
    if (this.recordingExit != null) {
      clearTimeout(this.recordingExit);
      this.recordingExit = null;
    }
    this.detachKeyboard?.();
    this.detachResize?.();
    this.detachKeyboard = null;
    this.detachResize = null;
    if (this.current && this.ctx) this.current.deactivate(this.ctx);
    this.toolbar?.destroy();
    this.scene.destroy();
    this.scene = null;
    this.toolbar = null;
    this.history = null;
    this.capture = null;
    this.ctx = null;
    this.tools = null;
    this.current = null;
    notifyStopped();
  }

  // Recording started (⌘⌘): push the freshest annotated frame, then auto-exit shortly after in
  // case the background's clear-exit is lost. Only fires on pages where the gesture reaches the
  // content script; iframed apps rely on the debounced keep-fresh push + the daemon-match watch.
  onRecordingStart(): void {
    if (!this.scene) return;
    void this.capture?.flush();
    if (this.recordingExit == null) {
      this.recordingExit = window.setTimeout(() => this.exit(), RECORDING_EXIT_MS);
    }
  }

  // ---- internals ----
  private setTool(name: ToolName): void {
    if (!this.tools || !this.ctx || this.current?.name === name) return;
    if (this.current) this.current.deactivate(this.ctx);
    this.current = this.tools[name];
    this.current.activate(this.ctx);
    this.toolbar?.setActiveTool(name);
  }

  private async undo(): Promise<void> {
    await this.history?.undo();
    this.capture?.schedule();
  }

  private async clear(): Promise<void> {
    await this.history?.clear();
    this.capture?.schedule();
  }

  private deleteSelection(): void {
    const canvas = this.scene?.canvas;
    if (!canvas) return;
    const objects = canvas.getActiveObjects();
    if (objects.length === 0) return;
    canvas.remove(...objects); // fires object:removed → onChange records + schedules
    canvas.discardActiveObject();
    canvas.requestRenderAll();
  }

  private async send(): Promise<void> {
    if (!this.scene || !this.capture || this.sending) return;
    const active = this.scene.canvas.getActiveObject();
    if (active instanceof IText && active.isEditing) active.exitEditing(); // commit open editor
    this.sending = true;
    const res = await this.capture.send();
    this.sending = false;
    if (res?.delivered) this.exit();
    else this.toolbar?.flashStatus(sendFailureMessage(res?.reason));
  }

  // A transient on-page notice for the rare case where the page can't be captured (e.g. a
  // protected page or an unfocused window) — there's no toolbar yet to flash a message in.
  private toast(message: string): void {
    const el = document.createElement('div');
    el.textContent = message;
    Object.assign(el.style, {
      position: 'fixed',
      bottom: '16px',
      left: '50%',
      transform: 'translateX(-50%)',
      zIndex: TOOLBAR_Z,
      font: '13px -apple-system, system-ui, sans-serif',
      color: '#fff',
      background: '#cf222e',
      padding: '8px 14px',
      borderRadius: '8px',
      boxShadow: '0 2px 14px rgba(0,0,0,.28)',
    } as CSSStyleDeclaration);
    document.documentElement.appendChild(el);
    window.setTimeout(() => el.remove(), 2600);
  }
}
