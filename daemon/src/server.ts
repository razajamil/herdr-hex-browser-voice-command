// voicerouter daemon
// ------------------
// - Streams active-tab URLs + window focus from the extension into timelines.
// - Watches Hex's transcription_history.json; on a NEW transcript, picks the URL active
//   during its recording window and delivers it to the herdr pane named by a routing rule.
// - Routing rules + the focus-gate setting are synced from the extension via POST /config.

import fs from 'fs';
import path from 'path';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { serve } from '@hono/node-server';
import { describeRoute, openAPIRouteHandler, resolver, validator } from 'hono-openapi';
import { cfg } from './config';
import { readHistory } from './hex';
import type { Transcript } from './hex';
import { selectUrlForTranscript, matchTranscriptByWindow } from './matcher';
import type { UrlEntry } from './matcher';
import { matchRoute, resolveTarget, deliver } from './herdr';
import { saveScreenshot, selectScreenshot, screenshotCount, lastScreenshotAt } from './screenshots';
import { type Route } from '../../shared/config-schema';
import {
  ActiveUrlBody,
  ScreenshotBody,
  FocusBody,
  ConfigBody,
  RecordingBody,
  MatchBody,
  RouteTestBody,
  SendBody,
  LatestQuery,
  HealthResponse,
  AckResponse,
} from './api-schemas';

const startedAt = Date.now();

// ---- state ----
interface FocusEntry {
  ts: number;
  focused: boolean;
}
interface PendingBracket {
  tStartMs: number;
  tFinishMs: number | null;
  startUrl: string | null;
  startTitle: string | null;
  tabId: number | null;
}
interface RouteMeta {
  reason: string;
  source: string;
}
type Delivery = { status: string; [k: string]: unknown };

const urlTimeline: UrlEntry[] = [];
const focusTimeline: FocusEntry[] = [];
const seenIds = new Set<string>();
let lastMatch: Record<string, unknown> | null = null;
let lastError: string | null = null;
let pendingBracket: PendingBracket | null = null;

// Settings synced from the extension (extension is the source of truth). Defaults are
// permissive so behavior is unchanged before an extension connects.
const config: { requireBrowserFocus: boolean; attachScreenshot: boolean; routes: Route[] } = {
  requireBrowserFocus: false,
  attachScreenshot: false,
  routes: [
    { name: 'Payroll dev', urlPattern: 'http://{workspace}.payroll.localhost/*', tabName: 'main', paneName: 'agent' },
  ],
};

// ---- helpers ----
function log(...args: unknown[]): void {
  console.log(new Date().toISOString(), ...args);
}

function prune(arr: { ts: number }[]): void {
  const cutoff = Date.now() - cfg.TIMELINE_TTL_MS;
  while (arr.length > cfg.TIMELINE_MAX || (arr.length && arr[0].ts < cutoff)) arr.shift();
}

function pushUrl(entry: UrlEntry): void {
  urlTimeline.push(entry);
  prune(urlTimeline);
}

// Focus state as of a moment = the last focus event at/before it. true | false | null (unknown).
function wasFocusedAt(ms: number): boolean | null {
  let state: boolean | null = null;
  for (const e of focusTimeline) {
    if (e.ts <= ms) state = e.focused;
    else break;
  }
  return state;
}

