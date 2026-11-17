#!/usr/bin/env bash
# mk2-exchange/scripts/review.sh
#
# Lays a disk that waits for David out to be reviewed (REVIEW.md;
# docs/exchange_review.md §5 in the machine's repository): its file fetched
# under the sysop's key, unpacked by the machine's own mk2disk, and the
# checker's facts beside it, all in reviews/<id>/, which git never keeps.
# With no id, lists what waits.
#
#   scripts/review.sh            what waits: id, maker, title, and new or reported
#   scripts/review.sh <id>       reviews/<id>/: disk.png, facts.json, and the disk unpacked
#
# The machine's checkout is ~/Documents/GitHub/jet64/mk2, or what MK2 names; its
# build/mk2disk is made by `make build/mk2disk` there. Node runs the client, or
# Docker's node:22 where this Mac has none.
set -euo pipefail
cd "$(dirname "$0")/.."

mk2="${MK2:-$HOME/Documents/GitHub/jet64/mk2}"
[ -f sysop.key ] || { echo "No sysop.key here. Copy yours in from your backup and run this again."; exit 1; }

client() {
  if command -v node > /dev/null; then
    node scripts/exchange.mjs "$@"
  else
    docker run --rm --platform linux/amd64 -e EXCHANGE -v "$PWD":/x -w /x node:22-bookworm node scripts/exchange.mjs "$@"
  fi
}

waiting="$(client sysop sysop.key hidden)"
id="${1:-}"
if [ -z "$id" ]; then
  jq -r '.hidden[] | "\(.id)  \(.maker)  \(.title)  \(if .reports == 0 then "new" else "\(.reports) reports" end)"' <<<"$waiting"
  exit 0
fi
[[ "$id" =~ ^[0-9a-f]{32}$ ]] || { echo "no such disk: an id is 32 hex digits"; exit 1; }
listed="$(jq -c --arg id "$id" '.hidden[] | select(.id == $id)' <<<"$waiting")"
[ -n "$listed" ] || { echo "$id is not waiting"; exit 1; }

folder="reviews/$id"
rm -rf "$folder" && mkdir -p "$folder"
client review sysop.key "$id" "$folder/disk.png" > /dev/null
[ "$(shasum -a 256 "$folder/disk.png" | cut -c1-64)" = "$(jq -r .sha256 <<<"$listed")" ] ||
  { echo "the disk fetched is not the one the exchange lists"; exit 1; }
jq . <<<"$listed" > "$folder/facts.json"
"$mk2/build/mk2disk" unpack "$folder/disk.png" "$folder" > /dev/null
echo "$folder/$(jq -r .name <<<"$listed")  $(jq -r '"\(.title) by \(.maker)"' <<<"$listed")"
jq -r '.facts[] | "  - \(.fact)"' <<<"$listed"
echo "Read REVIEW.md, then write $folder.review.md."
