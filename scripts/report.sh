#!/usr/bin/env bash
# mk2-exchange/scripts/report.sh
#
# The validator's second half: it never touches the disk, holds the one
# secret, and hands the first half's verdict back to the Worker. A first half
# that never finished is reported as a failure, so no upload waits forever.
#
#   EXCHANGE=... VERDICT_TOKEN=... VERDICT_FILE=verdict.json scripts/report.sh <id>
#
# The verdict is read from a file, never the environment: it carries the label
# as base64, which can pass Linux's 128 KB for one variable.
set -euo pipefail

id="${1:-}"
[[ "$id" =~ ^[0-9a-f]{32}$ ]] || { echo "no such upload" >&2; exit 1; }
file="${VERDICT_FILE:-}"
if [ -z "$file" ] || [ ! -s "$file" ]; then
  file="$(mktemp)"
  printf '%s' '{"ok":false,"reason":"the check did not finish"}' > "$file"
fi
curl -fsS --max-time 60 -X POST \
  -H "authorization: Bearer $VERDICT_TOKEN" -H "content-type: application/json" \
  --data-binary @"$file" "$EXCHANGE/verdict/$id"
echo
