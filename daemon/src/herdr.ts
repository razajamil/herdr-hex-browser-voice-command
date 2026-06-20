// Thin wrapper over the herdr CLI (talks to the running herdr over its unix socket).
// Works from outside herdr (no HERDR_ENV needed) because every call targets explicit ids.

import { execFile } from 'child_process';
import path from 'path';
import { cfg } from './config';
import type { Route } from '../../shared/config-schema';

interface HerdrWorktree {
  checkout_path?: string;
  repo_name?: string;
}
interface HerdrWorkspace {
  workspace_id: string;
  label?: string;
  worktree?: HerdrWorktree;
}
interface HerdrTab {
  tab_id: string;
  label?: string;
  workspace_id: string;
}
interface HerdrPane {
  pane_id: string;
  label?: string | null;
  workspace_id: string;
  tab_id: string;
}

function run(args: string[], opts: { json?: boolean } = {}): Promise<unknown> {
  const wantJson = opts.json !== false;
  return new Promise((resolve, reject) => {
    execFile(
      cfg.HERDR_BIN,
      args,
      { timeout: cfg.HERDR_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          const tail = stderr ? ` :: ${String(stderr).trim()}` : '';
          return reject(new Error(`herdr ${args.slice(0, 2).join(' ')}: ${err.message}${tail}`));
        }
        if (!wantJson) return resolve(String(stdout));
        try {
          resolve(JSON.parse(stdout));
        } catch (e) {
          reject(new Error(`herdr ${args.slice(0, 2).join(' ')}: bad JSON (${(e as Error).message})`));
        }
      }
    );
  });
}

async function workspaceList(): Promise<HerdrWorkspace[]> {
  const out = (await run(['workspace', 'list'])) as { result?: { workspaces?: HerdrWorkspace[] } };
  return out.result?.workspaces ?? [];
}
async function tabList(workspaceId: string): Promise<HerdrTab[]> {
  const out = (await run(['tab', 'list', '--workspace', workspaceId])) as { result?: { tabs?: HerdrTab[] } };
  return out.result?.tabs ?? [];
}
async function paneList(): Promise<HerdrPane[]> {
  const out = (await run(['pane', 'list'])) as { result?: { panes?: HerdrPane[] } };
  return out.result?.panes ?? [];
}

// ---- URL pattern matching ----
// `*` matches anything; `{name}` captures one dot/slash-free segment; the FIRST capture is
// the herdr workspace key. e.g. "http://{workspace}.payroll.localhost/*" on
// "http://rwr-1234-heardroom.payroll.localhost/v2" captures "rwr-1234-heardroom".
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function compilePattern(pattern: string): RegExp {
  let out = '^';
  const token = /\{[A-Za-z0-9_]+\}|\*/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = token.exec(pattern)) !== null) {
    out += escapeRegex(pattern.slice(last, m.index));
    out += m[0] === '*' ? '.*' : '([^/.]+)';
    last = m.index + m[0].length;
  }
  out += escapeRegex(pattern.slice(last));
  // No trailing wildcard → only continue past a path/port/query boundary, so "…localhost"
  // can't match "…localhostevil.com".
  if (!pattern.endsWith('*')) out += '(?:[/:?#].*)?$';
  return new RegExp(out, 'i');
}

export function matchRoute(
  url: string | null | undefined,
  routes: Route[] | undefined
): { route: Route; key: string } | null {
  if (!url || !Array.isArray(routes)) return null;
  for (const route of routes) {
    if (!route || !route.urlPattern) continue;
    let regex: RegExp;
    try {
      regex = compilePattern(route.urlPattern);
    } catch {
      continue; // skip a malformed pattern rather than crash routing
    }
    const m = regex.exec(url);
    if (!m) continue;
    return { route, key: (m[1] || '').toLowerCase() };
  }
  return null;
}

// ---- workspace / tab / pane resolution ----
function workspaceNames(ws: HerdrWorkspace): string[] {
  const names: string[] = [];
  if (ws.label) names.push(ws.label);
  if (ws.worktree?.checkout_path) names.push(path.basename(ws.worktree.checkout_path));
  return names.map((n) => n.toLowerCase());
}

// 0 = exact, 1 = prefixed worktree (fix-rwr-… ), 2 = loose substring, -1 = no match.
function matchTier(name: string, key: string): number {
  if (name === key) return 0;
  if (name.endsWith('-' + key)) return 1;
  if (name.includes(key)) return 2;
  return -1;
}

function pickWorkspace(
  workspaces: HerdrWorkspace[],
  key: string
): { ws: HerdrWorkspace; tier: number; name: string } | null {
  let best: { ws: HerdrWorkspace; tier: number; name: string } | null = null;
  for (const ws of workspaces) {
    for (const name of workspaceNames(ws)) {
      const tier = matchTier(name, key);
      if (tier < 0) continue;
      if (!best || tier < best.tier) best = { ws, tier, name };
    }
  }
  return best;
}

export type ResolveResult =
  | { ok: false; reason: string; key: string; workspaceLabel?: string; tab?: string; want?: string }
  | {
      ok: true;
      key: string;
      matchTier: number;
      matchedName: string;
      workspaceId: string;
      workspaceLabel?: string;
      tabId: string;
      tabName: string;
      paneId: string;
      paneName: string;
    };

export async function resolveTarget(key: string, tabName?: string, paneName?: string): Promise<ResolveResult> {
  const wantTab = tabName || cfg.DEFAULT_TAB;
  const wantPane = paneName || cfg.DEFAULT_PANE;

  const workspaces = await workspaceList();
  const hit = pickWorkspace(workspaces, key);
  if (!hit) return { ok: false, reason: 'no-workspace', key };
  const ws = hit.ws;

  const tabs = await tabList(ws.workspace_id);
  const tab = tabs.find((t) => t.label === wantTab);
  if (!tab) return { ok: false, reason: 'no-tab', key, workspaceLabel: ws.label, want: wantTab };

  const panes = await paneList();
  const pane = panes.find(
    (p) => p.workspace_id === ws.workspace_id && p.tab_id === tab.tab_id && p.label === wantPane
  );
  if (!pane) return { ok: false, reason: 'no-pane', key, workspaceLabel: ws.label, tab: tab.label, want: wantPane };

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
export async function deliver(
  paneId: string,
  text: string,
  opts: { submit?: boolean } = {}
): Promise<{ submitted: boolean; chars: number }> {
  const submit = opts.submit !== false;
  // Collapse newlines so the agent gets ONE submission (Enter submits in these TUIs).
  const oneLine = String(text).replace(/\r?\n+/g, ' ').trim();
  await run(['pane', 'send-text', paneId, oneLine], { json: false });
  if (submit) await run(['pane', 'send-keys', paneId, 'Enter'], { json: false });
  return { submitted: submit, chars: oneLine.length };
}
