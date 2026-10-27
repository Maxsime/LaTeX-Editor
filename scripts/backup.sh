#!/usr/bin/env bash
# Backs up a running Galley instance: database, stored objects, Git repositories
# and a manifest (SPEC §3.9, docs/operations.md). The instance keeps running.
#
# Usage: scripts/backup.sh [folder]          (default: ./backups)
#
# Each backup is a folder galley-<UTC date>/ with database.dump, objects.tar,
# git.tar, manifest.json and SHA256SUMS. Backups older than BACKUP_KEEP_DAYS
# (environment or .env, default 14) are deleted afterwards. The master key
# GALLEY_MASTER_KEY is not in the backup: keep a copy of .env apart.
set -euo pipefail
cd "$(dirname "$0")/.."

root="${1:-backups}"
keep="${BACKUP_KEEP_DAYS:-}"
if [[ -z "$keep" && -f .env ]]; then
  keep=$(sed -n 's/^BACKUP_KEEP_DAYS=//p' .env | tail -n 1)
fi
keep="${keep:-14}"
if ! [[ "$keep" =~ ^[0-9]+$ ]]; then
  echo "BACKUP_KEEP_DAYS must be a number of days, not \"$keep\"." >&2
  exit 2
fi

# Backups hold every document and password digest: readable by their owner only.
umask 077
stamp=$(date -u +%Y%m%dT%H%M%SZ)
target="$root/galley-$stamp"
work="$target.partial"
mkdir -p "$work"
trap 'rm -rf "$work"' EXIT

cli() { docker compose exec -T api node dist/cli/admin.js "$@"; }

echo "Backing up to $target"
# Database first, objects next: objects are never rewritten, so every row of the
# dump finds its object; an object stored after the dump is merely unused.
docker compose exec -T postgres sh -c \
  'pg_dump --username="$POSTGRES_USER" --dbname="$POSTGRES_DB" --format=custom' \
  > "$work/database.dump"
echo "  database: $(du -h "$work/database.dump" | cut -f1)"

cli export-objects > "$work/objects.tar" 2> "$work/objects.json"
echo "  objects: $(cat "$work/objects.json")"

docker compose exec -T api tar -C /var/lib/galley/git -cf - . > "$work/git.tar"
echo "  git repositories: $(du -h "$work/git.tar" | cut -f1)"

info=$(cli backup-info)
fingerprint=$(cli fingerprint)
printf '{"createdAt":"%s","application":%s,"objects":%s,"fingerprint":%s}\n' \
  "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$info" "$(cat "$work/objects.json")" "$fingerprint" \
  > "$work/manifest.json"
rm "$work/objects.json"
(cd "$work" && sha256sum database.dump objects.tar git.tar manifest.json > SHA256SUMS)

mv "$work" "$target"
trap - EXIT
echo "Backup complete: $target"

# Rotation: only folders this script created, older than the retention period.
find "$root" -mindepth 1 -maxdepth 1 -type d -name 'galley-*' ! -name '*.partial' \
  -mtime "+$keep" -print -exec rm -rf {} + | sed 's/^/  removed old backup: /'
