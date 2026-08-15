#!/usr/bin/env bash
set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL is required}"
: "${BACKUP_PATH:?BACKUP_PATH is required}"

mkdir -p "$BACKUP_PATH"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
out="$BACKUP_PATH/manual-${stamp}.sql"

pg_dump --no-owner --no-acl --file "$out" "$DATABASE_URL"
sha256sum "$out" | awk '{print $1}' > "${out}.sha256"
echo "$out"
