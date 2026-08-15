#!/usr/bin/env bash
set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL is required}"
: "${1:?Usage: restore.sh <backup.sql>}"

backup_file="$1"
if [[ ! -f "$backup_file" ]]; then
  echo "backup file not found: $backup_file" >&2
  exit 1
fi

psql "$DATABASE_URL" --set ON_ERROR_STOP=on --file "$backup_file"
