#!/usr/bin/env bash
# Starts the complete stack and fails unless every service reports healthy.
# Covers the J0 acceptance criterion "docker compose up brings every service to a healthy state".
#
# Usage: scripts/compose-healthy.sh [--no-build]
set -euo pipefail
cd "$(dirname "$0")/.."

build_flag="--build"
if [[ "${1:-}" == "--no-build" ]]; then
  build_flag="--no-build"
fi

if ! docker compose up --detach "$build_flag" --wait --wait-timeout 300; then
  docker compose ps --all
  docker compose logs --no-color --tail 100
  exit 1
fi

expected=$(docker compose config --services | sort)
healthy=$(docker compose ps --format '{{.Service}} {{.Health}}' | awk '$2 == "healthy" { print $1 }' | sort)

if [[ "$expected" != "$healthy" ]]; then
  echo "Services not healthy:" >&2
  comm -23 <(echo "$expected") <(echo "$healthy") >&2
  docker compose ps --all
  exit 1
fi

echo "All services healthy:"
echo "$healthy" | sed 's/^/  - /'
