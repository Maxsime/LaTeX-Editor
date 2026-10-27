#!/usr/bin/env bash
# Restores a backup of scripts/backup.sh into this instance, new or existing
# (docs/operations.md). Everything the instance holds is replaced.
#
# Usage: scripts/restore.sh <backup folder> [--yes] [--verify]
#
# --yes skips the confirmation asked when the instance already has accounts.
# --verify fails unless the restored content has the fingerprint recorded in the
# backup, which backup.sh records only when nothing changed while it ran.
# The master key is not in the backup: put the original GALLEY_MASTER_KEY in
# .env first, or the stored Zotero and AI keys cannot be read (users then
# enter them again; nothing else is lost).
set -euo pipefail
cd "$(dirname "$0")/.."

source_dir=""
confirmed=false
verify=false
for argument in "$@"; do
  case "$argument" in
    --yes) confirmed=true ;;
    --verify) verify=true ;;
    *) source_dir="$argument" ;;
  esac
done
if [[ -z "$source_dir" || ! -d "$source_dir" ]]; then
  echo "Usage: scripts/restore.sh <backup folder> [--yes] [--verify]" >&2
  exit 2
fi
source_dir=$(cd "$source_dir" && pwd)

echo "Checking $source_dir"
(cd "$source_dir" && sha256sum --check --quiet SHA256SUMS)

# A backup made by a newer version may hold tables this code does not know.
backup_migrations=$(sed -n 's/.*"migrations":\([0-9]*\).*/\1/p' "$source_dir/manifest.json")
code_migrations=$(grep -c '"tag"' packages/db/migrations/meta/_journal.json)
if [[ -z "$backup_migrations" ]]; then
  echo "manifest.json does not name its migrations: not a backup of scripts/backup.sh." >&2
  exit 1
fi
if ((backup_migrations > code_migrations)); then
  echo "This backup comes from a newer Galley ($backup_migrations migrations, this code has" >&2
  echo "$code_migrations). Update the code (git pull) before restoring." >&2
  exit 1
fi

docker compose up --detach --wait postgres valkey storage

psql() { docker compose exec -T postgres sh -c 'psql --username="$POSTGRES_USER" --dbname="$POSTGRES_DB" -v ON_ERROR_STOP=1 "$@"' psql "$@"; }

accounts=$(psql -tAc "select count(*) from users" 2>/dev/null || echo 0)
if [[ "$accounts" != "0" && "$confirmed" != true ]]; then
  echo "This instance has $accounts accounts. Restoring replaces all of its data." >&2
  read -r -p "Type RESTORE to continue: " answer
  [[ "$answer" == "RESTORE" ]] || { echo "Cancelled." >&2; exit 1; }
fi

echo "Stopping the application services"
docker compose stop caddy collab api compiler

echo "Restoring the database"
psql -qc 'set client_min_messages = warning; drop schema if exists drizzle cascade; drop schema public cascade; create schema public;'
docker compose exec -T postgres sh -c \
  'pg_restore --username="$POSTGRES_USER" --dbname="$POSTGRES_DB" --no-owner --exit-on-error' \
  < "$source_dir/database.dump"

# Queues and caches refer to compilations of the replaced instance.
docker compose exec -T valkey valkey-cli flushall > /dev/null

echo "Restoring the stored objects"
docker compose run --rm --no-deps -T api node dist/cli/admin.js import-objects \
  < "$source_dir/objects.tar"

echo "Restoring the Git repositories"
# The repositories are rebuilt from the projects when missing (SPEC §6.7); the
# archive keeps their history of commits for clients that pull.
docker compose run --rm --no-deps -T --entrypoint sh api -c \
  'find /var/lib/galley/git -mindepth 1 -delete && tar -C /var/lib/galley/git -xf -' \
  < "$source_dir/git.tar"

# Compared before any service runs, so that nothing has changed the content yet.
expected=$(sed -n 's/.*"fingerprint":\({[^}]*}\|null\).*/\1/p' "$source_dir/manifest.json")
restored=$(docker compose run --rm --no-deps -T api node dist/cli/admin.js fingerprint)
if [[ "$expected" == null ]]; then
  echo "The backup has no fingerprint: the instance changed while it was made. Restored: $restored"
  if [[ "$verify" == true ]]; then exit 1; fi
elif [[ "$restored" == "$expected" ]]; then
  echo "Fingerprint matches the backup: $restored"
elif [[ "$verify" == true ]]; then
  echo "Fingerprint differs from the backup." >&2
  echo "  backup:   $expected" >&2
  echo "  restored: $restored" >&2
  exit 1
else
  echo "Fingerprint differs from the backup, as expected when the instance was in use"
  echo "while it was backed up. Restored: $restored"
fi

echo "Starting Galley"
docker compose up --detach --wait
echo "Restore complete. Check that GALLEY_MASTER_KEY in .env is the one of the saved instance."
