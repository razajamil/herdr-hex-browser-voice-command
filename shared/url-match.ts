// Pure URL-pattern matching, shared by the daemon (routing) and the extension (popup, to
// show which rule applies to the current tab). No node/browser deps so it bundles for both.
//
// `*` matches anything; `{name}` captures one dot/slash-free segment; the FIRST capture is
// the herdr workspace key. e.g. "http://{workspace}.payroll.localhost/*" on
// "http://rwr-1234-heardroom.payroll.localhost/v2" captures "rwr-1234-heardroom".

import type { Route } from './config-schema';

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
