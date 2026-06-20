'use strict';

// Pure, testable matching logic. Two responsibilities:
//   1. selectUrlForTranscript — given a transcript Hex just wrote, pick which browser
//      URL was active during its recording window (Approach B, the primary path).
//   2. matchTranscriptByWindow — given an explicit [start, finish] window measured by
//      the extension, pick the best transcript (Approach A hint / debugging).

const cfg = require('./config');

// timeline: [{ ts (Unix ms), url, tabId, title }], chronologically ascending.
function selectUrlForTranscript(transcript, timeline, opts = {}) {
  if (!timeline || timeline.length === 0) {
    return { entry: null, reason: 'empty-timeline', anchorMs: null };
  }
  const anchorMode = opts.anchor || cfg.URL_ANCHOR;
  let anchorMs;
  if (anchorMode === 'end') anchorMs = transcript.endUnixMs;
  else if (anchorMode === 'mid') {
    anchorMs = transcript.startUnixMs + (transcript.endUnixMs - transcript.startUnixMs) / 2;
  } else anchorMs = transcript.startUnixMs; // 'start'

  // URL active AT the anchor = the last update whose ts <= anchor.
  let active = null;
  for (const e of timeline) {
    if (e.ts <= anchorMs) active = e;
    else break;
  }
  if (active) return { entry: active, reason: `active-at-${anchorMode}`, anchorMs };

  // The recording predates everything we know → fall back to the earliest URL.
  return { entry: timeline[0], reason: 'anchor-before-timeline', anchorMs };
}

// duration agreement is the offset-invariant signal (independent of whether Hex's
// timestamp marks the start or end of recording); temporal proximity disambiguates.
function matchTranscriptByWindow({ transcripts, seenIds, tStartMs, tFinishMs }) {
  const windowLenSec = (tFinishMs - tStartMs) / 1000;
  const candidates = seenIds
    ? transcripts.filter((t) => !seenIds.has(t.id))
    : transcripts.slice();
  if (candidates.length === 0) return null;

  const scored = candidates.map((t) => {
    const temporalErrSec = Math.abs(t.endUnixMs - tFinishMs) / 1000;
    const durErrSec = Math.abs(t.durationSec - windowLenSec);
    const score = temporalErrSec + 2 * durErrSec; // weight duration; it's the robust signal
    return { transcript: t, temporalErrSec, durErrSec, score };
  });
  scored.sort((a, b) => a.score - b.score);
  const best = scored[0];

  const accepted =
    candidates.length === 1 || best.durErrSec <= 4 || best.temporalErrSec <= 8;
  const confidence = Math.max(0, Math.min(1, 1 / (1 + best.score)));

  return { ...best, confidence, accepted, candidateCount: candidates.length, windowLenSec };
}

module.exports = { selectUrlForTranscript, matchTranscriptByWindow };
