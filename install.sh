#!/usr/bin/env bash
set -euo pipefail

# Installs the voicerouter daemon as a launchd LaunchAgent (auto-starts at login,
# respawns on crash) and prints how to load the Chrome extension.

LABEL="com.razajamil.voicerouter"
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DAEMON_DIR="$REPO_DIR/daemon"
SERVER_JS="$DAEMON_DIR/dist/server.js"
TEMPLATE="$DAEMON_DIR/$LABEL.plist.template"
PLIST_DEST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG_DIR="$HOME/Library/Logs"
LOG_OUT="$LOG_DIR/voicerouter.log"
LOG_ERR="$LOG_DIR/voicerouter.err.log"
PORT="${VOICEROUTER_PORT:-8137}"
UID_NUM="$(id -u)"

echo "→ voice-router installer"

# 1. Locate node (launchd won't have your interactive PATH, so we bake the absolute path).
NODE_BIN="$(command -v node || true)"
if [ -z "$NODE_BIN" ]; then
  echo "✗ node not found on PATH. Install Node 18+ and retry." >&2
  exit 1
fi
echo "  node:    $NODE_BIN ($("$NODE_BIN" --version))"
echo "  server:  $SERVER_JS"

# 2. PATH for the agent: ~/.local/bin (herdr) + node's dir + Homebrew + system.
NODE_DIR="$(dirname "$NODE_BIN")"
AGENT_PATH="$HOME/.local/bin:$NODE_DIR:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

# Absolute path to herdr too, so the daemon works even if PATH resolution differs.
HERDR_BIN_PATH="$(command -v herdr || echo herdr)"
echo "  herdr:   $HERDR_BIN_PATH"

# 2b. Install deps + build TypeScript (daemon/dist + extension/dist). Must succeed before
#     launchd points at dist/server.js.
echo "  building (npm install + npm run build)…"
( cd "$REPO_DIR" && npm install && npm run build ) || { echo "✗ build failed — see output above" >&2; exit 1; }

# 3. Render the plist.
mkdir -p "$LOG_DIR" "$(dirname "$PLIST_DEST")"
sed -e "s|__LABEL__|$LABEL|g" \
    -e "s|__NODE__|$NODE_BIN|g" \
    -e "s|__SERVER_JS__|$SERVER_JS|g" \
    -e "s|__WORKDIR__|$DAEMON_DIR|g" \
    -e "s|__PATH__|$AGENT_PATH|g" \
    -e "s|__HERDR_BIN__|$HERDR_BIN_PATH|g" \
    -e "s|__LOG_OUT__|$LOG_OUT|g" \
    -e "s|__LOG_ERR__|$LOG_ERR|g" \
    "$TEMPLATE" > "$PLIST_DEST"
echo "  plist:   $PLIST_DEST"

# 4. (Re)load via launchd.
launchctl bootout "gui/$UID_NUM/$LABEL" 2>/dev/null || true
# bootstrap + RunAtLoad starts it. Avoid `kickstart -k` here: kill+respawn trips launchd's
# ~10s restart throttle and the health-wait below would false-alarm.
launchctl bootstrap "gui/$UID_NUM" "$PLIST_DEST"
launchctl enable "gui/$UID_NUM/$LABEL"
echo "  launchd: loaded + started"

# 5. Wait for the daemon to answer.
printf "  waiting for daemon"
for i in $(seq 1 40); do
  if curl -fsS "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then
    echo " — up!"
    break
  fi
  printf "."
  sleep 0.5
  if [ "$i" -eq 40 ]; then
    echo
    echo "✗ daemon did not become healthy. Check: $LOG_ERR" >&2
    exit 1
  fi
done

cat <<EOF

✓ Daemon installed and running (auto-starts at login).

Next — load the extension (one time):
  1. Open  chrome://extensions
  2. Enable "Developer mode" (top-right)
  3. "Load unpacked" → select:
       $REPO_DIR/extension

Health:  curl -s http://127.0.0.1:$PORT/health
Logs:    $LOG_OUT
         $LOG_ERR
Restart: launchctl kickstart -k gui/$UID_NUM/$LABEL
Remove:  $REPO_DIR/uninstall.sh
EOF
