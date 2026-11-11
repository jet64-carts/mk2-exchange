#!/usr/bin/env bash
# mk2-exchange/scripts/report.sh
#
# The validator's second half: it never touches the disk, holds the one
# secret, and hands the first half's verdict back to the Worker. A first half
# that never finished is reported as a failure, so no upload waits forever.
#
#   EXCHANGE=... VERDICT_TOKEN=... VERDICT='{"ok":...}' scripts/report.sh <id>
set -euo pipefail

id="${1:-}"
[[ "$id" =~ ^[0-9a-f]{32}$ ]] || { echo "no such upload" >&2; exit 1; }
verdict="${VERDICT:-}"
[ -n "$verdict" ] || verdict='{"ok":false,"reason":"the check did not finish"}'
printf '%s' "$verdict" | curl -fsS --max-time 60 -X POST \
  -H "authorization: Bearer $VERDICT_TOKEN" -H "content-type: application/json" \
  --data-binary @- "$EXCHANGE/verdict/$id"
echo
