#!/usr/bin/env bash
# mk2-exchange/scripts/catalogue.sh
#
# Lays the catalogue in the D1 database, or brings one laid earlier up to the
# shape schema.sql gives a new one. Safe to run again: schema.sql's statements
# are harmless twice, and so is each migration that makes a table, and one that
# adds a column runs only where a look finds its work not yet done. Run where wrangler is, from the repository's top; deploy.sh
# and tests/e2e.sh both lay their database through it.
#
#   scripts/catalogue.sh --remote     the live database (wants CLOUDFLARE_API_TOKEN)
#   scripts/catalogue.sh --local      wrangler dev's own
set -euo pipefail

readonly DATABASE=jet64-exchange
where="${1:-}"
[ "$where" = --local ] || [ "$where" = --remote ] || { echo "usage: scripts/catalogue.sh --local|--remote" >&2; exit 2; }

d1() { npx wrangler d1 execute "$DATABASE" "$where" --yes "$@" > /dev/null; }
# Whether the database answers a question at all: it refuses one about a column it lacks.
answers() { d1 --command "$1" 2> /dev/null; }

d1 --file schema.sql
# A column cannot be added twice, so schema.sql cannot add one to a table that
# is already there. Each column it has gained since is added here, once. Should
# the look fail for a reason of its own, the migration is refused as a column
# already there, and nothing is harmed.
answers "SELECT about FROM disks LIMIT 0" || d1 --file migrations/0001_disks_about.sql
# A table or an index may be made where it is not, so these run every time,
# harmless twice, as schema.sql is.
d1 --file migrations/0002_bans.sql
