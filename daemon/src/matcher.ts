// Pure, testable matching logic.

import { cfg } from './config';
import type { Transcript } from './hex';

export interface UrlEntry {
  ts: number; // Unix ms
  url: string;
  tabId: number | null;
  title: string | null;
}

export interface UrlSelection {
  entry: UrlEntry | null;
  reason: string;
  anchorMs: number | null;
}

// Pick the URL-timeline entry active during a transcript's recording window.
export function selectUrlForTranscript(
  transcript: Transcript,
  timeline: UrlEntry[],
  opts: { anchor?: 'start' | 'mid' | 'end' } = {}
): UrlSelection {
  if (!timeline || timeline.length === 0) {
    return { entry: null, reason: 'empty-timeline', anchorMs: null };
  }
  const anchorMode = opts.anchor || cfg.URL_ANCHOR;
  const start = transcript.startUnixMs ?? 0;
  const end = transcript.endUnixMs ?? 0;
  let anchorMs: number;
  if (anchorMode === 'end') anchorMs = end;
  else if (anchorMode === 'mid') anchorMs = start + (end - start) / 2;
  else anchorMs = start;

  let active: UrlEntry | null = null;
  for (const e of timeline) {
    if (e.ts <= anchorMs) active = e;
    else break;
  }
  if (active) return { entry: active, reason: `active-at-${anchorMode}`, anchorMs };
  return { entry: timeline[0], reason: 'anchor-before-timeline', anchorMs };
}

export interface WindowMatch {
  transcript: Transcript;
  temporalErrSec: number;
  durErrSec: number;
  score: number;
  confidence: number;
  accepted: boolean;
  candidateCount: number;
  windowLenSec: number;
}

// Explicit-window matcher (Approach A hint / debug). duration agreement is the
// offset-invariant signal; temporal proximity disambiguates.
export function matchTranscriptByWindow(params: {
  transcripts: Transcript[];
  seenIds: Set<string> | null;
  tStartMs: number;
  tFinishMs: number;
}): WindowMatch | null {
  const { transcripts, seenIds, tStartMs, tFinishMs } = params;
  const windowLenSec = (tFinishMs - tStartMs) / 1000;
  const candidates = seenIds ? transcripts.filter((t) => !seenIds.has(t.id)) : transcripts.slice();
  if (candidates.length === 0) return null;

  const scored = candidates.map((t) => {
    const temporalErrSec = Math.abs((t.endUnixMs ?? 0) - tFinishMs) / 1000;
    const durErrSec = Math.abs(t.durationSec - windowLenSec);
    const score = temporalErrSec + 2 * durErrSec; // weight duration; it's the robust signal
    return { transcript: t, temporalErrSec, durErrSec, score };
  });
  scored.sort((a, b) => a.score - b.score);
  const best = scored[0];
  const accepted = candidates.length === 1 || best.durErrSec <= 4 || best.temporalErrSec <= 8;
  const confidence = Math.max(0, Math.min(1, 1 / (1 + best.score)));
  return { ...best, confidence, accepted, candidateCount: candidates.length, windowLenSec };
}
