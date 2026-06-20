# Voice Router

Routes [Hex](https://github.com/kitlangton/Hex) voice transcripts to the right Claude Code
pane (running inside [herdr](https://github.com/) ) based on the browser tab you were looking
at when you spoke — so you don't have to manually focus the correct pane first.

## How it works

```
Chrome extension ──HTTP──▶ local daemon ──watches──▶ Hex transcription_history.json
  (reports active                │
   tab URL over time)            └── maps payroll URL → herdr workspace → tab `main` → pane `agent`, delivers transcript
```

## Routing rule

A recording is delivered **only** if the tab it's attributed to is a payroll local dev
server inside a worktree:

```
http://rwr-<number>-<short-description>.payroll.localhost/...
        └──────────── worktree key ────────────┘
```

The daemon then finds the herdr **workspace** whose label / worktree folder matches that
key (tolerant of a `fix-`/`feat-` prefix, e.g. URL `rwr-1234-heardroom` →
workspace `fix-rwr-1234-heardroom`), locates its tab labelled **`main`** and the pane
labelled **`agent`**, and types the transcript there + Enter. Any other URL is ignored.
Target tab/pane names are in `daemon/config.js` (`HERDR_TAB`, `HERDR_PANE`).

The extension can't read files or run CLIs (sandbox), so a small **local daemon** does the
real work. The daemon **watches Hex's transcript file**; when a new transcript appears it
attributes it to whichever browser URL was active during the recording's time window
(the extension streams those URLs to it). No fragile global-hotkey capture required.

- **Hex store** (live-verified, sandboxed app container):
  `~/Library/Containers/com.kitlangton.Hex/Data/Library/Application Support/com.kitlangton.Hex/transcription_history.json`
- **Timestamps** are Apple-epoch seconds (since 2001-01-01); the daemon converts with `+978307200`.
- **Matching** keys on duration agreement (offset-invariant) + temporal proximity; see `daemon/matcher.js`.

## Layout

```
extension/        Chrome MV3 extension (load unpacked)
  manifest.json   tabs + alarms perms, host_permission for 127.0.0.1:8137
  background.js   streams active-tab URL, health-checks daemon, sets badge
  content.js      OPTIONAL: detects ⌘-double-tap (start) / Escape (abort) as hints
  popup.html/js   status panel
daemon/           Node HTTP service (zero npm deps)
  server.js       endpoints + transcript watcher + routing stub
  hex.js          reads/normalizes Hex history
  matcher.js      URL-for-transcript + explicit-window matchers
  config.js       port, paths, tunables
  test-match.js   validates the matcher against your real history
install.sh        sets daemon up as a launchd LaunchAgent
uninstall.sh
```

## Install

```bash
./install.sh
```

Then load the extension once: `chrome://extensions` → Developer mode → **Load unpacked** →
select `extension/`.

The daemon auto-starts at login and respawns on crash. The extension's toolbar badge shows a
red `!` if it can't reach the daemon.

## Endpoints (daemon)

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | status, transcript count, last routed match |
| POST | `/active-url` | `{url, tabId, title, ts}` — timeline of active tabs |
| POST | `/recording` | `{phase: start\|finish\|abort, ...}` — optional gesture hints |
| POST | `/match` | `{tStartMs, tFinishMs}` — debug: best transcript for a window |
| GET | `/transcripts/latest?n=5` | debug peek at recent transcripts |

## Settings (extension popup)

Toggles live in the popup and are mirrored to the daemon as config:

- **Only route when this browser window is focused** (default **on**) — skips routing if
  Chrome wasn't frontmost when the recording started. Turn off to route even when Chrome
  is in the background. Enforced in the daemon via a focus timeline the extension streams
  to `POST /focus`; the setting itself syncs via `POST /config`.

## Tuning / calibration

- `VOICEROUTER_LATENCY_MS` — Hex stamps a transcript slightly after audio stops. If routing
  attributes to a tab you'd just switched away from, do one timed recording and set this to
  the observed offset (start at 0).
- `URL_ANCHOR` in `config.js` — `start` (default) / `mid` / `end` of the recording window.

## Status

✅ Hex storage reverse-engineered · ✅ daemon + matcher (validated on live data) · ✅ extension
· ✅ herdr routing (URL gate → workspace/`main`/`agent` → delivery, verified end-to-end via `/route-test`)
· ⏳ **next:** live run with the extension loaded + a real Hex recording.
