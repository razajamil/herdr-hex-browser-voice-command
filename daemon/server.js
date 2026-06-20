'use strict';

// voicerouter daemon
// ------------------
// - Streams active-tab URLs from the extension into a timeline (POST /active-url).
// - Watches Hex's transcription_history.json; when a NEW transcript appears, picks the
//   URL that was active during its recording window and "routes" it (Approach B).
// - Accepts optional recording brackets (POST /recording) from the extension's key
//   detection to sharpen URL attribution.
// - herdr delivery is stubbed in route() — that's the next milestone.

const http = require('http');
const fs = require('fs');
const path = require('path');
const cfg = require('./config');
const { readHistory } = require('./hex');
const { selectUrlForTranscript, matchTranscriptByWindow } = require('./matcher');
const { matchRoute, resolveTarget, deliver } = require('./herdr');

const startedAt = Date.now();

// ---- state ----
const urlTimeline = []; // { ts, url, tabId, title }
const focusTimeline = []; // { ts, focused }  — is any Chrome window frontmost
const seenIds = new Set();
let lastMatch = null;
let lastError = null;
let pendingBracket = null; // { tStartMs, tFinishMs, startUrl, startTitle, tabId }

// Settings synced from the extension (extension is the source of truth). Defaults are
// permissive so behavior is unchanged if no extension has connected yet.
const config = {
  requireBrowserFocus: false, // only route if Chrome was focused at recording time
  // Routing rules, owned by the extension and pushed via /config. This default keeps the
  // daemon working before the extension syncs. {workspace} captures the herdr workspace key.
  routes: [
    { name: 'Payroll dev', urlPattern: 'http://{workspace}.payroll.localhost/*', tabName: 'main', paneName: 'agent' },
  ],
};

// ---- helpers ----
function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

function prune(arr) {
  const cutoff = Date.now() - cfg.TIMELINE_TTL_MS;
  while (arr.length > cfg.TIMELINE_MAX || (arr.length && arr[0].ts < cutoff)) arr.shift();
}

function pushUrl(entry) {
  urlTimeline.push(entry);
  prune(urlTimeline);
}

// Focus state as of a given moment = the last focus event at/before it.
// Returns true | false | null (unknown — no focus data yet).
function wasFocusedAt(ms) {
  let state = null;
  for (const e of focusTimeline) {
    if (e.ts <= ms) state = e.focused;
    else break;
  }
  return state;
}

function send(res, status, obj) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch { resolve({}); }
    });
  });
}

// ---- routing ----
async function route(transcript, urlEntry, meta) {
  const url = urlEntry ? urlEntry.url : null;
  lastMatch = {
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
  log(`MATCH [${meta.source}] ${transcript.id} -> ${url || '(no url)'} (${meta.reason})`);
  log(`   "${transcript.text.slice(0, 80)}${transcript.text.length > 80 ? '…' : ''}"`);

  // Focus gate: only route if Chrome was focused when the recording started.
  if (config.requireBrowserFocus) {
    const focused = wasFocusedAt(transcript.startUnixMs);
    if (focused === false) {
      log('   skip: browser window not focused at recording time (requireBrowserFocus)');
      lastMatch.delivery = { status: 'skipped', reason: 'browser-not-focused' };
      return;
    }
    if (focused === null) log('   note: focus state unknown at recording time; routing anyway');
  }

  lastMatch.delivery = await deliverToHerdr(url, transcript.text, { submit: true });
}

// Gate on the payroll dev URL, resolve the herdr pane, deliver the text. Shared by the
// watcher (real routing) and the /route-test endpoint (safe manual testing).
async function deliverToHerdr(url, text, { submit = true, dryRun = false } = {}) {
  const match = matchRoute(url, config.routes);
  if (!match) {
    log(`   skip: no route matches ${url || 'no url'}`);
    return { status: 'skipped', reason: 'no-matching-route', url };
  }
  const { route, key } = match;
  if (!key) {
    log(`   skip: route "${route.name}" pattern has no {capture} for the workspace key`);
    return { status: 'skipped', reason: 'no-workspace-key', route: route.name };
  }
  try {
    const target = await resolveTarget(key, route.tabName, route.paneName);
    if (!target.ok) {
      log(`   skip: route "${route.name}" → no target for "${key}" (${target.reason})`);
      return { status: 'unresolved', route: route.name, ...target };
    }
    if (dryRun) {
      log(`   dry-run: route "${route.name}" → ${target.workspaceLabel} ${target.paneId} (${target.tabName}/${target.paneName})`);
      return { status: 'resolved', route: route.name, ...target };
    }
    const d = await deliver(target.paneId, text, { submit });
    log(`   delivered via "${route.name}" to ${target.workspaceLabel} ${target.paneId}${submit ? ' + Enter' : ' (no submit)'}`);
    return { status: 'delivered', route: route.name, ...target, ...d };
  } catch (err) {
    log(`   delivery error for "${key}": ${err.message}`);
    return { status: 'error', key, error: err.message };
  }
}

// ---- transcript watcher (the primary signal) ----
function handleNewTranscript(t) {
  // Prefer an explicit recording bracket from the extension if it lines up in time.
  if (pendingBracket && pendingBracket.tFinishMs != null && t.endUnixMs != null) {
    const near = Math.abs(t.endUnixMs - pendingBracket.tFinishMs) <= cfg.BRACKET_MATCH_TOLERANCE_MS;
    if (near) {
      const entry = pendingBracket.startUrl
        ? {
            ts: pendingBracket.tStartMs,
            url: pendingBracket.startUrl,
            title: pendingBracket.startTitle,
            tabId: pendingBracket.tabId,
          }
        : selectUrlForTranscript(t, urlTimeline).entry;
      route(t, entry, { reason: 'explicit-bracket', source: 'watcher+bracket' }).catch((e) => log('route error:', e.message));
      pendingBracket = null;
      return;
    }
  }
  const sel = selectUrlForTranscript(t, urlTimeline);
  route(t, sel.entry, { reason: sel.reason, source: 'watcher' }).catch((e) => log('route error:', e.message));
}

function scanForNewTranscripts({ seedOnly = false } = {}) {
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
    if (!seedOnly) handleNewTranscript(t);
  }
  if (seedOnly) log(`seeded ${seenIds.size} existing transcript id(s)`);
}

