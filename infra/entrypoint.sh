#!/bin/sh
set -eu

for var in DATABASE_URL SESSION_SECRET RECOVERY_SECRET ENCRYPTION_KEY; do
  file_var="${var}_FILE"
  eval "path=\${${file_var}:-}"
  if [ -n "$path" ] && [ -f "$path" ]; then
    export "$var=$(cat "$path")"
  fi
done

if [ "${APP_ROLE:-web}" = "worker" ]; then
  exec node apps/worker/dist/main.js
fi
exec node apps/web/dist/main.js
