'use strict';

// Reads and normalizes Hex's transcription_history.json.
//
// Live-verified schema (per entry):
//   id                : UUID string
//   timestamp         : number  (Apple-epoch seconds — NOT Unix)
//   text              : string
//   duration          : number  (seconds)
//   audioPath         : string  ("file:///…/Recordings/<unix>.wav")  ← bare string in practice
//   sourceAppName     : string? (optional)
//   sourceAppBundleID : string? (optional)

const fs = require('fs');
const cfg = require('./config');

function decodeAudioPath(v) {
  if (typeof v === 'string') return v;
  // Defensive: Foundation's default URL encoding would be { relative, base }.
  if (v && typeof v === 'object') return v.relative || v.base || null;
  return null;
}

function normalize(t) {
  const appleTs = typeof t.timestamp === 'number' ? t.timestamp : null;
  const durationSec = typeof t.duration === 'number' ? t.duration : 0;
  let endUnixMs = null;
  let startUnixMs = null;
  if (appleTs != null) {
    endUnixMs = (appleTs + cfg.APPLE_EPOCH_OFFSET_SEC) * 1000 - cfg.TRANSCRIPTION_LATENCY_MS;
    startUnixMs = endUnixMs - durationSec * 1000;
  }
  return {
    id: t.id,
    text: typeof t.text === 'string' ? t.text : '',
    durationSec,
    appleTimestamp: appleTs,
    endUnixMs, // estimated recording-end, Unix ms
    startUnixMs, // estimated recording-start, Unix ms
    sourceAppName: t.sourceAppName || null,
    sourceAppBundleID: t.sourceAppBundleID || null,
    audioPath: decodeAudioPath(t.audioPath),
  };
}

function readHistory(p = cfg.HEX_HISTORY_PATH) {
  let raw;
  try {
    raw = fs.readFileSync(p, 'utf8');
  } catch (err) {
    return { ok: false, error: `read failed: ${err.code || err.message}`, transcripts: [] };
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch (_err) {
    // Hex writes atomically (temp + rename); a read during the window can still
    // occasionally yield malformed JSON. Caller treats this as transient.
    return { ok: false, error: 'parse failed (possibly mid-write)', transcripts: [] };
  }
  const arr = Array.isArray(data.history) ? data.history : [];
  const transcripts = arr
    .map(normalize)
    .filter((t) => t.id && t.appleTimestamp != null)
    .sort((a, b) => b.appleTimestamp - a.appleTimestamp); // newest first
  return { ok: true, error: null, transcripts };
}

module.exports = { readHistory, normalize };
