#!/bin/bash
# Auto-deploy: pull latest code from git, rebuild if changed.
# Runs via cron every 5 minutes as a backup to CI/CD.
set -euo pipefail

DEPLOY_DIR="$HOME/projects/Flying-Japan/int-center-luggage-prd"
COMPOSE_DIR="$DEPLOY_DIR/플라잉센터자동화"
LOCK="/tmp/flying-japan-deploy.lock"

# Prevent concurrent runs (macOS-compatible: mkdir is atomic)
if ! mkdir "$LOCK" 2>/dev/null; then
  # Check if lock is stale (older than 10 minutes)
  if [ -d "$LOCK" ]; then
    lock_age=$(( $(date +%s) - $(stat -f %m "$LOCK") ))
    if [ "$lock_age" -gt 600 ]; then
      rm -rf "$LOCK"
      mkdir "$LOCK" 2>/dev/null || exit 0
    else
      exit 0
    fi
  else
    exit 0
  fi
fi
trap 'rm -rf "$LOCK"' EXIT

cd "$DEPLOY_DIR"

# Fetch latest
git fetch origin main --quiet

LOCAL=$(git rev-parse HEAD)
REMOTE=$(git rev-parse origin/main)

if [ "$LOCAL" = "$REMOTE" ]; then
  exit 0
fi

echo "$(date): New commits detected, deploying..."

git pull origin main --quiet

cd "$COMPOSE_DIR"
docker compose -p flying-japan build app
docker compose -p flying-japan up -d

echo "$(date): Deploy complete ($(git rev-parse --short HEAD))"
