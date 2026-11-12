#!/usr/bin/env bash
# mk2-exchange/tests/e2e.sh
#
# The whole exchange on one machine: the Worker under `wrangler dev` with a
# local R2 and D1, the validator's two halves run by hand where GitHub would
# run them, and the client publishing, taking, reporting and switching. The
# database is laid as a deploy lays it (scripts/catalogue.sh). Run in a Linux
# container, from the repository's top:
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
# Other computers, by addresses kept for documents (RFC 5737). Cloudflare names
# a caller's address in a header nobody can set from outside; here nothing does,
# so a take may say where it is from.
readonly ELSEWHERE=203.0.113.7 FURTHER=203.0.113.8 FURTHEST=203.0.113.9
# A day long gone, and more takes than any day's cap.
readonly LONG_AGO=2026-01-01 PAST_ANY_CAP=1000000000
# The most characters of a maker's sentence (src/rules.ts).
readonly ABOUT_CHARACTERS_MOST=160
# A take is counted after its answer has gone. How often the catalogue is asked,
# a second apart, for a take that should count; and how long one that should
# not is given to have counted all the same.
readonly COUNT_TRIES=10 SETTLE_SECONDS=2
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
# One statement put to the local database, and the first row of its answer.
d1() {
  npx wrangler d1 execute jet64-exchange --local --yes --json --command "$1" 2>> "$OUT/schema.log" |
    jq -c '.[0].results[0]'
}
# The catalogue as it reads this moment: it is cached, and any switch of the sysop's drops it.
fresh_index() { client sysop "$OUT/sysop.key" resume > /dev/null; curl -fsS "$EXCHANGE/index"; }
takes() { fresh_index | jq -r --arg name "$1" '.disks[] | select(.name == $name) | .takes'; }
# Whether a cart's takes come to `$2` before the tries run out.
counted() { for _ in $(seq "$COUNT_TRIES"); do [ "$(takes "$1")" = "$2" ] && return 0; sleep 1; done; return 1; }
# The disk `$2` taken from the computer at `$1`.
take_from() { curl -fsS -H "cf-connecting-ip: $1" "$EXCHANGE/disk/$2" -o /dev/null; }

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
bash scripts/catalogue.sh --local > "$OUT/schema.log" 2>&1
# The live catalogue was laid before a disk had its maker's sentence. This one
# is stood as that one was and laid twice more: the column is back, once.
d1 "ALTER TABLE disks DROP COLUMN about" > /dev/null
bash scripts/catalogue.sh --local >> "$OUT/schema.log" 2>&1
bash scripts/catalogue.sh --local >> "$OUT/schema.log" 2>&1
check "a catalogue laid before a disk had a sentence gains the column, once" \
  test "$(d1 "SELECT COUNT(*) AS n FROM pragma_table_info('disks') WHERE name = 'about'" | jq .n)" = 1
# What an earlier day counted, for today's first take to sweep away.
d1 "INSERT INTO taken (day, maker, name, ip) VALUES ('$LONG_AGO', 'ace', 'old', 'old')" > /dev/null
d1 "INSERT INTO take_days (day, counted) VALUES ('$LONG_AGO', 1)" > /dev/null
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
cart=$(jq -r '.disks[0].name' <<<"$index")
check "a disk nobody has taken lists no takes" test "$(jq -r '.disks[0].takes' <<<"$index")" = 0
curl -fsS "$EXCHANGE/disk/$id" -o "$OUT/taken.disk.png"
check "the disk taken is the disk sent" cmp -s "$OUT/taken.disk.png" /v/small.disk.png
curl -fsS "$EXCHANGE/label/$id" -o "$OUT/label.png"
check "its label is a PNG" test "$(head -c 4 "$OUT/label.png" | od -An -c | tr -d ' ')" = "211PNG"
check "a take is counted for the disk's cart" counted "$cart" 1
curl -fsS "$EXCHANGE/disk/$id" -o /dev/null
sleep "$SETTLE_SECONDS"
check "a second take from the same computer the same day is not counted" test "$(takes "$cart")" = 1
take_from "$ELSEWHERE" "$id"
check "a take from another computer is counted" counted "$cart" 2

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

