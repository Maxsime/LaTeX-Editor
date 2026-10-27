#!/usr/bin/env bash
# Creates .env from .env.example with fresh random secrets (docs/installation.md).
#
# Usage: scripts/init-env.sh [host name] [e-mail for Let's Encrypt]
#
#   scripts/init-env.sh                                  local instance, https://localhost
#   scripts/init-env.sh tex.example.org admin@example.org   public instance
#
# The secrets of .env.example are public: the API refuses to start with them on
# any host but localhost. Keep a copy of the generated .env apart from backups:
# GALLEY_MASTER_KEY decrypts the keys users store and is not in them.
set -euo pipefail
cd "$(dirname "$0")/.."

host="${1:-localhost}"
tls="${2:-internal}"
if [[ -e .env ]]; then
  echo ".env already exists. Move it away first: its master key decrypts the stored keys." >&2
  exit 1
fi
if ! [[ "$host" =~ ^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$ ]]; then
  echo "\"$host\" is not a host name." >&2
  exit 2
fi
if [[ "$host" != localhost && "$tls" == internal ]]; then
  echo "A public host needs an e-mail address for its Let's Encrypt certificate:" >&2
  echo "  scripts/init-env.sh $host you@example.org" >&2
  exit 2
fi
if [[ "$tls" != internal && ! "$tls" =~ ^[^@[:space:]]+@[^@[:space:]]+$ ]]; then
  echo "\"$tls\" is not an e-mail address." >&2
  exit 2
fi

# Letters and digits only: the values go into URLs and need no escaping.
random() {
  local pool
  pool=$(head -c 1024 /dev/urandom | tr -dc 'A-Za-z0-9')
  printf '%s' "${pool:0:$1}"
}
postgres_password=$(random 32)
s3_secret=$(random 40)
internal_token=$(random 48)
master_key=$(head -c 32 /dev/urandom | base64)

umask 077
sed \
  -e "s|^GALLEY_HOST=.*|GALLEY_HOST=$host|" \
  -e "s|^GALLEY_TLS=.*|GALLEY_TLS=$tls|" \
  -e "s|galley-dev-password|$postgres_password|g" \
  -e "s|galley-dev-secret|$s3_secret|g" \
  -e "s|galley-dev-internal-token-change-me|$internal_token|g" \
  -e "s|^GALLEY_MASTER_KEY=.*|GALLEY_MASTER_KEY=$master_key|" \
  .env.example > .env

echo "Created .env for https://$host with new secrets."
echo "Keep a copy of it in a safe place: GALLEY_MASTER_KEY is needed to restore a backup."
