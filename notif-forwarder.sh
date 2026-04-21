#!/bin/sh
# Tails Authelia's filesystem notification log and forwards each new
# notification to the Worker's /_send endpoint (which invokes Cloudflare
# Email Sending). Authelia writes notifications as plain text blocks;
# each block starts with "Date: <timestamp>".

NOTIF_FILE=/data/notification.txt
OFFSET_FILE=/data/.notif-offset
WORK_DIR=/tmp/notif-work
mkdir -p "$WORK_DIR"

# JSON-escape stdin → stdout.
json_escape() {
  awk '
    BEGIN { ORS=""; printf "\"" }
    {
      gsub(/\\/, "\\\\")
      gsub(/"/, "\\\"")
      gsub(/\t/, "\\t")
      gsub(/\r/, "\\r")
      if (NR > 1) printf "\\n"
      printf "%s", $0
    }
    END { printf "\"" }
  '
}

send_block() {
  block_file="$1"
  [ -s "$block_file" ] || return 0

  to=$(awk -F'[{}]' '/^Recipient:/ { gsub(/ /, "", $2); print $2; exit }' "$block_file")
  subject=$(awk '/^Subject: / { sub(/^Subject: /, ""); print; exit }' "$block_file")
  body=$(awk 'found { print } /^Subject: / { found = 1 }' "$block_file")

  if [ -z "$to" ] || [ -z "$subject" ]; then
    echo "notif-forwarder: skipping malformed block (to='$to' subject='$subject')"
    return 0
  fi

  subject_json=$(printf "%s" "$subject" | json_escape)
  body_json=$(printf "%s" "$body"       | json_escape)
  to_json=$(printf "%s" "$to"           | json_escape)
  payload=$(printf '{"to":%s,"subject":%s,"text":%s}' "$to_json" "$subject_json" "$body_json")

  echo "notif-forwarder: sending to=$to subject='$subject'"
  code=$(wget -q --tries=2 --timeout=15 \
    --method=POST \
    --header="X-Snapshot-Token: $SNAPSHOT_TOKEN" \
    --header="Content-Type: application/json" \
    --body-data="$payload" \
    -S -O /dev/null \
    "$WORKER_URL/_send" 2>&1 | awk '/HTTP\// { print $2; exit }')

  if [ "$code" = "200" ]; then
    echo "notif-forwarder: sent ok (to=$to)"
  else
    echo "notif-forwarder: send failed (HTTP $code, to=$to)"
  fi
}

# Split the new-content stream into per-notification files, then send each.
process_new_content() {
  raw_file="$1"
  # Clean previous split output.
  rm -f "$WORK_DIR"/block-*

  # awk: each line starting with "Date: " opens a new block file.
  awk -v dir="$WORK_DIR" '
    BEGIN { n = 0; out = "" }
    /^Date: / {
      n++
      out = sprintf("%s/block-%04d", dir, n)
    }
    out != "" { print > out }
  ' "$raw_file"

  for f in "$WORK_DIR"/block-*; do
    [ -f "$f" ] || continue
    send_block "$f"
    rm -f "$f"
  done
}

# Authelia's filesystem notifier *truncates* /data/notification.txt on each
# new notification — it's not append-only. So we track the file's mtime and
# process the entire file whenever it changes.
LAST_MTIME=""

while true; do
  sleep 5
  [ -f "$NOTIF_FILE" ] || continue
  [ -s "$NOTIF_FILE" ] || continue
  mtime=$(stat -c%Y "$NOTIF_FILE" 2>/dev/null)
  if [ -n "$mtime" ] && [ "$mtime" != "$LAST_MTIME" ]; then
    cp "$NOTIF_FILE" "$WORK_DIR/new.txt"
    process_new_content "$WORK_DIR/new.txt"
    LAST_MTIME="$mtime"
  fi
done
