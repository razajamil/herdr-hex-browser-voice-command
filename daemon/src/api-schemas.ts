// Zod schemas for the daemon's HTTP surface. These do double duty: hono-openapi's
// `validator` enforces them on the request (giving handlers a typed `c.req.valid(...)`)
// AND feeds them into the generated OpenAPI document — one source for both.

import { z } from 'zod';
import { ConfigSchema, RouteSchema } from '../../shared/config-schema';

// ---- request bodies ----
export const ActiveUrlBody = z.object({
  url: z.string(),
  ts: z.number().optional(),
  tabId: z.number().nullish(),
  title: z.string().nullish(),
});

export const ScreenshotBody = z.object({
  dataUrl: z.string(),
  ts: z.number().optional(),
  url: z.string().nullish(),
  tabId: z.number().nullish(),
});

export const FocusBody = z.object({
  focused: z.boolean().optional(),
  ts: z.number().optional(),
});

// /config syncs the shared config; reuse the single source of truth.
export const ConfigBody = ConfigSchema;

export const RecordingBody = z.object({
  phase: z.enum(['start', 'finish', 'abort']),
  ts: z.number().optional(),
  url: z.string().nullish(),
  title: z.string().nullish(),
  tabId: z.number().nullish(),
});

export const MatchBody = z.object({
  tStartMs: z.coerce.number(),
  tFinishMs: z.coerce.number(),
});

export const RouteTestBody = z.object({
  url: z.string(),
  text: z.string().optional(),
  dryRun: z.boolean().optional(),
  submit: z.boolean().optional(),
});

export const SendBody = z.object({
  url: z.string(),
});

// ---- query strings ----
export const LatestQuery = z.object({
  n: z.coerce.number().int().min(1).max(20).optional(),
});

// ---- responses (documented in the spec; not enforced at runtime) ----
export const HealthResponse = z.object({
  ok: z.boolean(),
  service: z.string(),
  version: z.string(),
  uptimeSec: z.number(),
  hexHistoryPath: z.string(),
  hexHistoryReadable: z.boolean(),
  transcriptCount: z.number(),
  timelineSize: z.number(),
  screenshotCount: z.number(),
  lastScreenshotAt: z.number().nullable(),
  currentUrl: z.string().nullable(),
  browserFocused: z.boolean().nullable(),
  config: z.object({
    requireBrowserFocus: z.boolean(),
    attachScreenshot: z.boolean(),
    routes: z.array(RouteSchema),
  }),
  pendingBracket: z.boolean(),
  lastMatch: z.record(z.string(), z.unknown()).nullable(),
  lastError: z.string().nullable(),
});

// Most write endpoints just acknowledge with `{ ok, ... }`; `.loose()` keeps the per-route
// extras (timelineSize, path, delivery, …) without enumerating each one.
export const AckResponse = z.object({ ok: z.boolean() }).loose();
