#!/usr/bin/env bash
set -euo pipefail

LABEL="com.razajamil.voicerouter"
UID_NUM="$(id -u)"
PLIST_DEST="$HOME/Library/LaunchAgents/$LABEL.plist"

launchctl bootout "gui/$UID_NUM/$LABEL" 2>/dev/null || true
rm -f "$PLIST_DEST"

echo "✓ daemon stopped, LaunchAgent removed ($PLIST_DEST)"
echo "  Remove the extension manually from chrome://extensions if you no longer want it."
