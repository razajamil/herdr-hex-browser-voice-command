'use strict';

// Thin wrapper over the herdr CLI (talks to the running herdr over its unix socket).
// Works from outside herdr (no HERDR_ENV needed) because every call targets explicit
// ids, never "the focused pane".

const { execFile } = require('child_process');
const path = require('path');
const cfg = require('./config');

function run(args, { json = true } = {}) {
  return new Promise((resolve, reject) => {
    execFile(cfg.HERDR_BIN, args, { timeout: cfg.HERDR_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const tail = stderr ? ` :: ${String(stderr).trim()}` : '';
        return reject(new Error(`herdr ${args.slice(0, 2).join(' ')}: ${err.message}${tail}`));
      }
      if (!json) return resolve(String(stdout));
      try {
        resolve(JSON.parse(stdout));
      } catch (e) {
        reject(new Error(`herdr ${args.slice(0, 2).join(' ')}: bad JSON (${e.message})`));
      }
    });
  });
}

// ---- URL pattern matching ----
// Patterns (authored in the extension) use two tokens:
//   *        wildcard — matches anything
//   {name}   capture — matches one dot/slash-free segment; the FIRST capture is the
//            herdr workspace key.
// e.g. "http://{workspace}.payroll.localhost/*" applied to
//      "http://rwr-1234-heardroom.payroll.localhost/v2" captures "rwr-1234-heardroom".
function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function compilePattern(pattern) {
  let out = '^';
  const token = /\{[A-Za-z0-9_]+\}|\*/g;
  let last = 0;
  let m;
  while ((m = token.exec(pattern))) {
    out += escapeRegex(pattern.slice(last, m.index));
    out += m[0] === '*' ? '.*' : '([^/.]+)';
    last = m.index + m[0].length;
  }
  out += escapeRegex(pattern.slice(last));
  // If the pattern doesn't end in a wildcard, only allow the URL to continue past a
  // path/port/query boundary — so "…localhost" can't match "…localhostevil.com".
  if (!pattern.endsWith('*')) out += '(?:[/:?#].*)?$';
  return new RegExp(out, 'i');
}

// First route whose urlPattern matches `url`. Returns { route, key } or null.
function matchRoute(url, routes) {
  if (!url || !Array.isArray(routes)) return null;
  for (const route of routes) {
    if (!route || !route.urlPattern) continue;
    let regex;
    try {
      regex = compilePattern(route.urlPattern);
    } catch (_e) {
      continue; // skip a malformed pattern rather than crash routing
    }
    const m = regex.exec(url);
    if (!m) continue;
    return { route, key: (m[1] || '').toLowerCase() };
  }
  return null;
}

// ---- workspace / tab / pane resolution ----
function workspaceNames(ws) {
  const names = [];
  if (ws.label) names.push(ws.label);
  if (ws.worktree && ws.worktree.checkout_path) names.push(path.basename(ws.worktree.checkout_path));
  return names.map((n) => String(n).toLowerCase());
}

// 0 = exact, 1 = prefixed worktree (fix-rwr-… ), 2 = loose substring, -1 = no match.
function matchTier(name, key) {
  if (name === key) return 0;
  if (name.endsWith('-' + key)) return 1;
  if (name.includes(key)) return 2;
  return -1;
}

function pickWorkspace(workspaces, key) {
  let best = null;
  for (const ws of workspaces) {
    for (const name of workspaceNames(ws)) {
      const tier = matchTier(name, key);
      if (tier < 0) continue;
      if (!best || tier < best.tier) best = { ws, tier, name };
    }
  }
  return best; // { ws, tier, name } | null
}

// key + target labels -> { ok, paneId, ... }.
async function resolveTarget(key, tabName, paneName) {
  const wantTab = tabName || cfg.DEFAULT_TAB;
  const wantPane = paneName || cfg.DEFAULT_PANE;

  const wl = await run(['workspace', 'list']);
  const workspaces = (wl.result && wl.result.workspaces) || [];
  const hit = pickWorkspace(workspaces, key);
  if (!hit) return { ok: false, reason: 'no-workspace', key };
  const ws = hit.ws;

  const tl = await run(['tab', 'list', '--workspace', ws.workspace_id]);
  const tabs = (tl.result && tl.result.tabs) || [];
  const tab = tabs.find((t) => t.label === wantTab);
  if (!tab) return { ok: false, reason: 'no-tab', key, workspaceLabel: ws.label, want: wantTab };

  const pl = await run(['pane', 'list']);
  const panes = (pl.result && pl.result.panes) || [];
  const pane = panes.find(
    (p) => p.workspace_id === ws.workspace_id && p.tab_id === tab.tab_id && p.label === wantPane
  );
  if (!pane) {
    return { ok: false, reason: 'no-pane', key, workspaceLabel: ws.label, tab: tab.label, want: wantPane };
  }

  return {
    ok: true,
    key,
    matchTier: hit.tier,
    matchedName: hit.name,
    workspaceId: ws.workspace_id,
    workspaceLabel: ws.label,
    tabId: tab.tab_id,
    tabName: wantTab,
    paneId: pane.pane_id,
    paneName: wantPane,
  };
}

// Type the transcript into a pane and (optionally) submit with Enter.
async function deliver(paneId, text, { submit = true } = {}) {
  // Collapse newlines so the agent gets ONE submission (Enter submits in these TUIs; a
  // stray embedded newline would fragment or prematurely send the message).
  const oneLine = String(text).replace(/\r?\n+/g, ' ').trim();
  await run(['pane', 'send-text', paneId, oneLine], { json: false });
  if (submit) await run(['pane', 'send-keys', paneId, 'Enter'], { json: false });
  return { submitted: submit, chars: oneLine.length };
}

module.exports = { run, compilePattern, matchRoute, pickWorkspace, resolveTarget, deliver };