function watchHistory() {
  const file = cfg.HEX_HISTORY_PATH;
  const dir = path.dirname(file);
  const base = path.basename(file);
  let timer = null;
  const onChange = () => {
    clearTimeout(timer);
    timer = setTimeout(() => scanForNewTranscripts(), cfg.WATCH_DEBOUNCE_MS);
  };
  // Watch the directory, not the file: Hex writes atomically (temp + rename), which
  // breaks a watch bound to the original inode.
  try {
    fs.watch(dir, (_evt, fname) => {
      if (!fname || fname === base) onChange();
    });
    log(`watching ${file}`);
  } catch (err) {
    log(`fs.watch failed (${err.message}); polling every 1s instead`);
    setInterval(() => scanForNewTranscripts(), 1000);
  }
}

// After a "finish", poll briefly in case fs.watch is slow / Hex throttles its write.
function scheduleNudge() {
  let n = 0;
  const iv = setInterval(() => {
    scanForNewTranscripts();
    if (++n >= 30) clearInterval(iv); // ~30 * 150ms ≈ 4.5s
  }, 150);
}

// ---- HTTP server ----
const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') return send(res, 204, {});
  const u = new URL(req.url, `http://${cfg.HOST}:${cfg.PORT}`);
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
      if (!b.url) return send(res, 400, { ok: false, error: 'url required' });
      pushUrl({ ts: Number(b.ts) || Date.now(), url: b.url, tabId: b.tabId ?? null, title: b.title || null });
      return send(res, 200, { ok: true, timelineSize: urlTimeline.length });
    }

    if (key === 'POST /focus') {
      const b = await readBody(req);
      focusTimeline.push({ ts: Number(b.ts) || Date.now(), focused: !!b.focused });
      prune(focusTimeline);
      return send(res, 200, { ok: true, focused: !!b.focused });
    }

    if (key === 'POST /config') {
      // Partial merge — extension pushes whatever settings it owns.
      const b = await readBody(req);
      if (typeof b.requireBrowserFocus === 'boolean') config.requireBrowserFocus = b.requireBrowserFocus;
      if (Array.isArray(b.routes)) config.routes = b.routes;
      return send(res, 200, { ok: true, config });
    }

    if (key === 'POST /recording') {
      const b = await readBody(req);
      const ts = Number(b.ts) || Date.now();
      if (b.phase === 'start') {
        pendingBracket = { tStartMs: ts, tFinishMs: null, startUrl: b.url || null, startTitle: b.title || null, tabId: b.tabId ?? null };
        log(`recording START url=${b.url || '(none)'}`);
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
      // Debug: explicit-window match against ALL transcripts (ignores seenIds).
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
      // End-to-end test without needing real voice. Defaults are SAFE: dry-run resolves
      // the target but sends nothing. Pass {"submit":true} to actually type+Enter, or
      // {"dryRun":false,"submit":false} to type into the pane without submitting.
      const b = await readBody(req);
      if (!b.url) return send(res, 400, { ok: false, error: 'url required' });
      const dryRun = b.dryRun !== false; // default true
      const result = await deliverToHerdr(b.url, b.text || '[voice-router test]', {
        dryRun,
        submit: b.submit === true,
      });
      return send(res, 200, { ok: true, dryRun, result });
    }

    return send(res, 404, { ok: false, error: 'not found' });
  } catch (err) {
    return send(res, 500, { ok: false, error: err.message });
  }
});

// ---- boot ----
scanForNewTranscripts({ seedOnly: true }); // don't route pre-existing history on startup
watchHistory();
server.listen(cfg.PORT, cfg.HOST, () => {
  log(`voicerouter ${cfg.VERSION} listening on http://${cfg.HOST}:${cfg.PORT}`);
  log(`hex history: ${cfg.HEX_HISTORY_PATH}`);
});