# ---- A cart's versions: its maker's sentence and its takes ----------------------------------
# A new version of the first disk's cart, its verdict made by hand as a
# validator of any age might send it: what the first disk's check said, with
# `$2` laid over it. The Worker never opens a disk, so any new bytes stand for
# a new version. Prints the Worker's answer to the verdict.
checked=$(jq -c '.disks[0] | {name, title, kind, machine}' <<<"$index")
base64 -w0 "$OUT/label.png" > "$OUT/label.b64"
version() { # n, what the check adds
  local disk="$OUT/v$1.disk.png" upload
  { cat /v/small.disk.png; echo "$1"; } > "$disk"
  upload=$(field "$(client publish "$OUT/maker.key" "ace" "$disk")" .id)
  VERDICT=$(jq -cn --arg sha256 "$(sha256sum "$disk" | cut -c1-64)" --argjson check "$checked" --argjson more "$2" \
    --rawfile picture "$OUT/label.b64" '{"ok": true, "sha256": $sha256, "check": ($check + $more), "label": $picture}') \
    scripts/report.sh "$upload"
}
sentence_of() { jq -cn --argjson length "$1" '{about: ("x" * $length)}'; }
state_of() { field "$1" '"\(.state) \(.version // .reason)"'; }
refused="failed what a disk says about itself is one line of at most $ABOUT_CHARACTERS_MOST characters"

said=$(version 2 '{"about": "  Rocks, a ship and your nerve.  "}')
second=$(field "$said" .id)
check "a verdict may carry the maker's sentence" test "$(state_of "$said")" = "live 2"
check "the sentence is listed, trimmed, and the cart keeps the takes of the version before" \
  test "$(curl -fsS "$EXCHANGE/index" | jq -r '.disks[0] | "\(.id)|\(.about)|\(.takes)"')" \
    = "$second|Rocks, a ship and your nerve.|2"
take_from "$FURTHER" "$second"
check "the takes of two versions are one cart's" counted "$cart" 3
said=$(version 3 '{"about": "two\nlines"}')
check "a sentence of two lines fails its disk, and says why" test "$(state_of "$said")" = "$refused"
said=$(version 4 "$(sentence_of $((ABOUT_CHARACTERS_MOST + 1)))")
check "a sentence one character too long fails its disk" test "$(state_of "$said")" = "$refused"
said=$(version 5 '{"about": 5}')
check "a sentence that is not words fails its disk" test "$(state_of "$said")" = "$refused"
said=$(version 6 '{"title": "Two\nLines"}')
check "a title of two lines fails its disk" test "$(state_of "$said")" = "failed the validator's answer did not read"
said=$(version 7 "$(sentence_of "$ABOUT_CHARACTERS_MOST")")
check "a sentence of the most characters passes" test "$(state_of "$said")" = "live 3"
said=$(version 8 '{}')
newest=$(field "$said" .id)
check "a verdict with no sentence, as an older validator's, passes" test "$(state_of "$said")" = "live 4"
check "a disk whose verdict had no sentence lists none" \
  test "$(curl -fsS "$EXCHANGE/index" | jq -r '.disks[0] | "\(.id)|\(.about)|\(.takes)"')" = "$newest||3"

check "a take counted today sweeps away what earlier days kept" \
  test "$(d1 "SELECT (SELECT COUNT(*) FROM taken WHERE day = '$LONG_AGO') + (SELECT COUNT(*) FROM take_days WHERE day = '$LONG_AGO') AS n" | jq .n)" = 0
said=$(client sysop "$OUT/sysop.key" zero ace "$cart")
check "the sysop sets a cart's takes back to none" test "$(field "$said" .changed)" = 1
check "a cart set back lists no takes" test "$(curl -fsS "$EXCHANGE/index" | jq -r '.disks[0].takes')" = 0
d1 "UPDATE take_days SET counted = $PAST_ANY_CAP" > /dev/null
take_from "$FURTHEST" "$newest"
sleep "$SETTLE_SECONDS"
check "past the day's cap a disk is given and its take not counted" test "$(takes "$cart")" = 0

echo "e2e: $checks checks, $failed failed"
[ "$failed" -eq 0 ]
