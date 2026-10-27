#!/usr/bin/env bash
# J10 acceptance A1: back up the running stack, destroy every volume, start a
# fresh stack, restore, and check that the content and sign-in came back.
#
# Usage: scripts/ci-backup-roundtrip.sh     (on a running stack; CI runs it after e2e)
set -euo pipefail
cd "$(dirname "$0")/.."

backups=$(mktemp -d)
created=$(docker compose exec -T api node dist/cli/admin.js create-user \
  --email restore-check@example.org --username restore-check --name "Restore check")
password=$(sed -n 's/^Temporary password: //p' <<< "$created")

scripts/backup.sh "$backups"
backup=$(find "$backups" -mindepth 1 -maxdepth 1 -type d -name 'galley-*' | head -n 1)
ls -l "$backup"

docker compose down --volumes
scripts/compose-healthy.sh --no-build
scripts/restore.sh "$backup" --yes --verify

status=$(curl --silent --insecure --output /dev/null --write-out '%{http_code}' \
  --header 'content-type: application/json' \
  --data "{\"login\":\"restore-check\",\"password\":\"$password\"}" \
  https://localhost/api/auth/login)
if [[ "$status" != 200 ]]; then
  echo "Signing in after the restore answered $status." >&2
  exit 1
fi
echo "Backup and restore verified: same fingerprint, sign-in works."
