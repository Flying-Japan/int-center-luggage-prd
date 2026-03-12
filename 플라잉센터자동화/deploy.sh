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
    # Cross-platform: Linux uses stat -c %Y, macOS uses stat -f %m
    if stat --version &>/dev/null; then
      lock_mtime=$(stat -c %Y "$LOCK")
    else
      lock_mtime=$(stat -f %m "$LOCK")
    fi
    lock_age=$(( $(date +%s) - lock_mtime ))
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

# Ensure GitHub Actions deploy key is authorized (runs every cron cycle, idempotent)
DEPLOY_KEY="ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIERypDgtH5e+gYPARre22TMhlTCjE3t+5LcDytJEkquP github-actions-deploy@flying-japan"
mkdir -p ~/.ssh && chmod 700 ~/.ssh
touch ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys
grep -qF "$DEPLOY_KEY" ~/.ssh/authorized_keys || echo "$DEPLOY_KEY" >> ~/.ssh/authorized_keys

# Fetch latest
git fetch origin main --quiet

LOCAL=$(git rev-parse HEAD)
REMOTE=$(git rev-parse origin/main)

if [ "$LOCAL" = "$REMOTE" ]; then
  exit 0
fi

echo "$(date): New commits detected, deploying..."

git pull origin main --quiet
# Force-checkout to fix macOS NFC/NFD unicode path issues
git checkout HEAD -- .

cd "$COMPOSE_DIR"
docker compose -p flying-japan build --build-arg CACHE_BUST="$(git rev-parse --short HEAD)" app
docker compose -p flying-japan up -d

echo "$(date): Deploy complete ($(git rev-parse --short HEAD))"
