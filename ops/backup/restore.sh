#!/bin/sh
set -eu

if [ "$#" -ne 2 ]; then
  echo "Usage: restore.sh /path/to/backup postgres://user:password@host:5432/database" >&2
  exit 64
fi

backup_dir="$1"
database_url="$2"
sha256sum -c "$backup_dir/SHA256SUMS"
pg_restore --clean --if-exists --no-owner --dbname="$database_url" "$backup_dir/database.dump"
echo "Database restored. Extract files.tar only into an empty replacement files volume."