// ---- routing ----
async function route(transcript: Transcript, urlEntry: UrlEntry | null, meta: RouteMeta): Promise<void> {
  const url = urlEntry ? urlEntry.url : null;
  const match: Record<string, unknown> = {
    at: Date.now(),
    transcriptId: transcript.id,
    textPreview: transcript.text.slice(0, 140),
    durationSec: transcript.durationSec,
    url,
    urlTitle: urlEntry ? urlEntry.title : null,
    reason: meta.reason,
    source: meta.source,
    delivery: null,
  };
  lastMatch = match;
  log(`MATCH [${meta.source}] ${transcript.id} -> ${url || '(no url)'} (${meta.reason})`);
  log(`   "${transcript.text.slice(0, 80)}${transcript.text.length > 80 ? '…' : ''}"`);

  // Focus gate: only route if Chrome was focused when the recording started.
  if (config.requireBrowserFocus) {
    const focused = wasFocusedAt(transcript.startUnixMs ?? 0);
    if (focused === false) {
      log('   skip: browser window not focused at recording time (requireBrowserFocus)');
      match.delivery = { status: 'skipped', reason: 'browser-not-focused' };
      return;
    }
    if (focused === null) log('   note: focus state unknown at recording time; routing anyway');
  }

  // Optionally reference a screenshot of the page the user was looking at when they spoke.
  // We can't paste an image into a terminal, so we hand the agent a file PATH to read.
  let text = transcript.text;
  if (config.attachScreenshot) {
    const shot = selectScreenshot(transcript.startUnixMs ?? Date.now());
    if (shot) {
      text = `Screenshot of my current browser tab (read this image file): ${shot.path}\n\n${transcript.text}`;
      match.screenshot = shot.path;
      log(`   attached screenshot ${shot.path}`);
    } else {
      log('   note: attachScreenshot on, but no recent screenshot to attach');
    }
  }

  match.delivery = await deliverToHerdr(url, text, { submit: true });
}

// Match the URL against the configured routes, resolve the herdr pane, deliver. Shared by
// the watcher (real routing) and the /route-test endpoint (safe manual testing).
async function deliverToHerdr(
  url: string | null,
  text: string,
  opts: { submit?: boolean; dryRun?: boolean } = {}
): Promise<Delivery> {
  const submit = opts.submit !== false;
  const dryRun = opts.dryRun === true;

  const matched = matchRoute(url, config.routes);
  if (!matched) {
    log(`   skip: no route matches ${url || 'no url'}`);
    return { status: 'skipped', reason: 'no-matching-route', url };
  }
  const { route: rule } = matched;
  // An explicit workspaceKey pins the target workspace (for URLs with no {workspace} to
  // capture, e.g. a master dev-server URL); otherwise fall back to the URL pattern's capture.
  const key = (rule.workspaceKey || matched.key).toLowerCase();
  if (!key) {
    log(`   skip: route "${rule.name}" has no workspace key (URL has no {capture} and no workspaceKey set)`);
    return { status: 'skipped', reason: 'no-workspace-key', route: rule.name };
  }
  try {
    const target = await resolveTarget(key, rule.tabName, rule.paneName);
    if (!target.ok) {
      log(`   skip: route "${rule.name}" → no target for "${key}" (${target.reason})`);
      return { status: 'unresolved', route: rule.name, ...target };
    }
    if (dryRun) {
      log(`   dry-run: route "${rule.name}" → ${target.workspaceLabel} ${target.paneId} (${target.tabName}/${target.paneName})`);
      return { status: 'resolved', route: rule.name, ...target };
    }
    const d = await deliver(target.paneId, text, { submit });
    log(`   delivered via "${rule.name}" to ${target.workspaceLabel} ${target.paneId}${submit ? ' + Enter' : ' (no submit)'}`);
    return { status: 'delivered', route: rule.name, ...target, ...d };
  } catch (err) {
    log(`   delivery error for "${key}": ${(err as Error).message}`);
    return { status: 'error', key, error: (err as Error).message };
  }
}

// ---- transcript watcher (primary signal) ----
function handleNewTranscript(t: Transcript): void {
  if (pendingBracket && pendingBracket.tFinishMs != null && t.endUnixMs != null) {
    const near = Math.abs(t.endUnixMs - pendingBracket.tFinishMs) <= cfg.BRACKET_MATCH_TOLERANCE_MS;
    if (near) {
      const entry: UrlEntry | null = pendingBracket.startUrl
        ? { ts: pendingBracket.tStartMs, url: pendingBracket.startUrl, title: pendingBracket.startTitle, tabId: pendingBracket.tabId }
        : selectUrlForTranscript(t, urlTimeline).entry;
      route(t, entry, { reason: 'explicit-bracket', source: 'watcher+bracket' }).catch((e) => log('route error:', e.message));
      pendingBracket = null;
      return;
    }
  }
  const sel = selectUrlForTranscript(t, urlTimeline);
  route(t, sel.entry, { reason: sel.reason, source: 'watcher' }).catch((e) => log('route error:', e.message));
}

