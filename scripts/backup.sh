#!/usr/bin/env bash
# Back up the keys and every gateway database, then prove the copy restores.
#   bash scripts/backup.sh            # writes ~/tab-backups/tab-YYYYmmdd-HHMMSS.tar.gz and verifies it
#   bash scripts/backup.sh --verify-only <file.tar.gz>
# Databases are copied with SQLite's online backup API (node:sqlite), so a copy taken
# while the gateways are serving is consistent. Keeps the last 30 archives.
set -euo pipefail
cd "$(dirname "$0")/.."
NODE="node --no-warnings=ExperimentalWarning"
OUT=${TAB_BACKUP_DIR:-$HOME/tab-backups}
STAMP=$(date +%Y%m%d-%H%M%S)

verify() {
  local archive=$1 tmp
  tmp=$(mktemp -d)
  tar xzf "$archive" -C "$tmp"
  local ok=1
  for db in "$tmp"/db/*.db; do
    [ -e "$db" ] || continue
    if ! $NODE scripts/backup-sqlite.mjs check "$db"; then ok=0; fi
  done
  local keys
  keys=$(find "$tmp/keys" -name '*.json' 2>/dev/null | wc -l)
  echo "  keys: $keys json files"
  rm -rf "$tmp"
  [ "$ok" = 1 ] && [ "$keys" -gt 0 ]
}

if [ "${1:-}" = "--verify-only" ]; then
  verify "$2" && echo "restore test passed: $2"
  exit
fi

mkdir -p "$OUT"
chmod 700 "$OUT"
WORK=$(mktemp -d)
mkdir -p "$WORK/db" "$WORK/keys"
for db in *.db; do
  [ -e "$db" ] || continue
  $NODE scripts/backup-sqlite.mjs copy "$db" "$WORK/db/$db"
done
cp -p keys/*.json "$WORK/keys/"
ARCHIVE="$OUT/tab-$STAMP.tar.gz"
tar czf "$ARCHIVE" -C "$WORK" db keys
chmod 600 "$ARCHIVE"
rm -rf "$WORK"
echo "wrote $ARCHIVE ($(du -h "$ARCHIVE" | cut -f1))"
echo "restore test:"
verify "$ARCHIVE" && echo "restore test passed"
ls -1t "$OUT"/tab-*.tar.gz | tail -n +31 | xargs -r rm -f
echo "archives kept: $(ls -1 "$OUT"/tab-*.tar.gz | wc -l)"
