#!/usr/bin/env bash
# mk2-exchange/scripts/report.sh
#
# The validator's second half: it never opens the disk, holds the one secret,
# and hands the first half's work back to the Worker: the disk built afresh,
# streamed as it lies, then the verdict. A first half that never finished, or
# that passed a disk and left none built, is reported as a failure, so no
# upload waits forever.
#
#   EXCHANGE=... VERDICT_TOKEN=... VERDICT_FILE=verdict.json REBUILT=rebuilt.disk.png scripts/report.sh <id>
#
# The verdict is read from a file, never the environment: it carries the label
# as base64, which can pass Linux's 128 KB for one variable.
set -euo pipefail

id="${1:-}"
[[ "$id" =~ ^[0-9a-f]{32}$ ]] || { echo "no such upload" >&2; exit 1; }
file="${VERDICT_FILE:-}"
failed() {
  file="$(mktemp)"
  printf '{"ok":false,"reason":"%s"}' "$1" > "$file"
}
if [ -z "$file" ] || [ ! -s "$file" ]; then
  failed "the check did not finish"
elif [ "$(jq -r .ok "$file")" = true ]; then
  if [ -z "${REBUILT:-}" ] || [ ! -s "$REBUILT" ] ||
     ! curl -fsS --max-time 300 -X POST -H "authorization: Bearer $VERDICT_TOKEN" \
       -H "content-type: application/octet-stream" --data-binary @"$REBUILT" "$EXCHANGE/rebuilt/$id" > /dev/null; then
    failed "the check did not finish"
  fi
fi
curl -fsS --max-time 60 -X POST \
  -H "authorization: Bearer $VERDICT_TOKEN" -H "content-type: application/json" \
  --data-binary @"$file" "$EXCHANGE/verdict/$id"
echo