function scanForNewTranscripts(opts: { seedOnly?: boolean } = {}): void {
  const { ok, transcripts, error } = readHistory();
  if (!ok) {
    lastError = error;
    return;
  }
  lastError = null;
  const fresh = transcripts.filter((t) => !seenIds.has(t.id));
  fresh.reverse(); // newest-first -> oldest-first so logs read chronologically
  for (const t of fresh) {
    seenIds.add(t.id);
    if (!opts.seedOnly) handleNewTranscript(t);
  }
  if (opts.seedOnly) log(`seeded ${seenIds.size} existing transcript id(s)`);
}

function watchHistory(): void {
  const file = cfg.HEX_HISTORY_PATH;
  const dir = path.dirname(file);
  const base = path.basename(file);
  let timer: NodeJS.Timeout | null = null;
  const onChange = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => scanForNewTranscripts(), cfg.WATCH_DEBOUNCE_MS);
  };
  // Watch the directory, not the file: Hex writes atomically (temp + rename), which breaks
  // a watch bound to the original inode.
  try {
    fs.watch(dir, (_evt, fname) => {
      if (!fname || fname === base) onChange();
    });
    log(`watching ${file}`);
  } catch (err) {
    log(`fs.watch failed (${(err as Error).message}); polling every 1s instead`);
    setInterval(() => scanForNewTranscripts(), 1000);
  }
}

// After a "finish", poll briefly in case fs.watch is slow / Hex throttles its write.
function scheduleNudge(): void {
  let n = 0;
  const iv = setInterval(() => {
    scanForNewTranscripts();
    if (++n >= 30) clearInterval(iv); // ~30 * 150ms ≈ 4.5s
  }, 150);
}

// ---- HTTP server (Hono + hono-openapi) ----
const app = new Hono();

// CORS for the extension (and curl-based testing). The middleware also answers the OPTIONS
// preflight itself, so no explicit handler is needed.
app.use('*', cors({ origin: '*', allowMethods: ['GET', 'POST', 'OPTIONS'], allowHeaders: ['Content-Type'] }));

// A describeRoute response entry: a description, optionally with a JSON body schema drawn
// into the spec via resolver(). Request bodies are documented automatically by validator().
type SpecSchema = Parameters<typeof resolver>[0];
const jres = (description: string, schema?: SpecSchema) =>
  schema
    ? { description, content: { 'application/json': { schema: resolver(schema) } } }
    : { description };

app.get(
  '/health',
  describeRoute({ summary: 'Daemon health and current-state snapshot', tags: ['status'], responses: { 200: jres('Health snapshot', HealthResponse) } }),
  (c) => {
    const hist = readHistory();
    return c.json({
      ok: true,
      service: 'voicerouter',
      version: cfg.VERSION,
      uptimeSec: Math.round((Date.now() - startedAt) / 1000),
      hexHistoryPath: cfg.HEX_HISTORY_PATH,
      hexHistoryReadable: hist.ok,
      transcriptCount: hist.transcripts.length,
      timelineSize: urlTimeline.length,
      screenshotCount: screenshotCount(),
      lastScreenshotAt: lastScreenshotAt(),
      currentUrl: urlTimeline.length ? urlTimeline[urlTimeline.length - 1].url : null,
      browserFocused: focusTimeline.length ? focusTimeline[focusTimeline.length - 1].focused : null,
      config,
      pendingBracket: !!pendingBracket,
      lastMatch,
      lastError,
    });
  }
);

app.get(
  '/',
  describeRoute({ summary: 'API index', tags: ['status'], responses: { 200: jres('Service name, version, and endpoint list') } }),
  (c) =>
    c.json({
      service: 'voicerouter',
      version: cfg.VERSION,
      endpoints: ['GET /health', 'GET /openapi', 'POST /active-url', 'POST /screenshot', 'POST /focus', 'POST /config', 'POST /recording', 'POST /match', 'POST /route-test', 'POST /send', 'GET /transcripts/latest'],
    })
);

