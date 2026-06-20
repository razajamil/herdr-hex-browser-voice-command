'use strict';

const os = require('os');
const path = require('path');

const HOME = os.homedir();

// Hex is sandboxed; its history lives in the app container, NOT ~/Library/Application Support.
const DEFAULT_HEX_HISTORY = path.join(
  HOME,
  'Library/Containers/com.kitlangton.Hex/Data/Library/Application Support/com.kitlangton.Hex/transcription_history.json'
);

module.exports = {
  VERSION: '0.1.0',
  HOST: '127.0.0.1',
  PORT: Number(process.env.VOICEROUTER_PORT || 8137),

  // Path to Hex's transcript store (override with VOICEROUTER_HEX_HISTORY).
  HEX_HISTORY_PATH: process.env.VOICEROUTER_HEX_HISTORY || DEFAULT_HEX_HISTORY,

  // Cocoa/Apple reference date (2001-01-01) → Unix epoch, in seconds.
  // Hex encodes Date as seconds since this epoch (default JSONEncoder .deferredToDate).
  APPLE_EPOCH_OFFSET_SEC: 978307200,

  // Hex stamps a transcript's `timestamp` AFTER transcription finishes, so it lands a
  // little later than the audio actually stopped. Subtract this to estimate the true
  // recording-end time. Pin it with one timed recording; 0 is a safe starting point.
  TRANSCRIPTION_LATENCY_MS: Number(process.env.VOICEROUTER_LATENCY_MS || 0),

  // URL-timeline retention (the extension streams active-tab URLs here).
  TIMELINE_MAX: 500,
  TIMELINE_TTL_MS: 60 * 60 * 1000,

  // Which point of a transcript's recording window we attribute a URL to.
  // 'start' = the tab focused when you began speaking (your stated intent).
  URL_ANCHOR: 'start', // 'start' | 'mid' | 'end'

  // How close (ms) an explicit recording bracket from the extension must be to a
  // freshly-written transcript for us to trust the bracket's start-URL.
  BRACKET_MATCH_TOLERANCE_MS: 8000,

  // Debounce for the transcript-file watcher.
  WATCH_DEBOUNCE_MS: 200,

  // ---- herdr routing ----
  // Path to the herdr binary. launchd's PATH won't include ~/.local/bin, so the
  // installer also passes the absolute path via VOICEROUTER_HERDR_BIN.
  HERDR_BIN: process.env.VOICEROUTER_HERDR_BIN || 'herdr',
  HERDR_TIMEOUT_MS: 8000,

  // Routing rules (URL pattern → tab/pane) are configured in the Chrome extension and
  // pushed via POST /config (see daemon/server.js `config.routes`). These are only
  // fallbacks: used when a rule omits a tab/pane name.
  DEFAULT_TAB: 'main',
  DEFAULT_PANE: 'agent',
};
