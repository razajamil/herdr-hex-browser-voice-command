import os from 'os';
import path from 'path';

const HOME = os.homedir();

// Hex is sandboxed; its history lives in the app container, NOT ~/Library/Application Support.
const DEFAULT_HEX_HISTORY = path.join(
  HOME,
  'Library/Containers/com.kitlangton.Hex/Data/Library/Application Support/com.kitlangton.Hex/transcription_history.json'
);

export const cfg = {
  VERSION: '0.1.0',
  HOST: '127.0.0.1',
  PORT: Number(process.env.VOICEROUTER_PORT || 8137),

  // Path to Hex's transcript store (override with VOICEROUTER_HEX_HISTORY).
  HEX_HISTORY_PATH: process.env.VOICEROUTER_HEX_HISTORY || DEFAULT_HEX_HISTORY,

  // Cocoa/Apple reference date (2001-01-01) → Unix epoch, in seconds.
  APPLE_EPOCH_OFFSET_SEC: 978307200,

  // Hex stamps a transcript's `timestamp` AFTER transcription, so it lands a little later
  // than the audio stopped. Subtract this to estimate true recording-end. Calibrate; 0 is safe.
  TRANSCRIPTION_LATENCY_MS: Number(process.env.VOICEROUTER_LATENCY_MS || 0),

  // URL-timeline retention.
  TIMELINE_MAX: 500,
  TIMELINE_TTL_MS: 60 * 60 * 1000,

  // Which point of a recording's window we attribute a URL to.
  URL_ANCHOR: 'start' as 'start' | 'mid' | 'end',

  // How close (ms) an explicit recording bracket must be to a transcript to trust its start-URL.
  BRACKET_MATCH_TOLERANCE_MS: 8000,

  // Debounce for the transcript-file watcher.
  WATCH_DEBOUNCE_MS: 200,

  // ---- herdr routing ----
  // launchd's PATH won't include ~/.local/bin, so the installer also passes the absolute
  // path via VOICEROUTER_HERDR_BIN.
  HERDR_BIN: process.env.VOICEROUTER_HERDR_BIN || 'herdr',
  HERDR_TIMEOUT_MS: 8000,

  // Fallbacks used only when a route omits a tab/pane name (routes come from the extension).
  DEFAULT_TAB: 'main',
  DEFAULT_PANE: 'agent',

  // ---- optional page screenshots ----
  // Where the active-tab screenshots posted by the extension are written. Claude Code
  // reads these by path, so they must live somewhere the agent process can read.
  SCREENSHOT_DIR: process.env.VOICEROUTER_SCREENSHOT_DIR || path.join(os.tmpdir(), 'voicerouter-screenshots'),
  // Ring-buffer retention for screenshots (kept small; each is a file on disk).
  SCREENSHOT_MAX: 12,
  SCREENSHOT_TTL_MS: 5 * 60 * 1000,
  // Don't attach a shot whose capture time is further than this from the recording start —
  // it almost certainly wasn't the page the user was looking at when they spoke.
  SCREENSHOT_MAX_AGE_MS: 10 * 60 * 1000,
};
