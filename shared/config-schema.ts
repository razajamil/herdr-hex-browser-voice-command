import { z } from 'zod';

// Single source of truth for the config that flows between the extension and the daemon.
// Fields are optional (NOT .default()) so the daemon can keep its partial-merge semantics
// and the extension/daemon defaults can differ at their call sites.

export const RouteSchema = z.object({
  name: z.string(),
  urlPattern: z.string(),
  tabName: z.string(),
  paneName: z.string(),
  // Optional fixed herdr workspace key. Used when the URL carries no {workspace} to capture
  // (e.g. a "master" dev-server URL with no per-worktree subdomain). When set, it pins the
  // target workspace; otherwise the workspace key comes from the URL pattern's first capture.
  workspaceKey: z.string().optional(),
});

export const ConfigSchema = z.object({
  requireBrowserFocus: z.boolean().optional(),
  // When on, the extension streams the active tab's screenshot and the daemon references
  // its file path in the delivered prompt so the agent can read the page.
  attachScreenshot: z.boolean().optional(),
  routes: z.array(RouteSchema).optional(),
});

export type Route = z.infer<typeof RouteSchema>;
export type Config = z.infer<typeof ConfigSchema>;
