#!/bin/sh
# WAL archive volume is often root-owned on first use; postgres (uid 70) must own /backups/wal.
set -e
mkdir -p /backups/wal /backups/daily
if ! chown -R postgres:postgres /backups/wal /backups/daily 2>/dev/null; then
  chmod -R a+rwx /backups/wal /backups/daily 2>/dev/null || true
fi
for EP in /usr/local/bin/docker-entrypoint.sh /docker-entrypoint.sh; do
  if [ -x "$EP" ]; then
    exec "$EP" "$@"
  fi
done
exec docker-entrypoint.sh "$@"
