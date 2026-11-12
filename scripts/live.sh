#!/usr/bin/env bash
# mk2-exchange/scripts/live.sh
#
# Takes a change live in one go, from a Mac with Docker and gh. It asks for one
# thing, the Cloudflare API token (README step 1), typed or pasted unseen; with
# CLOUDFLARE_API_TOKEN set it asks for nothing.
#
#   scripts/live.sh                the database brought up to date, the Worker deployed,
#                                  and sysop.key copied where the workstation reads it
#   scripts/live.sh 0.4.0-2        first a new validator, built from the machine's
#                                  checkout, released as validator-0.4.0-2 and pinned in
#                                  the workflow, that pin committed and pushed
#
# The machine's checkout is ~/Documents/GitHub/jet64/mk2, or what MK2 names. Safe
# to run again: a validator already released is not built again, a pin already
# made is not committed again, and deploy.sh passes over what is done.
set -euo pipefail

readonly REPO=jet64-carts/mk2-exchange
readonly ASSET=mk2disk-linux-x86_64
readonly WORKFLOW=.github/workflows/check.yml
# Where the workstation looks for the sysop's key, to show David's switches.
readonly ISLAND_KEY="$HOME/Library/Application Support/Jet64 Mk II/island/exchange/sysop.key"
cd "$(dirname "$0")/.."

# The exchange is set up already, so its sysop key is never made again here:
# without it, deploy.sh would make a new one and hand the switches to that.
if [ ! -f sysop.key ]; then
  echo "No sysop.key here. Copy yours in from your backup and run this again."
  exit 1
fi

version="${1:-}"
if [ -n "$version" ]; then
  mk2="${MK2:-$HOME/Documents/GitHub/jet64/mk2}"
  [ -d "$mk2" ] || { echo "the machine's checkout is not at $mk2: set MK2 to it"; exit 1; }
  echo "== the validator, validator-$version"
  if gh release view "validator-$version" --repo "$REPO" >/dev/null 2>&1; then
    # Released already: its hash is that of the file the release holds.
    held="$(mktemp -d)"
    gh release download "validator-$version" --repo "$REPO" --pattern "$ASSET" --dir "$held"
    sha256="$(shasum -a 256 "$held/$ASSET" | cut -c1-64)"
    echo "released before, SHA-256 $sha256"
  else
    built="$(scripts/release-validator.sh "$mk2" --release "$version")"
    echo "$built"
    sha256="$(sed -n 's/^VALIDATOR_SHA256: //p' <<<"$built")"
  fi
  [ "${#sha256}" -eq 64 ] || { echo "the validator's SHA-256 could not be read"; exit 1; }

  echo "== the pin"
  url="https://github.com/$REPO/releases/download/validator-$version/$ASSET"
  sed -i '' -e "s|^  VALIDATOR_URL: .*|  VALIDATOR_URL: $url|" -e "s|^  VALIDATOR_SHA256: .*|  VALIDATOR_SHA256: $sha256|" "$WORKFLOW"
  grep -q "VALIDATOR_URL: $url" "$WORKFLOW" && grep -q "VALIDATOR_SHA256: $sha256" "$WORKFLOW" ||
    { echo "$WORKFLOW was not pinned: its VALIDATOR lines are not where they were"; exit 1; }
  if git diff --quiet -- "$WORKFLOW"; then
    echo "pinned before"
  else
    git add "$WORKFLOW"
    git commit -q -m "chore(exchange): the workflow pins validator-$version" -- "$WORKFLOW"
    echo "pinned, and committed"
  fi
  # The Worker starts the workflow at main, so the pin counts only once it is there.
  git push -q origin main
  echo "pushed"
fi

if [ -z "${CLOUDFLARE_API_TOKEN:-}" ]; then
  read -rsp "Paste your Cloudflare API token, then Enter (it is not shown): " CLOUDFLARE_API_TOKEN
  echo
  export CLOUDFLARE_API_TOKEN
fi
[ -n "$CLOUDFLARE_API_TOKEN" ] || { echo "no token given: nothing was deployed"; exit 1; }
scripts/deploy.sh

echo "== the workstation's sysop key"
if [ ! -f "$ISLAND_KEY" ]; then
  mkdir -p "$(dirname "$ISLAND_KEY")"
  (umask 077 && cp sysop.key "$ISLAND_KEY")
  chmod 600 "$ISLAND_KEY"
  echo "installed, so the workstation shows your switches"
elif cmp -s sysop.key "$ISLAND_KEY"; then
  echo "installed before"
else
  echo "the workstation already holds a different sysop.key, left as it is: $ISLAND_KEY"
fi

echo "== live"
index="$(curl -fsS https://exchange.jet64.com/index)"
if grep -q '"takes"' <<<"$index"; then
  echo "the catalogue is the new one: it counts takes"
else
  echo "the catalogue shows no disk with a count yet: an empty catalogue reads so, and so does one cached a minute"
fi
