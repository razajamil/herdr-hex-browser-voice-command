// Reads and normalizes Hex's transcription_history.json.
//
// Live-verified per-entry schema: id (UUID), timestamp (Apple-epoch seconds), text,
// duration (seconds), audioPath (bare "file://…" string), sourceAppName?, sourceAppBundleID?.

import fs from 'fs';
import { cfg } from './config';

export interface Transcript {
  id: string;
  text: string;
  durationSec: number;
  appleTimestamp: number | null;
  endUnixMs: number | null; // estimated recording-end, Unix ms
  startUnixMs: number | null; // estimated recording-start, Unix ms
  sourceAppName: string | null;
  sourceAppBundleID: string | null;
  audioPath: string | null;
}

export interface ReadResult {
  ok: boolean;
  error: string | null;
  transcripts: Transcript[];
}

function decodeAudioPath(v: unknown): string | null {
  if (typeof v === 'string') return v;
  // Defensive: Foundation's default URL encoding would be { relative, base }.
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return (typeof o.relative === 'string' && o.relative) || (typeof o.base === 'string' && o.base) || null;
  }
  return null;
}

function normalize(t: Record<string, unknown>): Transcript {
  const appleTs = typeof t.timestamp === 'number' ? t.timestamp : null;
  const durationSec = typeof t.duration === 'number' ? t.duration : 0;
  let endUnixMs: number | null = null;
  let startUnixMs: number | null = null;
  if (appleTs != null) {
    endUnixMs = (appleTs + cfg.APPLE_EPOCH_OFFSET_SEC) * 1000 - cfg.TRANSCRIPTION_LATENCY_MS;
    startUnixMs = endUnixMs - durationSec * 1000;
  }
  return {
    id: typeof t.id === 'string' ? t.id : '',
    text: typeof t.text === 'string' ? t.text : '',
    durationSec,
    appleTimestamp: appleTs,
    endUnixMs,
    startUnixMs,
    sourceAppName: typeof t.sourceAppName === 'string' ? t.sourceAppName : null,
    sourceAppBundleID: typeof t.sourceAppBundleID === 'string' ? t.sourceAppBundleID : null,
    audioPath: decodeAudioPath(t.audioPath),
  };
}

export function readHistory(p: string = cfg.HEX_HISTORY_PATH): ReadResult {
  let raw: string;
  try {
    raw = fs.readFileSync(p, 'utf8');
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    return { ok: false, error: `read failed: ${e.code || e.message}`, transcripts: [] };
  }
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    // Hex writes atomically (temp + rename); a read mid-window can still yield malformed JSON.
    return { ok: false, error: 'parse failed (possibly mid-write)', transcripts: [] };
  }
  const arr =
    data && typeof data === 'object' && Array.isArray((data as { history?: unknown }).history)
      ? ((data as { history: unknown[] }).history as Record<string, unknown>[])
      : [];
  const transcripts = arr
    .map(normalize)
    .filter((t) => t.id && t.appleTimestamp != null)
    .sort((a, b) => (b.appleTimestamp as number) - (a.appleTimestamp as number)); // newest first
  return { ok: true, error: null, transcripts };
}
