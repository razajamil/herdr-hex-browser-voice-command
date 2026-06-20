// voicerouter daemon
// ------------------
// - Streams active-tab URLs + window focus from the extension into timelines.
// - Watches Hex's transcription_history.json; on a NEW transcript, picks the URL active
//   during its recording window and delivers it to the herdr pane named by a routing rule.
// - Routing rules + the focus-gate setting are synced from the extension via POST /config.

import http from 'http';
import fs from 'fs';
import path from 'path';
import { cfg } from './config';
import { readHistory } from './hex';
import type { Transcript } from './hex';
import { selectUrlForTranscript, matchTranscriptByWindow } from './matcher';
import type { UrlEntry } from './matcher';
import { matchRoute, resolveTarget, deliver } from './herdr';
import { ConfigSchema, type Route } from '../../shared/config-schema';

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
const config: { requireBrowserFocus: boolean; routes: Route[] } = {
  requireBrowserFocus: false,
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

function send(res: http.ServerResponse, status: number, obj: unknown): void {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(JSON.stringify(obj));
}

function readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch {
        resolve({});
      }
    });
  });
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

  match.delivery = await deliverToHerdr(url, transcript.text, { submit: true });
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
  const { route: rule, key } = matched;
  if (!key) {
    log(`   skip: route "${rule.name}" pattern has no {capture} for the workspace key`);
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

// ---- HTTP server ----
const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') return send(res, 204, {});
  const u = new URL(req.url || '/', `http://${cfg.HOST}:${cfg.PORT}`);
  const key = `${req.method} ${u.pathname}`;

  try {
    if (key === 'GET /health') {
      const hist = readHistory();
      return send(res, 200, {
        ok: true,
        service: 'voicerouter',
        version: cfg.VERSION,
        uptimeSec: Math.round((Date.now() - startedAt) / 1000),
        hexHistoryPath: cfg.HEX_HISTORY_PATH,
        hexHistoryReadable: hist.ok,
        transcriptCount: hist.transcripts.length,
        timelineSize: urlTimeline.length,
        currentUrl: urlTimeline.length ? urlTimeline[urlTimeline.length - 1].url : null,
        browserFocused: focusTimeline.length ? focusTimeline[focusTimeline.length - 1].focused : null,
        config,
        pendingBracket: !!pendingBracket,
        lastMatch,
        lastError,
      });
    }

    if (key === 'GET /') {
      return send(res, 200, {
        service: 'voicerouter',
        version: cfg.VERSION,
        endpoints: ['GET /health', 'POST /active-url', 'POST /focus', 'POST /config', 'POST /recording', 'POST /match', 'POST /route-test', 'GET /transcripts/latest'],
      });
    }

    if (key === 'GET /transcripts/latest') {
      const n = Math.min(20, Number(u.searchParams.get('n') || 5));
      const { transcripts } = readHistory();
      return send(res, 200, {
        transcripts: transcripts.slice(0, n).map((t) => ({
          id: t.id,
          durationSec: t.durationSec,
          endUnixMs: t.endUnixMs,
          sourceAppName: t.sourceAppName,
          textPreview: t.text.slice(0, 80),
        })),
      });
    }

    if (key === 'POST /active-url') {
      const b = await readBody(req);
      if (typeof b.url !== 'string') return send(res, 400, { ok: false, error: 'url required' });
      pushUrl({
        ts: Number(b.ts) || Date.now(),
        url: b.url,
        tabId: typeof b.tabId === 'number' ? b.tabId : null,
        title: typeof b.title === 'string' ? b.title : null,
      });
      return send(res, 200, { ok: true, timelineSize: urlTimeline.length });
    }

    if (key === 'POST /focus') {
      const b = await readBody(req);
      focusTimeline.push({ ts: Number(b.ts) || Date.now(), focused: !!b.focused });
      prune(focusTimeline);
      return send(res, 200, { ok: true, focused: !!b.focused });
    }

    if (key === 'POST /config') {
      const parsed = ConfigSchema.safeParse(await readBody(req));
      if (!parsed.success) {
        return send(res, 400, { ok: false, error: 'invalid config', issues: parsed.error.issues });
      }
      // Partial merge: only overwrite keys that were actually provided.
      if (parsed.data.requireBrowserFocus !== undefined) config.requireBrowserFocus = parsed.data.requireBrowserFocus;
      if (parsed.data.routes !== undefined) config.routes = parsed.data.routes;
      return send(res, 200, { ok: true, config });
    }

    if (key === 'POST /recording') {
      const b = await readBody(req);
      const ts = Number(b.ts) || Date.now();
      if (b.phase === 'start') {
        pendingBracket = {
          tStartMs: ts,
          tFinishMs: null,
          startUrl: typeof b.url === 'string' ? b.url : null,
          startTitle: typeof b.title === 'string' ? b.title : null,
          tabId: typeof b.tabId === 'number' ? b.tabId : null,
        };
        log(`recording START url=${typeof b.url === 'string' ? b.url : '(none)'}`);
      } else if (b.phase === 'finish') {
        if (pendingBracket) pendingBracket.tFinishMs = ts;
        log('recording FINISH (awaiting transcript)');
        scheduleNudge();
      } else if (b.phase === 'abort') {
        pendingBracket = null;
        log('recording ABORT');
      }
      return send(res, 200, { ok: true, phase: b.phase });
    }

    if (key === 'POST /match') {
      const b = await readBody(req);
      const { transcripts } = readHistory();
      const m = matchTranscriptByWindow({
        transcripts,
        seenIds: null,
        tStartMs: Number(b.tStartMs),
        tFinishMs: Number(b.tFinishMs),
      });
      if (!m) return send(res, 200, { match: null });
      return send(res, 200, {
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

    if (key === 'POST /route-test') {
      // End-to-end test without real voice. Defaults safe (dry-run, no submit).
      const b = await readBody(req);
      if (typeof b.url !== 'string') return send(res, 400, { ok: false, error: 'url required' });
      const dryRun = b.dryRun !== false; // default true
      const result = await deliverToHerdr(b.url, typeof b.text === 'string' ? b.text : '[voice-router test]', {
        dryRun,
        submit: b.submit === true,
      });
      return send(res, 200, { ok: true, dryRun, result });
    }

    return send(res, 404, { ok: false, error: 'not found' });
  } catch (err) {
    return send(res, 500, { ok: false, error: (err as Error).message });
  }
});

// ---- boot ----
try {
  scanForNewTranscripts({ seedOnly: true }); // don't route pre-existing history on startup
  watchHistory();
} catch (err) {
  log('boot warning:', (err as Error).message);
}

// Surface listen failures (e.g. EADDRINUSE) instead of zombie-ing alive-but-not-listening;
// exiting lets launchd's KeepAlive respawn cleanly.
server.on('error', (err) => {
  log('FATAL server error:', (err as Error).message);
  process.exit(1);
});

server.listen(cfg.PORT, cfg.HOST, () => {
  log(`voicerouter ${cfg.VERSION} listening on http://${cfg.HOST}:${cfg.PORT}`);
  log(`hex history: ${cfg.HEX_HISTORY_PATH}`);
});
