#!/usr/bin/env bash
# mk2-exchange/scripts/release-validator.sh
#
# Builds the validator, the machine's own mk2disk, for the GitHub runner
# (Linux x86-64, glibc 2.35 or later) from a checkout of the machine, in the
# machine's own Linux build image, and prints the SHA-256 to pin in
# .github/workflows/check.yml. With --release <version>, also publishes it as
# this repository's release `validator-<version>`.
#
#   scripts/release-validator.sh <path to jet64/mk2> [--release 0.4.0]
#
# A validator refuses disks made on a newer machine, so release one with every
# machine version the island ships.
set -euo pipefail

mk2="$(cd "$1" && pwd)"
out="$(mktemp -d)"
docker run --rm --platform linux/amd64 -v "$mk2":/mk2:ro -v "$out":/out mk2-present-linux:amd64 sh -c '
  mkdir /tmp/m && cd /mk2 && tar cf - --exclude=./build --exclude=./.deps . | tar xf - -C /tmp/m &&
  cd /tmp/m && make -s OUT=/tmp/b /tmp/b/mk2disk >/tmp/log 2>&1 || { tail -20 /tmp/log; exit 1; }
  cp /tmp/b/mk2disk /out/mk2disk-linux-x86_64'
sha256="$(shasum -a 256 "$out/mk2disk-linux-x86_64" | cut -c1-64)"
echo "built $out/mk2disk-linux-x86_64"
echo "VALIDATOR_SHA256: $sha256"
if [ "${2:-}" = "--release" ]; then
  gh release create "validator-$3" "$out/mk2disk-linux-x86_64" --repo jet64-carts/mk2-exchange \
    --title "Validator $3" --notes "mk2disk for Linux x86-64, SHA-256 $sha256"
fi
