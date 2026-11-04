#!/usr/bin/env bash
# Backs up a running Galley instance: database, stored objects, Git repositories
# and a manifest (SPEC §3.9, docs/operations.md). The instance keeps running.
#
# Usage: scripts/backup.sh [folder]          (default: ./backups)
#
# Each backup is a folder galley-<UTC date>/ with database.dump, objects.tar,
# git.tar, manifest.json and SHA256SUMS. With BACKUP_AGE_RECIPIENT set (an age
# public key, or a file of them), the folder is replaced by one encrypted file
# galley-<UTC date>.tar.age, which only the matching private key opens: the
# server needs the public key only. Backups older than BACKUP_KEEP_DAYS are
# deleted afterwards. Both settings come from the environment or .env. The master
# key GALLEY_MASTER_KEY is not in the backup: keep a copy of .env apart.
set -euo pipefail
cd "$(dirname "$0")/.."

# A setting from the environment, else from .env.
setting() {
  local value="${!1:-}"
  if [[ -z "$value" && -f .env ]]; then
    value=$(sed -n "s/^$1=//p" .env | tail -n 1)
  fi
  printf '%s' "$value"
}

root="${1:-backups}"
keep=$(setting BACKUP_KEEP_DAYS)
keep="${keep:-14}"
if ! [[ "$keep" =~ ^[0-9]+$ ]]; then
  echo "BACKUP_KEEP_DAYS must be a number of days, not \"$keep\"." >&2
  exit 2
fi

recipient=$(setting BACKUP_AGE_RECIPIENT)
age_args=()
if [[ -n "$recipient" ]]; then
  if ! command -v age > /dev/null; then
    echo "BACKUP_AGE_RECIPIENT is set but age is not installed (apt install age)." >&2
    exit 2
  fi
  if [[ "$recipient" == age1* || "$recipient" == ssh-* ]]; then
    age_args=(--recipient "$recipient")
  elif [[ -f "$recipient" ]]; then
    age_args=(--recipients-file "$recipient")
  else
    echo "BACKUP_AGE_RECIPIENT must be an age public key (age1...) or a file of them." >&2
    exit 2
  fi
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
# Fingerprinted before and after: equal values mean nothing changed meanwhile,
# and restore.sh --verify can then expect exactly this content back.
before=$(cli fingerprint)
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
if [[ "$fingerprint" != "$before" ]]; then
  echo "  the instance changed during the backup: usable, but not verifiable by its fingerprint"
  fingerprint=null
fi
printf '{"createdAt":"%s","application":%s,"objects":%s,"fingerprint":%s}\n' \
  "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$info" "$(cat "$work/objects.json")" "$fingerprint" \
  > "$work/manifest.json"
rm "$work/objects.json"
(cd "$work" && sha256sum database.dump objects.tar git.tar manifest.json > SHA256SUMS)

if ((${#age_args[@]} > 0)); then
  # One archive, encrypted and authenticated; the plain folder never outlives it.
  tar -C "$work" -cf - . | age "${age_args[@]}" --output "$target.tar.age.partial"
  mv "$target.tar.age.partial" "$target.tar.age"
  rm -rf "$work"
  target="$target.tar.age"
else
  mv "$work" "$target"
fi
trap - EXIT
echo "Backup complete: $target"

# Rotation: only what this script created, older than the retention period.
find "$root" -mindepth 1 -maxdepth 1 \
  \( -type d -name 'galley-*' ! -name '*.partial' -o -type f -name 'galley-*.tar.age' \) \
  -mtime "+$keep" -print -exec rm -rf {} + | sed 's/^/  removed old backup: /'
