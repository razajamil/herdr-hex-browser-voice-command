import { z } from 'zod';

// Single source of truth for the config that flows between the extension and the daemon.
// Fields are optional (NOT .default()) so the daemon can keep its partial-merge semantics
// and the extension/daemon defaults can differ at their call sites.

export const RouteSchema = z.object({
  name: z.string(),
  urlPattern: z.string(),
  tabName: z.string(),
  paneName: z.string(),
});

export const ConfigSchema = z.object({
  requireBrowserFocus: z.boolean().optional(),
  routes: z.array(RouteSchema).optional(),
});

export type Route = z.infer<typeof RouteSchema>;
export type Config = z.infer<typeof ConfigSchema>;