app.get(
  '/transcripts/latest',
  describeRoute({ summary: 'Recent Hex transcripts (newest first)', tags: ['transcripts'], responses: { 200: jres('Transcript previews') } }),
  validator('query', LatestQuery),
  (c) => {
    const { n } = c.req.valid('query');
    const { transcripts } = readHistory();
    return c.json({
      transcripts: transcripts.slice(0, n ?? 5).map((t) => ({
        id: t.id,
        durationSec: t.durationSec,
        endUnixMs: t.endUnixMs,
        sourceAppName: t.sourceAppName,
        textPreview: t.text.slice(0, 80),
      })),
    });
  }
);

app.post(
  '/active-url',
  describeRoute({ summary: 'Record the active tab URL into the timeline', tags: ['ingest'], responses: { 200: jres('Acknowledged', AckResponse) } }),
  validator('json', ActiveUrlBody),
  (c) => {
    const b = c.req.valid('json');
    pushUrl({ ts: b.ts ?? Date.now(), url: b.url, tabId: b.tabId ?? null, title: b.title ?? null });
    return c.json({ ok: true, timelineSize: urlTimeline.length });
  }
);

app.post(
  '/screenshot',
  describeRoute({ summary: 'Store a screenshot of the active tab', tags: ['ingest'], responses: { 200: jres('Acknowledged', AckResponse), 400: jres('Could not store the screenshot') } }),
  validator('json', ScreenshotBody),
  (c) => {
    const b = c.req.valid('json');
    try {
      const entry = saveScreenshot({ ts: b.ts ?? Date.now(), url: b.url ?? null, tabId: b.tabId ?? null, dataUrl: b.dataUrl });
      return c.json({ ok: true, path: entry.path, count: screenshotCount() });
    } catch (err) {
      return c.json({ ok: false, error: (err as Error).message }, 400);
    }
  }
);

app.post(
  '/focus',
  describeRoute({ summary: 'Record the browser-window focus state', tags: ['ingest'], responses: { 200: jres('Acknowledged', AckResponse) } }),
  validator('json', FocusBody),
  (c) => {
    const b = c.req.valid('json');
    const focused = !!b.focused;
    focusTimeline.push({ ts: b.ts ?? Date.now(), focused });
    prune(focusTimeline);
    return c.json({ ok: true, focused });
  }
);

app.post(
  '/config',
  describeRoute({ summary: 'Sync routing rules and gate settings from the extension', tags: ['config'], responses: { 200: jres('The merged active config', AckResponse) } }),
  validator('json', ConfigBody),
  (c) => {
    const b = c.req.valid('json');
    // Partial merge: only overwrite keys that were actually provided.
    if (b.requireBrowserFocus !== undefined) config.requireBrowserFocus = b.requireBrowserFocus;
    if (b.attachScreenshot !== undefined) config.attachScreenshot = b.attachScreenshot;
    if (b.routes !== undefined) config.routes = b.routes;
    return c.json({ ok: true, config });
  }
);

app.post(
  '/recording',
  describeRoute({ summary: 'Mark a voice-recording bracket (start / finish / abort)', tags: ['ingest'], responses: { 200: jres('Acknowledged', AckResponse) } }),
  validator('json', RecordingBody),
  (c) => {
    const b = c.req.valid('json');
    const ts = b.ts ?? Date.now();
    if (b.phase === 'start') {
      pendingBracket = { tStartMs: ts, tFinishMs: null, startUrl: b.url ?? null, startTitle: b.title ?? null, tabId: b.tabId ?? null };
      log(`recording START url=${b.url ?? '(none)'}`);
    } else if (b.phase === 'finish') {
      if (pendingBracket) pendingBracket.tFinishMs = ts;
      log('recording FINISH (awaiting transcript)');
      scheduleNudge();
    } else {
      pendingBracket = null;
      log('recording ABORT');
    }
    return c.json({ ok: true, phase: b.phase });
  }
);

