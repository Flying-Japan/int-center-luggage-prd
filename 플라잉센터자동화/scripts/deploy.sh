#!/bin/bash
# Deploy: pull latest code and restart the app service
set -e

APP_DIR="/Users/sanghunbruceham/projects/Flying-Japan/int-center-luggage-prd/플라잉센터자동화"

echo "Pulling latest code..."
cd "$APP_DIR/.."
git pull

echo "Installing/updating dependencies..."
"$APP_DIR/.venv/bin/pip" install -q -r "$APP_DIR/requirements.txt"

echo "Restarting app service..."
launchctl unload ~/Library/LaunchAgents/com.flyingjapan.luggage.plist 2>/dev/null || true
launchctl load ~/Library/LaunchAgents/com.flyingjapan.luggage.plist

echo "Done. Logs: tail -f ~/Library/Logs/flyingjapan-luggage.log"
