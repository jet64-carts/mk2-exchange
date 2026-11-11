#!/usr/bin/env bash
# mk2-exchange/scripts/check.sh
#
# The validator's half that reads a stranger's file (docs/exchange.md §6 in the
# machine's repository): it fetches one upload from quarantine, holds it to the
# hash its maker signed, and runs `mk2disk check`, the very C the island unpacks
# with. It runs with no secrets and no permissions, and prints one line of JSON,
# the verdict, which the second job hands back.
#
#   EXCHANGE=https://exchange.jet64.com VALIDATOR=./mk2disk scripts/check.sh <id>
set -euo pipefail

readonly DISK_BYTES_MOST=$((16 * 1024 * 1024))
readonly LABEL_BYTES_MOST=$((512 * 1024))
readonly MEMORY_KB_MOST=$((2 * 1024 * 1024))
readonly SECONDS_MOST=60

id="${1:-}"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

no() {
  jq -cn --arg reason "$1" '{ok: false, reason: $reason}'
  exit 0
}

[[ "$id" =~ ^[0-9a-f]{32}$ ]] || no "no such upload"
curl -fsS --max-time 120 --max-filesize "$DISK_BYTES_MOST" -D "$work/headers" \
  "$EXCHANGE/quarantine/$id" -o "$work/disk.png" || no "the disk could not be fetched"
claimed=$(grep -i '^x-jet-sha256:' "$work/headers" | tr -d '\r' | awk '{print tolower($2)}')
actual=$(sha256sum "$work/disk.png" | cut -c1-64)
[ -n "$claimed" ] && [ "$claimed" = "$actual" ] || no "the disk is not the one its maker signed"

if ! answer=$( (ulimit -v "$MEMORY_KB_MOST"; timeout "$SECONDS_MOST" "$VALIDATOR" check "$work/disk.png" "$work/label.png") ); then
  no "$(printf '%s' "$answer" | jq -r '.error // empty' 2>/dev/null | head -c 200 || true)"
fi
[ "$(stat -c %s "$work/label.png")" -le "$LABEL_BYTES_MOST" ] || no "the disk's label is too large"
base64 -w0 "$work/label.png" > "$work/label.b64"
jq -cn --arg sha256 "$actual" --argjson check "$answer" --rawfile picture "$work/label.b64" \
  '{"ok": true, "sha256": $sha256, "check": $check, "label": $picture}'