app.post(
  '/match',
  describeRoute({ summary: 'Test transcript matching for a given recording window', tags: ['debug'], responses: { 200: jres('The best-matching transcript, or null') } }),
  validator('json', MatchBody),
  (c) => {
    const b = c.req.valid('json');
    const { transcripts } = readHistory();
    const m = matchTranscriptByWindow({ transcripts, seenIds: null, tStartMs: b.tStartMs, tFinishMs: b.tFinishMs });
    if (!m) return c.json({ match: null });
    return c.json({
      match: {
        id: m.transcript.id,
        textPreview: m.transcript.text.slice(0, 80),
        durationSec: m.transcript.durationSec,
        score: m.score,
        temporalErrSec: m.temporalErrSec,
        durErrSec: m.durErrSec,
        confidence: m.confidence,
        accepted: m.accepted,
        candidateCount: m.candidateCount,
      },
    });
  }
);

app.post(
  '/route-test',
  describeRoute({ summary: 'Exercise routing without real voice (dry-run by default)', tags: ['debug'], responses: { 200: jres('The delivery result') } }),
  validator('json', RouteTestBody),
  async (c) => {
    const b = c.req.valid('json');
    const dryRun = b.dryRun !== false; // default true
    const result = await deliverToHerdr(b.url, b.text ?? '[voice-router test]', { dryRun, submit: b.submit === true });
    return c.json({ ok: true, dryRun, result });
  }
);

app.post(
  '/send',
  describeRoute({ summary: 'Deliver the latest screenshot to the pane matching a URL', tags: ['deliver'], responses: { 200: jres('Delivery result', AckResponse) } }),
  validator('json', SendBody),
  async (c) => {
    // Deliver the latest screenshot to the pane matching `url`, no voice needed (the
    // extension's Send button captures the annotated frame, then calls this). Independent
    // of the requireBrowserFocus gate — it's an explicit user action.
    const b = c.req.valid('json');
    const shot = selectScreenshot(Date.now());
    if (!shot) return c.json({ ok: false, reason: 'no-screenshot' });
    const text = `Screenshot of my current browser tab (read this image file): ${shot.path}`;
    const delivery = await deliverToHerdr(b.url, text, { submit: true });
    lastMatch = { at: Date.now(), source: 'send-button', url: b.url, screenshot: shot.path, textPreview: '[screenshot sent]', delivery };
    log(`SEND [button] -> ${b.url} (${delivery.status})`);
    log(`   attached screenshot ${shot.path}`);
    return c.json({ ok: true, screenshot: shot.path, delivery });
  }
);

// The OpenAPI 3.1 document, assembled from the describeRoute/validator metadata above.
app.get(
  '/openapi',
  openAPIRouteHandler(app, {
    documentation: {
      openapi: '3.1.0',
      info: {
        title: 'Voice Router daemon',
        version: cfg.VERSION,
        description: 'Local daemon that routes Hex voice transcripts to herdr panes based on the active browser tab.',
      },
      servers: [{ url: `http://${cfg.HOST}:${cfg.PORT}`, description: 'local daemon' }],
    },
  })
);

app.notFound((c) => c.json({ ok: false, error: 'not found' }, 404));
app.onError((err, c) => c.json({ ok: false, error: (err as Error).message }, 500));

// ---- boot ----
try {
  scanForNewTranscripts({ seedOnly: true }); // don't route pre-existing history on startup
  watchHistory();
} catch (err) {
  log('boot warning:', (err as Error).message);
}

const server = serve({ fetch: app.fetch, hostname: cfg.HOST, port: cfg.PORT }, () => {
  log(`voicerouter ${cfg.VERSION} listening on http://${cfg.HOST}:${cfg.PORT}`);
  log(`hex history: ${cfg.HEX_HISTORY_PATH}`);
});

// Surface listen failures (e.g. EADDRINUSE) instead of zombie-ing alive-but-not-listening;
// exiting lets launchd's KeepAlive respawn cleanly.
server.on('error', (err) => {
  log('FATAL server error:', (err as Error).message);
  process.exit(1);
});
