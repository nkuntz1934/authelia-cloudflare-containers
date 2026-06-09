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
  [ -n "$SNAPSHOT_PID"    ] && kill -TERM "$SNAPSHOT_PID"    2>/dev/null
  [ -n "$FORWARDER_PID"   ] && kill -TERM "$FORWARDER_PID"   2>/dev/null
  [ -n "$AUTHELIA_PID"    ] && kill -TERM "$AUTHELIA_PID"    2>/dev/null
  [ -n "$CLOUDFLARED_PID" ] && kill -TERM "$CLOUDFLARED_PID" 2>/dev/null
  wait
  echo "=== Shutdown complete ==="
  exit 0
}
trap shutdown TERM INT

# --- LLDAP tunnel sidecar ---------------------------------------------------
# Forwards localhost:$LDAP_LOCAL_PORT through a Cloudflare Tunnel gated by an
# Access service-token policy. Authelia connects to ldap://localhost:3890.
: "${TUNNEL_HOSTNAME:?TUNNEL_HOSTNAME must be set}"
: "${CF_ACCESS_CLIENT_ID:?CF_ACCESS_CLIENT_ID must be set}"
: "${CF_ACCESS_CLIENT_SECRET:?CF_ACCESS_CLIENT_SECRET must be set}"

LDAP_LOCAL_PORT="${LDAP_LOCAL_PORT:-3890}"

echo "=== Starting cloudflared access tcp -> $TUNNEL_HOSTNAME ==="
# Force IPv4 listener so Authelia (which resolves "localhost" via /etc/hosts)
# always finds the proxy. cloudflared default `localhost` may bind ::1 only
# in containers without IPv6.
cloudflared access tcp \
  --hostname "$TUNNEL_HOSTNAME" \
  --url "127.0.0.1:${LDAP_LOCAL_PORT}" \
  --service-token-id "$CF_ACCESS_CLIENT_ID" \
  --service-token-secret "$CF_ACCESS_CLIENT_SECRET" \
  > /tmp/cloudflared.log 2>&1 &
CLOUDFLARED_PID=$!

# Readiness: wait up to 30s for the local TCP listener via /proc/net/tcp.
# busybox nc lacks `-z`, /dev/tcp needs bash, and we're in dash/busybox sh.
# /proc/net/tcp lists local_address as IP:PORT in hex with state 0A=LISTEN.
LDAP_PORT_HEX=$(printf '%04X' "$LDAP_LOCAL_PORT")
ready=0
for i in $(seq 1 30); do
  if ! kill -0 "$CLOUDFLARED_PID" 2>/dev/null; then
    echo "cloudflared exited early. Logs:"
    cat /tmp/cloudflared.log
    exit 1
  fi
  if awk -v p=":$LDAP_PORT_HEX" '$2 ~ p"$" && $4 == "0A" {found=1} END{exit !found}' \
       /proc/net/tcp /proc/net/tcp6 2>/dev/null; then
    ready=1
    echo "=== LDAP proxy ready after ${i}s ==="
    break
  fi
  sleep 1
done
if [ "$ready" != "1" ]; then
  echo "=== readiness probe never matched; continuing anyway ==="
fi
# ---------------------------------------------------------------------------

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
