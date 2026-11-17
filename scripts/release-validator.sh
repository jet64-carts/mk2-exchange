#!/usr/bin/env bash
# mk2-exchange/scripts/release-validator.sh
#
# Builds the validator for the GitHub runner (Linux x86-64, glibc 2.35 or
# later) from a checkout of the machine, in the machine's own Linux build image:
# the machine's mk2disk, whose `vet` checks a disk and builds its game afresh
# from its C, and beside it the machine's sources that build reads, as the
# Makefile names them once (BUILD_MACHINE), with the face a drawn label is set
# in. One archive, mk2-validator-linux-x86_64.tar.gz; prints the SHA-256 to pin
# in .github/workflows/check.yml. With --release <version>, also publishes it
# as this repository's release `validator-<version>`.
#
#   scripts/release-validator.sh <path to jet64/mk2> [--release 0.4.0-4]
#
# A validator refuses disks made on a newer machine, and builds with the
# firmware it carries, so release one with every machine version the island ships.
set -euo pipefail

readonly ASSET=mk2-validator-linux-x86_64.tar.gz
mk2="$(cd "$1" && pwd)"
out="$(mktemp -d)"
docker run --rm --platform linux/amd64 -v "$mk2":/mk2:ro -v "$out":/out mk2-present-linux:amd64 sh -c '
  mkdir /tmp/m && cd /mk2 && tar cf - --exclude=./build --exclude=./.deps . | tar xf - -C /tmp/m &&
  cd /tmp/m && make -s OUT=/tmp/b /tmp/b/mk2disk >/tmp/log 2>&1 || { tail -60 /tmp/log; exit 1; }
  sources="$(make -s --no-print-directory --eval "print-build-machine: ; @echo \$(BUILD_MACHINE)" print-build-machine)" &&
  mkdir /tmp/v && cp /tmp/b/mk2disk /tmp/v/ &&
  tar cf - $sources font/faces/monogram | tar xf - -C /tmp/v &&
  tar czf /out/'"$ASSET"' --owner=0 --group=0 --mtime=1980-01-01 --sort=name -C /tmp/v .'
sha256="$(shasum -a 256 "$out/$ASSET" | cut -c1-64)"
echo "built $out/$ASSET"
echo "VALIDATOR_SHA256: $sha256"
if [ "${2:-}" = "--release" ]; then
  gh release create "validator-$3" "$out/$ASSET" --repo jet64-carts/mk2-exchange \
    --title "Validator $3" --notes "mk2disk for Linux x86-64 with the machine's sources a build reads, SHA-256 $sha256"
fi
