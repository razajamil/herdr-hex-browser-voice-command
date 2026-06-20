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

// http://rwr-1234-heardroom.payroll.localhost/v2 -> "rwr-1234-heardroom"
function payrollKeyFromUrl(rawUrl) {
  if (!rawUrl) return null;
  const m = cfg.PAYROLL_URL_RE.exec(rawUrl);
  return m ? m[1].toLowerCase() : null;
}

// Names a workspace can be matched by: its label and its worktree folder name.
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

// key -> { ok, paneId, ... } by walking workspace -> tab(main) -> pane(agent).
async function resolveTarget(key) {
  const wl = await run(['workspace', 'list']);
  const workspaces = (wl.result && wl.result.workspaces) || [];
  const hit = pickWorkspace(workspaces, key);
  if (!hit) return { ok: false, reason: 'no-workspace', key };
  const ws = hit.ws;

  const tl = await run(['tab', 'list', '--workspace', ws.workspace_id]);
  const tabs = (tl.result && tl.result.tabs) || [];
  const tab = tabs.find((t) => t.label === cfg.HERDR_TAB);
  if (!tab) return { ok: false, reason: 'no-tab', key, workspaceLabel: ws.label, want: cfg.HERDR_TAB };

  const pl = await run(['pane', 'list']);
  const panes = (pl.result && pl.result.panes) || [];
  const pane = panes.find(
    (p) => p.workspace_id === ws.workspace_id && p.tab_id === tab.tab_id && p.label === cfg.HERDR_PANE
  );
  if (!pane) {
    return { ok: false, reason: 'no-pane', key, workspaceLabel: ws.label, tab: tab.label, want: cfg.HERDR_PANE };
  }

  return {
    ok: true,
    key,
    matchTier: hit.tier,
    matchedName: hit.name,
    workspaceId: ws.workspace_id,
    workspaceLabel: ws.label,
    tabId: tab.tab_id,
    paneId: pane.pane_id,
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

module.exports = { run, payrollKeyFromUrl, pickWorkspace, resolveTarget, deliver };
