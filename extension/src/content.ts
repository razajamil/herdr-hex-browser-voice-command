// Content script: best-effort recording-gesture detection + on-page annotation overlay.
//
// Annotation mode (toggled from the popup) puts a transparent full-viewport canvas over the
// page. Three tools: a freehand Pen, a Text tool (click, then type; drag to reposition), and
// a Rectangle tool (drag to draw; select to move/resize). Everything is a single item list
// rendered onto the canvas, so the screenshot the daemon attaches to your prompt includes it.
//
// Capture is driven by annotating (reliable), not the ⌘⌘ gesture (iframed apps never deliver
// it here). The toolbar and the rect selection handles are hidden during capture so they
// stay out of the shot.

(() => {
  // ---- recording gestures ----
  const DOUBLE_TAP_MS = 400;
  let lastMetaUp = 0;

  function send(gesture: string): void {
    try {
      chrome.runtime.sendMessage({ type: 'gesture', gesture });
    } catch {
      // background worker asleep / extension reloading — ignore.
    }
  }

  // ---- annotation state ----
  type Pt = { x: number; y: number };
  type Item =
    | { kind: 'stroke'; points: Pt[] }
    | { kind: 'text'; x: number; y: number; text: string }
    | { kind: 'rect'; x: number; y: number; w: number; h: number };
  type RectItem = Extract<Item, { kind: 'rect' }>;
  type Corner = 'tl' | 'tr' | 'bl' | 'br';

  const PEN = '#ff2d2d';
  const WIDTH = 3;
  const FONT_PX = 17;
  const HANDLE = 10; // resize-handle size / grab radius
  const CANVAS_Z = '2147483645';
  const EDITOR_Z = '2147483646';
  const TOOLBAR_Z = '2147483647';
  const DEFAULT_LABEL = 'speak or Send';

  let drawing = false;
  let tool: 'pen' | 'text' | 'rect' = 'pen';
  let canvas: HTMLCanvasElement | null = null;
  let ctx: CanvasRenderingContext2D | null = null;
  let toolbar: HTMLDivElement | null = null;
  let toolbarLabel: HTMLSpanElement | null = null;
  let penBtn: HTMLButtonElement | null = null;
  let textBtn: HTMLButtonElement | null = null;
  let rectBtn: HTMLButtonElement | null = null;
  let editor: HTMLDivElement | null = null;
  let items: Item[] = [];
  let currentStroke: Pt[] | null = null;
  let dragText: { item: Extract<Item, { kind: 'text' }>; dx: number; dy: number } | null = null;
  let selectedRect: RectItem | null = null;
  let rectAction:
    | { type: 'draw'; item: RectItem }
    | { type: 'move'; item: RectItem; dx: number; dy: number }
    | { type: 'resize'; item: RectItem; fx: number; fy: number }
    | null = null;
  let suppressHandles = false;
  let fallbackExit: number | null = null;
  let captureTimer: number | null = null;
  let capturing = false;
  let sending = false;

  function setupCtx(): void {
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.floor(window.innerWidth * dpr);
    canvas.height = Math.floor(window.innerHeight * dpr);
    ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.scale(dpr, dpr); // draw in CSS px, store at device px → crisp + aligned with capture
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
  }

  // ---- rendering ----
  function drawStroke(points: Pt[]): void {
    if (!ctx || points.length === 0) return;
    ctx.strokeStyle = PEN;
    ctx.lineWidth = WIDTH;
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x, points[i].y);
    if (points.length === 1) ctx.lineTo(points[0].x + 0.1, points[0].y + 0.1); // a dot/tap
    ctx.stroke();
  }

  function drawText(it: { x: number; y: number; text: string }): void {
    if (!ctx) return;
    ctx.fillStyle = PEN;
    ctx.textBaseline = 'top';
    ctx.font = `${FONT_PX}px -apple-system, system-ui, sans-serif`;
    ctx.fillText(it.text, it.x, it.y);
  }

  function drawRect(it: RectItem): void {
    if (!ctx) return;
    ctx.strokeStyle = PEN;
    ctx.lineWidth = WIDTH;
    ctx.strokeRect(it.x, it.y, it.w, it.h); // handles negative w/h fine
  }

  function drawHandles(it: RectItem): void {
    if (!ctx) return;
    const b = norm(it);
    const corners: Pt[] = [
      { x: b.x, y: b.y },
      { x: b.x + b.w, y: b.y },
      { x: b.x, y: b.y + b.h },
      { x: b.x + b.w, y: b.y + b.h },
    ];
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = PEN;
    ctx.fillStyle = '#fff';
    for (const c of corners) {
      ctx.beginPath();
      ctx.rect(c.x - HANDLE / 2, c.y - HANDLE / 2, HANDLE, HANDLE);
      ctx.fill();
      ctx.stroke();
    }
  }

  function redraw(): void {
    if (!ctx || !canvas) return;
    ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
    for (const it of items) {
      if (it.kind === 'stroke') drawStroke(it.points);
      else if (it.kind === 'text') drawText(it);
      else drawRect(it);
    }
    if (selectedRect && tool === 'rect' && !suppressHandles) drawHandles(selectedRect);
  }

  function onResize(): void {
    setupCtx();
    redraw();
  }

  // ---- geometry / hit-testing ----
  function norm(r: { x: number; y: number; w: number; h: number }): { x: number; y: number; w: number; h: number } {
    return { x: r.w < 0 ? r.x + r.w : r.x, y: r.h < 0 ? r.y + r.h : r.y, w: Math.abs(r.w), h: Math.abs(r.h) };
  }

  function normalizeRect(it: RectItem): void {
    if (it.w < 0) {
      it.x += it.w;
      it.w = -it.w;
    }
    if (it.h < 0) {
      it.y += it.h;
      it.h = -it.h;
    }
  }

  function textBounds(it: { x: number; y: number; text: string }): { x: number; y: number; w: number; h: number } {
    let w = 0;
    if (ctx) {
      ctx.font = `${FONT_PX}px -apple-system, system-ui, sans-serif`;
      w = ctx.measureText(it.text).width;
    }
    return { x: it.x, y: it.y, w, h: FONT_PX };
  }

  function hitTestText(px: number, py: number): Extract<Item, { kind: 'text' }> | null {
    const pad = 6;
    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i];
      if (it.kind !== 'text') continue;
      const b = textBounds(it);
      if (px >= b.x - pad && px <= b.x + b.w + pad && py >= b.y - pad && py <= b.y + b.h + pad) return it;
    }
    return null;
  }

  function hitTestRect(px: number, py: number): RectItem | null {
    const pad = 4;
    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i];
      if (it.kind !== 'rect') continue;
      const b = norm(it);
      if (px >= b.x - pad && px <= b.x + b.w + pad && py >= b.y - pad && py <= b.y + b.h + pad) return it;
    }
    return null;
  }

  function handleAt(it: RectItem, px: number, py: number): Corner | null {
    const b = norm(it);
    const near = (cx: number, cy: number) => Math.abs(px - cx) <= HANDLE && Math.abs(py - cy) <= HANDLE;
    if (near(b.x, b.y)) return 'tl';
    if (near(b.x + b.w, b.y)) return 'tr';
    if (near(b.x, b.y + b.h)) return 'bl';
    if (near(b.x + b.w, b.y + b.h)) return 'br';
    return null;
  }

  // The corner that must stay fixed while dragging `corner` (the diagonal opposite).
  function fixedCorner(it: RectItem, corner: Corner): Pt {
    const b = norm(it);
    if (corner === 'tl') return { x: b.x + b.w, y: b.y + b.h };
    if (corner === 'tr') return { x: b.x, y: b.y + b.h };
    if (corner === 'bl') return { x: b.x + b.w, y: b.y };
    return { x: b.x, y: b.y };
  }

  function cornerCursor(c: Corner): string {
    return c === 'tl' || c === 'br' ? 'nwse-resize' : 'nesw-resize';
  }

  function removeItem(it: Item): void {
    const i = items.indexOf(it);
    if (i >= 0) items.splice(i, 1);
  }

  // ---- pointer handling ----
  function pointerDown(e: PointerEvent): void {
    if (!drawing) return;
    e.preventDefault();
    const x = e.clientX;
    const y = e.clientY;

    if (tool === 'text') {
      commitEditor(); // commit any open box first, so it's hit-testable
      const hit = hitTestText(x, y);
      if (hit) {
        dragText = { item: hit, dx: x - hit.x, dy: y - hit.y }; // grab + drag an existing label
        capturePointer(e);
      } else {
        openEditor(x, y);
      }
      return;
    }

    if (tool === 'rect') {
      // 1. resize handle of the selected rect
      if (selectedRect) {
        const corner = handleAt(selectedRect, x, y);
        if (corner) {
          const f = fixedCorner(selectedRect, corner);
          rectAction = { type: 'resize', item: selectedRect, fx: f.x, fy: f.y };
          capturePointer(e);
          return;
        }
      }
      // 2. body of some rect → select + move
      const hit = hitTestRect(x, y);
      if (hit) {
        selectedRect = hit;
        rectAction = { type: 'move', item: hit, dx: x - hit.x, dy: y - hit.y };
        redraw();
        capturePointer(e);
        return;
      }
      // 3. empty → start a new rect
      const item: RectItem = { kind: 'rect', x, y, w: 0, h: 0 };
      items.push(item);
      selectedRect = item;
      rectAction = { type: 'draw', item };
      capturePointer(e);
      return;
    }

    // pen
    capturePointer(e);
    currentStroke = [{ x, y }];
    items.push({ kind: 'stroke', points: currentStroke });
    drawStroke(currentStroke);
  }

  function pointerMove(e: PointerEvent): void {
    if (!drawing) return;
    const x = e.clientX;
    const y = e.clientY;

    if (dragText) {
      dragText.item.x = x - dragText.dx;
      dragText.item.y = y - dragText.dy;
      redraw();
      return;
    }

    if (rectAction) {
      const a = rectAction;
      if (a.type === 'draw') {
        a.item.w = x - a.item.x;
        a.item.h = y - a.item.y;
      } else if (a.type === 'move') {
        a.item.x = x - a.dx;
        a.item.y = y - a.dy;
      } else {
        a.item.x = a.fx;
        a.item.y = a.fy;
        a.item.w = x - a.fx;
        a.item.h = y - a.fy;
      }
      redraw();
      return;
    }

    // hover cursors
    if (tool === 'text' && !currentStroke && canvas) {
      canvas.style.cursor = hitTestText(x, y) ? 'move' : 'text';
    } else if (tool === 'rect' && canvas) {
      let cur = 'crosshair';
      if (selectedRect) {
        const c = handleAt(selectedRect, x, y);
        if (c) cur = cornerCursor(c);
      }
      if (cur === 'crosshair' && hitTestRect(x, y)) cur = 'move';
      canvas.style.cursor = cur;
    }

    if (!currentStroke || !ctx) return;
    currentStroke.push({ x, y });
    const a = currentStroke[currentStroke.length - 2];
    const b = currentStroke[currentStroke.length - 1];
    ctx.strokeStyle = PEN;
    ctx.lineWidth = WIDTH;
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
  }

  function pointerUp(e: PointerEvent): void {
    if (dragText) {
      dragText = null;
      releasePointer(e);
      scheduleCapture();
      return;
    }
    if (rectAction) {
      const a = rectAction;
      if (a.type === 'draw' || a.type === 'resize') {
        normalizeRect(a.item);
        if (a.item.w < 4 && a.item.h < 4) {
          removeItem(a.item); // discard an accidental tiny rect
          selectedRect = null;
        }
      }
      rectAction = null;
      releasePointer(e);
      redraw();
      scheduleCapture();
      return;
    }
    if (!currentStroke) return;
    currentStroke = null;
    releasePointer(e);
    scheduleCapture();
  }

  function capturePointer(e: PointerEvent): void {
    try {
      canvas?.setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
  }
  function releasePointer(e: PointerEvent): void {
    try {
      canvas?.releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
  }

  // A floating contentEditable box at the click point; Enter/blur commits, Escape cancels.
  function openEditor(x: number, y: number): void {
    commitEditor();
    const el = document.createElement('div');
    el.contentEditable = 'true';
    Object.assign(el.style, {
      position: 'fixed',
      left: `${x}px`,
      top: `${y}px`,
      font: `${FONT_PX}px -apple-system, system-ui, sans-serif`,
      lineHeight: `${FONT_PX}px`,
      color: PEN,
      caretColor: PEN,
      background: 'rgba(255,45,45,0.07)',
      padding: '0',
      margin: '0',
      border: 'none',
      outline: 'none',
      minWidth: '2px',
      maxWidth: '80vw',
      whiteSpace: 'pre',
      zIndex: EDITOR_Z,
    } as CSSStyleDeclaration);
    el.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') {
        ev.preventDefault();
        commitEditor();
      } else if (ev.key === 'Escape') {
        ev.stopPropagation();
        cancelEditor();
      }
    });
    el.addEventListener('blur', () => commitEditor());
    editor = el;
    document.documentElement.appendChild(el);
    el.focus();
  }

  function commitEditor(): void {
    if (!editor) return;
    const el = editor;
    editor = null; // clear first so the blur handler doesn't re-enter
    const text = (el.textContent || '').trim();
    const x = parseFloat(el.style.left);
    const y = parseFloat(el.style.top);
    el.remove();
    if (text) {
      items.push({ kind: 'text', x, y, text });
      redraw();
      scheduleCapture();
    }
  }

  function cancelEditor(): void {
    if (!editor) return;
    const el = editor;
    editor = null;
    el.remove();
  }

  function undo(): void {
    if (editor) {
      cancelEditor();
      return;
    }
    items.pop();
    selectedRect = null;
    redraw();
  }

  function clearAll(): void {
    cancelEditor();
    items = [];
    selectedRect = null;
    redraw();
  }

  // ---- toolbar ----
  function makeButton(
    label: string,
    title: string,
    onClick: () => void,
    variant: 'default' | 'primary' | 'danger' = 'default'
  ): HTMLButtonElement {
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
  function makeToolButton(label: string, key: string, title: string, onClick: () => void): HTMLButtonElement {
    const b = makeButton(label, title, onClick);
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

  function styleTool(btn: HTMLButtonElement | null, active: boolean): void {
    if (!btn) return;
    btn.style.background = active ? '#ffe3e0' : '#f6f8fa';
    btn.style.borderColor = active ? '#ff8182' : '#d0d7de';
    btn.style.color = active ? '#cf222e' : '#1f2328';
    btn.style.fontWeight = active ? '600' : '400';
  }

  function setTool(t: 'pen' | 'text' | 'rect'): void {
    if (t !== 'text') commitEditor(); // leaving the text tool commits an open box
    if (t !== 'rect') selectedRect = null; // hide handles outside the rect tool
    tool = t;
    styleTool(penBtn, t === 'pen');
    styleTool(textBtn, t === 'text');
    styleTool(rectBtn, t === 'rect');
    if (canvas) canvas.style.cursor = t === 'text' ? 'text' : 'crosshair';
    redraw();
  }

  function divider(): HTMLSpanElement {
    const d = document.createElement('span');
    Object.assign(d.style, { width: '1px', height: '18px', background: '#e1e4e8', margin: '0 3px' } as CSSStyleDeclaration);
    return d;
  }

  function createToolbar(): void {
    toolbar = document.createElement('div');
    Object.assign(toolbar.style, {
      position: 'fixed',
      bottom: '16px',
      left: '50%',
      transform: 'translateX(-50%)',
      zIndex: TOOLBAR_Z,
      display: 'flex',
      gap: '6px',
      alignItems: 'center',
      padding: '6px 8px',
      background: '#fff',
      borderRadius: '10px',
      boxShadow: '0 2px 14px rgba(0,0,0,.28)',
      border: '1px solid #d0d7de',
    } as CSSStyleDeclaration);

    penBtn = makeToolButton('✏️ Pen', 'P', 'Freehand pen (P)', () => setTool('pen'));
    textBtn = makeToolButton('Text', 'T', 'Click the page, then type; drag to move (T)', () => setTool('text'));
    rectBtn = makeToolButton('▭ Rect', 'R', 'Drag to draw; select to move/resize (R)', () => setTool('rect'));

    toolbarLabel = document.createElement('span');
    toolbarLabel.textContent = DEFAULT_LABEL;
    Object.assign(toolbarLabel.style, {
      font: '12px -apple-system, system-ui, sans-serif',
      color: '#57606a',
      margin: '0 6px',
    } as CSSStyleDeclaration);

    toolbar.append(
      penBtn,
      textBtn,
      rectBtn,
      divider(),
      makeButton('Undo', 'Undo last (⌘Z)', undo),
      makeButton('Clear', 'Clear all', clearAll),
      makeButton('Send', 'Send the screenshot to the agent now', sendNow, 'primary'),
      makeButton('Cancel', 'Discard annotations & exit', exitDrawMode, 'danger'),
      toolbarLabel
    );
    document.documentElement.appendChild(toolbar);
    setTool('pen');
  }

  // Briefly show a status message in the toolbar, then revert.
  function flashStatus(text: string): void {
    if (!toolbarLabel) return;
    toolbarLabel.textContent = text;
    toolbarLabel.style.color = '#cf222e';
    window.setTimeout(() => {
      if (toolbarLabel) {
        toolbarLabel.textContent = DEFAULT_LABEL;
        toolbarLabel.style.color = '#57606a';
      }
    }, 1800);
  }

  // ---- capture / send ----
  // Hide editing chrome (toolbar + rect handles) so only the annotation content is captured.
  function setChromeHidden(hidden: boolean): void {
    suppressHandles = hidden;
    if (toolbar) toolbar.style.visibility = hidden ? 'hidden' : 'visible';
    redraw();
  }

  // Snapshot the annotated page so the daemon has a current frame to attach when you speak.
  // Driven by annotating (reliable) rather than the recording gesture.
  async function captureAnnotated(): Promise<void> {
    commitEditor();
    if (!drawing || capturing || items.length === 0) return;
    capturing = true;
    setChromeHidden(true);
    try {
      await chrome.runtime.sendMessage({ type: 'capture-now' });
    } catch {
      /* background asleep / reloading — ignore */
    }
    if (drawing) setChromeHidden(false);
    capturing = false;
  }

  function scheduleCapture(): void {
    if (captureTimer != null) clearTimeout(captureTimer);
    captureTimer = window.setTimeout(() => {
      captureTimer = null;
      void captureAnnotated();
    }, 500);
  }

  // Send button: capture + deliver the annotated frame to the matching pane now; clear+exit
  // on success, otherwise stay and flash the reason.
  async function sendNow(): Promise<void> {
    if (!drawing || sending) return;
    commitEditor();
    sending = true;
    setChromeHidden(true);
    let res: { delivered?: boolean; reason?: string } | undefined;
    try {
      res = await chrome.runtime.sendMessage({ type: 'draw-send' });
    } catch {
      /* background asleep — treat as failure below */
    }
    sending = false;
    if (res?.delivered) {
      exitDrawMode();
    } else {
      setChromeHidden(false);
      flashStatus(sendFailureMessage(res?.reason));
    }
  }

  function sendFailureMessage(reason: string | undefined): string {
    switch (reason) {
      case 'no-route':
      case 'no-matching-route':
        return 'No route matches this tab';
      case 'no-workspace':
      case 'no-workspace-key':
      case 'no-tab':
      case 'no-pane':
        return 'Agent pane not found';
      case 'no-screenshot':
        return 'Nothing to send yet';
      case 'daemon-unreachable':
        return 'Daemon not running';
      default:
        return 'Send failed — try again';
    }
  }

  // ---- mode lifecycle ----
  function enterDrawMode(): void {
    if (drawing) return;
    drawing = true;
    items = [];
    currentStroke = null;
    dragText = null;
    selectedRect = null;
    rectAction = null;
    suppressHandles = false;
    tool = 'pen';
    canvas = document.createElement('canvas');
    Object.assign(canvas.style, {
      position: 'fixed',
      top: '0',
      left: '0',
      width: '100vw',
      height: '100vh',
      zIndex: CANVAS_Z,
      cursor: 'crosshair',
      touchAction: 'none',
      background: 'transparent',
    } as CSSStyleDeclaration);
    document.documentElement.appendChild(canvas);
    setupCtx();
    canvas.addEventListener('pointerdown', pointerDown);
    canvas.addEventListener('pointermove', pointerMove);
    canvas.addEventListener('pointerup', pointerUp);
    canvas.addEventListener('pointercancel', pointerUp);
    window.addEventListener('resize', onResize);
    createToolbar();
    try {
      chrome.runtime.sendMessage({ type: 'draw-started' }); // background watches for the next match → clear
    } catch {
      /* ignore */
    }
  }

  function exitDrawMode(): void {
    if (!drawing) return;
    drawing = false;
    cancelEditor();
    if (fallbackExit != null) {
      clearTimeout(fallbackExit);
      fallbackExit = null;
    }
    if (captureTimer != null) {
      clearTimeout(captureTimer);
      captureTimer = null;
    }
    try {
      chrome.runtime.sendMessage({ type: 'draw-stopped' });
    } catch {
      /* ignore */
    }
    window.removeEventListener('resize', onResize);
    canvas?.remove();
    toolbar?.remove();
    canvas = null;
    ctx = null;
    toolbar = null;
    toolbarLabel = null;
    penBtn = null;
    textBtn = null;
    rectBtn = null;
    items = [];
    currentStroke = null;
    dragText = null;
    selectedRect = null;
    rectAction = null;
  }

  // Recording started: commit any open text, hide chrome so it's not captured, and arm a
  // fallback exit in case the background's 'draw-clear-exit' (sent after capture) is lost.
  function onRecordingStart(): void {
    if (!drawing) return;
    commitEditor();
    setChromeHidden(true);
    if (fallbackExit == null) fallbackExit = window.setTimeout(exitDrawMode, 1500);
  }

  // ---- gesture listeners ----
  document.addEventListener(
    'keyup',
    (e) => {
      if (e.code !== 'MetaLeft') return;
      const now = e.timeStamp;
      if (now - lastMetaUp <= DOUBLE_TAP_MS) {
        lastMetaUp = 0;
        send('meta-double'); // start of a recording
        onRecordingStart();
      } else {
        lastMetaUp = now;
      }
    },
    true
  );

  document.addEventListener(
    'keydown',
    (e) => {
      if (editor) return; // typing in a text box — let the editor handle its own keys
      if (e.key === 'Escape') {
        // Don't end the drawing session on Escape — too easy to hit by mistake. Exit is only
        // via the Cancel button. (An in-progress text box still cancels via its own handler.)
        if (!drawing) send('escape'); // abort recording when not annotating
      } else if (drawing && (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        undo();
      } else if (drawing && !e.metaKey && !e.ctrlKey && !e.altKey) {
        const k = e.key.toLowerCase();
        if (k === 'p' || k === 't' || k === 'r') {
          e.preventDefault();
          e.stopPropagation();
          setTool(k === 'p' ? 'pen' : k === 't' ? 'text' : 'rect');
        }
      }
    },
    true
  );

  // ---- messages from the popup (toggle/query) and background (clear after capture) ----
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || typeof msg.type !== 'string') return;
    if (msg.type === 'draw-query') {
      sendResponse({ drawing });
    } else if (msg.type === 'draw') {
      if (msg.on) enterDrawMode();
      else exitDrawMode();
      sendResponse({ ok: true, drawing });
    } else if (msg.type === 'draw-clear-exit') {
      exitDrawMode();
    }
  });
})();
