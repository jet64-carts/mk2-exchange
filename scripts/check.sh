#!/usr/bin/env bash
# mk2-exchange/scripts/check.sh
#
# The validator's half that reads a stranger's file (docs/exchange.md §6 and
# docs/exchange_review.md §4 in the machine's repository): it fetches one upload
# from quarantine, holds it to the hash its maker signed, and runs `mk2disk vet`,
# which holds it to every law the island unpacks by, refuses what the exchange
# never carries, builds its game afresh from its C and packs it again. It runs
# with no secrets and no permissions, prints one line of JSON, the verdict, and
# leaves the disk it built at REBUILT, both of which the second job hands back.
#
#   EXCHANGE=https://exchange.jet64.com VALIDATOR_DIR=<the validator, unpacked> \
#     MK2_ZIG=<Zig 0.16> REBUILT=rebuilt.disk.png scripts/check.sh <id>
#
# VALIDATOR_DIR is the release's folder: mk2disk and the machine's sources a
# build reads, from which mk2disk runs, as it runs from the machine's folder.
set -euo pipefail

readonly DISK_BYTES_MOST=$((16 * 1024 * 1024))
readonly LABEL_BYTES_MOST=$((512 * 1024))
# Long enough to compile the firmware cold on the runner's few cores.
readonly SECONDS_MOST=600

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

if ! answer=$(cd "$VALIDATOR_DIR" && timeout "$SECONDS_MOST" ./mk2disk vet "$work/disk.png" "$REBUILT" "$work/label.png"); then
  no "$(printf '%s' "$answer" | jq -r '.error // empty' 2>/dev/null | head -c 200 || true)"
fi
[ "$(stat -c %s "$work/label.png")" -le "$LABEL_BYTES_MOST" ] || no "the disk's label is too large"
[ "$(stat -c %s "$REBUILT")" -le "$DISK_BYTES_MOST" ] || no "the disk built afresh is past the exchange's 16 MB"
base64 -w0 "$work/label.png" > "$work/label.b64"
jq -cn --arg sha256 "$actual" --argjson check "$answer" --rawfile picture "$work/label.b64" \
  --arg built "$(sha256sum "$REBUILT" | cut -c1-64)" --argjson bytes "$(stat -c %s "$REBUILT")" \
  '{"ok": true, "sha256": $sha256, "rebuilt": {"sha256": $built, "bytes": $bytes}, "check": $check, "label": $picture}'
