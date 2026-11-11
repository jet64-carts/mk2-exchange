#!/usr/bin/env bash
# mk2-exchange/tests/e2e.sh
#
# The whole exchange on one machine: the Worker under `wrangler dev` with a
# local R2 and D1, the validator's two halves run by hand where GitHub would
# run them, and the client publishing, taking, reporting and switching. Run in
# a Linux container, from the repository's top:
#
#   docker run --rm --platform linux/amd64 -v "$PWD":/x -w /x \
#     -v <folder holding mk2disk-linux-x86_64 and the test disks>:/v \
#     node:22-bookworm bash tests/e2e.sh
#
# /v holds mk2disk-linux-x86_64, small.disk.png (a whole disk under 4 MiB) and
# large.disk.png (a whole disk over 4 MiB).
set -euo pipefail

export EXCHANGE=http://127.0.0.1:8787
export VERDICT_TOKEN=test-verdict-token
export VALIDATOR=/v/mk2disk-linux-x86_64
OUT=tests/out
failed=0
checks=0

check() { # what, condition...
  local what="$1"; shift
  checks=$((checks + 1))
  if "$@"; then echo "ok    $what"; else echo "FAIL  $what"; failed=$((failed + 1)); fi
}
has() { grep -q -- "$2" <<<"$1"; }
field() { jq -r "$2" <<<"$1"; }
client() { node scripts/exchange.mjs "$@" 2>&1 || true; }

command -v jq >/dev/null || (apt-get update -qq && apt-get install -y -qq jq >/dev/null)
rm -rf "$OUT" .wrangler/state && mkdir -p "$OUT"
if [ -f package-lock.json ]; then npm ci --silent --no-audit --no-fund; else npm install --silent --no-audit --no-fund; fi
npx tsc --noEmit
check "the Worker type-checks" true

node scripts/exchange.mjs key "$OUT/sysop.key" > "$OUT/sysop.pub"
node scripts/exchange.mjs key "$OUT/maker.key" > /dev/null
node scripts/exchange.mjs key "$OUT/other.key" > /dev/null
node scripts/exchange.mjs key "$OUT/third.key" > /dev/null
cat > .dev.vars <<EOF
SYSOP_KEY=$(cat "$OUT/sysop.pub")
VERDICT_TOKEN=$VERDICT_TOKEN
IP_SALT=test-salt
EOF
npx wrangler d1 execute jet64-exchange --local --file schema.sql > "$OUT/schema.log" 2>&1
npx wrangler dev --local --ip 127.0.0.1 --port 8787 > "$OUT/worker.log" 2>&1 &
worker=$!
trap 'kill $worker 2>/dev/null; rm -f .dev.vars' EXIT
for _ in $(seq 60); do curl -fsS "$EXCHANGE/" >/dev/null 2>&1 && break; sleep 1; done
check "the Worker answers" curl -fsS "$EXCHANGE/" -o /dev/null

validate() { # id: both halves of the Action, by hand
  local verdict
  verdict=$(scripts/check.sh "$1")
  VERDICT="$verdict" scripts/report.sh "$1"
}

# ---- Names ---------------------------------------------------------------------------------
said=$(client publish "$OUT/other.key" "Bad Name" /v/small.disk.png)
check "a name with capitals and spaces is refused" has "$said" bad_name
said=$(client publish "$OUT/other.key" "adm1n" /v/small.disk.png)
check "a lookalike of a reserved name is refused" has "$said" name_taken

# ---- Publish, check, take -----------------------------------------------------------------
said=$(client publish "$OUT/maker.key" "ace" /v/large.disk.png)
check "a new maker's disk over 4 MiB is refused" has "$said" too_large
said=$(client publish "$OUT/maker.key" "ace" /v/small.disk.png)
id=$(field "$said" .id)
check "a disk is taken into quarantine" test "$(field "$said" .state)" = checking
check "a disk being checked is not listed" test "$(curl -fsS "$EXCHANGE/index" | jq '.disks | length')" = 0
check "a disk being checked cannot be taken" test "$(curl -s -o /dev/null -w '%{http_code}' "$EXCHANGE/disk/$id")" = 404
said=$(client publish "$OUT/other.key" "ace-" /v/small.disk.png)
check "a lookalike of a taken name is refused" has "$said" name_taken
said=$(client publish "$OUT/maker.key" "someoneelse" /v/small.disk.png)
check "a key publishes under one name only" has "$said" one_name
said=$(client publish "$OUT/maker.key" "ace" /v/small.disk.png)
check "the same disk twice is the same upload" test "$(field "$said" .id)" = "$id"
said=$(curl -s -X POST -H "content-type: application/json" --data '{"ok":true}' "$EXCHANGE/verdict/$id")
check "a verdict without the validator's token is refused" has "$said" unsigned

said=$(validate "$id")
check "the validator passes a whole disk" test "$(field "$said" .state)" = live
index=$(curl -fsS "$EXCHANGE/index")
check "the live disk is listed with its maker and kind" \
  test "$(jq -r '.disks[0] | "\(.maker) \(.kind) \(.version)"' <<<"$index")" = "ace game 1"
curl -fsS "$EXCHANGE/disk/$id" -o "$OUT/taken.disk.png"
check "the disk taken is the disk sent" cmp -s "$OUT/taken.disk.png" /v/small.disk.png
curl -fsS "$EXCHANGE/label/$id" -o "$OUT/label.png"
check "its label is a PNG" test "$(head -c 4 "$OUT/label.png" | od -An -c | tr -d ' ')" = "211PNG"

# ---- A damaged disk ------------------------------------------------------------------------
head -c 30000 /v/small.disk.png > "$OUT/cut.disk.png"
said=$(client publish "$OUT/maker.key" "ace" "$OUT/cut.disk.png")
bad=$(field "$said" .id)
said=$(validate "$bad")
check "the validator fails a damaged disk, and says why" \
  test "$(field "$said" .state)" = failed -a -n "$(field "$said" .reason)"
check "a failed upload says why to its maker" \
  test "$(curl -fsS "$EXCHANGE/disks/$bad" | jq -r .disk.state)" = failed

# ---- Reports -------------------------------------------------------------------------------
for key in other third maker; do client report "$OUT/$key.key" "$id" > /dev/null; done
said=$(client report "$OUT/other.key" "$id")
check "a key reports a disk once" has "$said" already
check "three reports from one address do not hide a disk" \
  test "$(curl -fsS "$EXCHANGE/disks/$id" | jq -r .disk.state)" = live

# ---- David's switches ----------------------------------------------------------------------
said=$(client sysop "$OUT/maker.key" pause)
check "only the sysop's key works the switches" has "$said" not_sysop
client sysop "$OUT/sysop.key" pause > /dev/null
said=$(client publish "$OUT/other.key" "bee" /v/small.disk.png)
check "paused, the exchange takes no disk" has "$said" paused
client sysop "$OUT/sysop.key" resume > /dev/null
said=$(client sysop "$OUT/sysop.key" vouch ace)
check "the sysop vouches for a maker" test "$(field "$said" .changed)" = 1
check "a vouched maker is marked in the catalogue" \
  test "$(curl -fsS "$EXCHANGE/index" | jq -r '.disks[0].vouched')" = true
client sysop "$OUT/sysop.key" yank "$id" > /dev/null
check "a yanked disk leaves the catalogue" test "$(curl -fsS "$EXCHANGE/index" | jq '.disks | length')" = 0
check "a yanked disk's state says so" test "$(curl -fsS "$EXCHANGE/disks/$id" | jq -r .disk.state)" = yanked

echo "e2e: $checks checks, $failed failed"
[ "$failed" -eq 0 ]
