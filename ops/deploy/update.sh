#!/usr/bin/env bash
set -Eeuo pipefail

readonly ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
readonly HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:8080}"
readonly HEALTH_ATTEMPTS="${HEALTH_ATTEMPTS:-5}"
readonly HEALTH_DELAY_SECONDS="${HEALTH_DELAY_SECONDS:-5}"

log() { printf '\n[%s] %s\n' "$(date -u +'%Y-%m-%dT%H:%M:%SZ')" "$*"; }
fail() {
  log "Deployment failed. Recent service logs:"
  docker compose logs --tail=120 migrate api gateway || true
  exit 1
}
trap fail ERR

cd "$ROOT_DIR"

if [[ ! -f .env ]]; then
  printf 'Missing %s/.env. Copy .env.example and set secrets first.\n' "$ROOT_DIR" >&2
  exit 2
fi
if ! git diff --quiet || ! git diff --cached --quiet; then
  printf 'Working tree has tracked local changes. Commit or discard them before update.\n' >&2
  exit 3
fi

log "Updating source"
git pull --ff-only origin main

log "Checking Compose configuration"
docker compose config -q

log "Pruning only stale Docker cache and dangling images (older than 7 days); volumes are preserved"
docker builder prune --force --filter 'until=168h'
docker image prune --force --filter 'until=168h'

log "Building and starting services; migrations run before API"
docker compose up -d --build --remove-orphans
docker compose ps

for attempt in $(seq 1 "$HEALTH_ATTEMPTS"); do
  log "Health check $attempt/$HEALTH_ATTEMPTS"
  if curl --fail --silent --show-error "$HEALTH_URL/health/live" && \
     curl --fail --silent --show-error "$HEALTH_URL/health/ready"; then
    log "Deployment completed successfully"
    exit 0
  fi
  if [[ "$attempt" -lt "$HEALTH_ATTEMPTS" ]]; then
    sleep "$HEALTH_DELAY_SECONDS"
  fi
done

printf 'Health checks failed after %s attempts.\n' "$HEALTH_ATTEMPTS" >&2
exit 1
