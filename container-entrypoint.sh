#!/bin/sh
set -e

echo "=== Container starting ==="

DB_PATH=/data/db.sqlite3
SNAPSHOT_INTERVAL=${SNAPSHOT_INTERVAL:-60}

# Restore the SQLite database from the Worker's R2-backed snapshot endpoint.
# 404 on first boot is expected.
echo "=== Attempting snapshot restore from R2 via Worker ==="
if wget -q --tries=1 --timeout=30 \
    --header="X-Snapshot-Token: $SNAPSHOT_TOKEN" \
    -O "$DB_PATH.tmp" \
    "$WORKER_URL/_snap/restore" 2>&1; then
  mv "$DB_PATH.tmp" "$DB_PATH"
  echo "=== Restored database ($(stat -c%s "$DB_PATH" 2>/dev/null) bytes) ==="
else
  rm -f "$DB_PATH.tmp"
  echo "=== No existing snapshot, starting fresh ==="
fi

# Upload current DB to the Worker. Streaming via --body-file so large DBs don't OOM.
snapshot_save() {
  if [ ! -f "$DB_PATH" ]; then return 0; fi
  if wget -q --tries=1 --timeout=30 \
      --method=PUT \
      --header="X-Snapshot-Token: $SNAPSHOT_TOKEN" \
      --body-file="$DB_PATH" \
      -O /dev/null \
      "$WORKER_URL/_snap/save" 2>&1; then
    echo "=== Snapshot saved ($(stat -c%s "$DB_PATH" 2>/dev/null) bytes) ==="
  else
    echo "=== Snapshot save failed ==="
  fi
}

# Graceful shutdown: save final snapshot, then stop Authelia + helpers.
shutdown() {
  echo "=== Received SIGTERM, saving final snapshot ==="
  snapshot_save
  [ -n "$SNAPSHOT_PID"  ] && kill -TERM "$SNAPSHOT_PID"  2>/dev/null
  [ -n "$FORWARDER_PID" ] && kill -TERM "$FORWARDER_PID" 2>/dev/null
  [ -n "$AUTHELIA_PID"  ] && kill -TERM "$AUTHELIA_PID"  2>/dev/null
  wait
  echo "=== Shutdown complete ==="
  exit 0
}
trap shutdown TERM INT

# Background snapshot loop — pushes the DB to R2 every $SNAPSHOT_INTERVAL seconds.
(
  while true; do
    sleep "$SNAPSHOT_INTERVAL"
    snapshot_save
  done
) &
SNAPSHOT_PID=$!

# Background notification forwarder — reads /data/notification.txt and
# POSTs each new Authelia notification to the Worker's /_send endpoint.
/usr/local/bin/notif-forwarder.sh &
FORWARDER_PID=$!

# Start Authelia in the background so we can trap signals.
echo "=== Starting Authelia ==="
/app/authelia --config /config/configuration.yml &
AUTHELIA_PID=$!

wait -n
echo "=== A process exited, running shutdown ==="
shutdown
