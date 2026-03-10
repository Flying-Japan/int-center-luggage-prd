#!/bin/bash
# Watchdog: checks if luggage.flyingjp.com is reachable, restarts containers if not.
# Install via cron: */3 * * * * ~/projects/Flying-Japan/int-center-luggage-prd/플라잉센터자동화/scripts/watchdog.sh >> /tmp/flying-japan-watchdog.log 2>&1
set -uo pipefail

COMPOSE_DIR="$HOME/projects/Flying-Japan/int-center-luggage-prd/플라잉센터자동화"
HEALTH_URL="https://luggage.flyingjp.com/health"
LOCK="/tmp/flying-japan-watchdog.lock"
MAX_RETRIES=2

# Prevent concurrent runs (same pattern as deploy.sh)
if ! mkdir "$LOCK" 2>/dev/null; then
  if [ -d "$LOCK" ]; then
    lock_age=$(( $(date +%s) - $(stat -f %m "$LOCK") ))
    if [ "$lock_age" -gt 300 ]; then
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

reachable=false
for i in $(seq 1 $MAX_RETRIES); do
  if curl -sf --max-time 10 "$HEALTH_URL" > /dev/null 2>&1; then
    reachable=true
    break
  fi
  sleep 5
done

if [ "$reachable" = true ]; then
  exit 0
fi

echo "$(date): Site unreachable after $MAX_RETRIES attempts, restarting containers..."

cd "$COMPOSE_DIR"
docker compose -p flying-japan restart tunnel || true
sleep 10

# Check again after tunnel restart
if curl -sf --max-time 10 "$HEALTH_URL" > /dev/null 2>&1; then
  echo "$(date): Tunnel restart fixed the issue."
  exit 0
fi

# If tunnel restart didn't help, restart everything
echo "$(date): Tunnel restart insufficient, restarting all services..."
docker compose -p flying-japan up -d --force-recreate
echo "$(date): Full restart complete."
