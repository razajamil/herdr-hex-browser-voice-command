// Optional page-screenshot store.
//
// The extension POSTs the active tab's screenshot (a base64 data URL) as it switches
// tabs. We can't paste an image into a terminal pane, so instead we write each shot to a
// FILE on disk and keep a small time-indexed timeline of PATHS (not pixels — memory stays
// tiny). When a transcript routes, the daemon picks the shot active at recording-start and
// references its path in the delivered prompt; Claude Code reads the image file by path.

import fs from 'fs';
import path from 'path';
import { cfg } from './config';

export interface ShotEntry {
  ts: number; // Unix ms — when the page was captured (recording-relevant)
  url: string | null;
  tabId: number | null;
  path: string; // absolute file path on disk
}

const timeline: ShotEntry[] = [];
let counter = 0;
let lastSavedAt = 0; // ts of the most recent shot received (survives buffer pruning)

function ensureDir(): void {
  fs.mkdirSync(cfg.SCREENSHOT_DIR, { recursive: true });
}

// Drop entries past the cap or TTL, deleting their files so the dir doesn't grow unbounded.
function prune(): void {
  const cutoff = Date.now() - cfg.SCREENSHOT_TTL_MS;
  while (timeline.length > cfg.SCREENSHOT_MAX || (timeline.length && timeline[0].ts < cutoff)) {
    const old = timeline.shift()!;
    fs.rm(old.path, { force: true }, () => {});
  }
}

// Persist a "data:image/jpeg;base64,…" URL to disk and record it in the timeline.
export function saveScreenshot(params: {
  ts: number;
  url: string | null;
  tabId: number | null;
  dataUrl: string;
}): ShotEntry {
  const m = /^data:image\/(png|jpeg|webp);base64,(.+)$/s.exec(params.dataUrl);
  if (!m) throw new Error('unsupported data URL (want data:image/{png,jpeg,webp};base64,…)');
  const ext = m[1] === 'jpeg' ? 'jpg' : m[1];
  ensureDir();
  const file = path.join(cfg.SCREENSHOT_DIR, `${params.ts}-${counter++}.${ext}`);
  fs.writeFileSync(file, Buffer.from(m[2], 'base64'));
  const entry: ShotEntry = { ts: params.ts, url: params.url, tabId: params.tabId, path: file };
  timeline.push(entry);
  lastSavedAt = entry.ts;
  prune();
  return entry;
}

// The screenshot that was the "current page" at a moment (last shot at/before the anchor;
// else the earliest we still have). Returns null if the best candidate is too stale to be
// plausibly the page the user was looking at when they spoke.
export function selectScreenshot(anchorMs: number): ShotEntry | null {
  let active: ShotEntry | null = null;
  for (const e of timeline) {
    if (e.ts <= anchorMs) active = e;
    else break;
  }
  const chosen = active ?? timeline[0] ?? null;
  if (!chosen) return null;
  if (Math.abs(chosen.ts - anchorMs) > cfg.SCREENSHOT_MAX_AGE_MS) return null;
  return chosen;
}

export function screenshotCount(): number {
  return timeline.length;
}

export function lastScreenshotAt(): number | null {
  return lastSavedAt || null;
}
