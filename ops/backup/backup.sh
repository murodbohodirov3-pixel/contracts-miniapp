#!/bin/sh
set -eu

timestamp=$(date -u +%Y%m%dT%H%M%SZ)
target="$BACKUP_DIR/$timestamp"
mkdir -p "$target"

pg_dump --format=custom --file="$target/database.dump"
tar -C /files -cf "$target/files.tar" .
sha256sum "$target/database.dump" "$target/files.tar" > "$target/SHA256SUMS"
printf '%s backup completed\n' "$timestamp" >> "$BACKUP_DIR/backup.log"

# Keep seven daily snapshots. Weekly retention and off-host replication are configured by the university host timer.
find "$BACKUP_DIR" -mindepth 1 -maxdepth 1 -type d -mtime +7 -exec rm -rf {} +
