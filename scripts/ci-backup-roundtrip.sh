#!/usr/bin/env bash
# J10 acceptance A1: back up the running stack, destroy every volume, start a
# fresh stack, restore, and check that the content and sign-in came back.
#
# Usage: scripts/ci-backup-roundtrip.sh     (on a running stack; CI runs it after e2e)
set -euo pipefail
cd "$(dirname "$0")/.."

backups=$(mktemp -d)
account="restore$(date +%s)"
created=$(docker compose exec -T api node dist/cli/admin.js create-user \
  --email "$account@example.org" --username "$account" --name "Restore check")
password=$(sed -n 's/^Temporary password: //p' <<< "$created")

# Background jobs (automatic history versions) may change the instance while it
# is backed up; a backup is verifiable only when nothing changed, hence retries.
backup=""
for attempt in 1 2 3; do
  folder="$backups/$attempt"
  scripts/backup.sh "$folder"
  backup=$(find "$folder" -mindepth 1 -maxdepth 1 -type d -name 'galley-*' | head -n 1)
  if ! grep -q '"fingerprint":null' "$backup/manifest.json"; then break; fi
  backup=""
  sleep 5
done
if [[ -z "$backup" ]]; then
  echo "No quiet backup after three attempts." >&2
  exit 1
fi
ls -l "$backup"

docker compose down --volumes
scripts/compose-healthy.sh --no-build
scripts/restore.sh "$backup" --yes --verify

status=$(curl --silent --insecure --output /dev/null --write-out '%{http_code}' \
  --header 'content-type: application/json' \
  --data "{\"login\":\"$account\",\"password\":\"$password\"}" \
  https://localhost/api/auth/login)
if [[ "$status" != 200 ]]; then
  echo "Signing in after the restore answered $status." >&2
  exit 1
fi
echo "Backup and restore verified: same fingerprint, sign-in works."
