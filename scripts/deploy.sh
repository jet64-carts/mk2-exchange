#!/usr/bin/env bash
# mk2-exchange/scripts/deploy.sh
#
# Sets the exchange up on Cloudflare and deploys it, from a Mac with Docker and
# gh, with nothing else installed: wrangler runs in a Node container. Safe to run
# again; each step that is done already is passed over. The first run:
#
#   - makes the sysop key, sysop.key, beside this script's repository (keep a copy
#     somewhere safe: it is the only key that can yank a disk or pause uploads),
#     and writes its public half into wrangler.toml;
#   - makes the private R2 bucket and the D1 database, and lays the schema;
#   - sets the Worker's three secrets, and the repository's VERDICT_TOKEN, asking
#     only for the GitHub token that may start the validator;
#   - deploys to exchange.jet64.com.
#
#   CLOUDFLARE_API_TOKEN=... scripts/deploy.sh
set -euo pipefail

: "${CLOUDFLARE_API_TOKEN:?set CLOUDFLARE_API_TOKEN to the token made in Cloudflare (see README)}"
readonly REPO=jet64-carts/mk2-exchange
readonly NODE_IMAGE=node:22-bookworm
readonly ZERO_ID=00000000-0000-0000-0000-000000000000
cd "$(dirname "$0")/.."

in_node() { docker run --rm -i --platform linux/amd64 -e CLOUDFLARE_API_TOKEN -v "$PWD":/x -w /x "$NODE_IMAGE" "$@"; }
wrangler() { in_node npx wrangler "$@"; }

echo "== tools"
in_node npm ci --silent --no-audit --no-fund

echo "== the sysop key"
if [ ! -f sysop.key ]; then
  public=$(in_node node scripts/exchange.mjs key sysop.key)
  sed -i '' "s|^SYSOP_KEY = \".*\"|SYSOP_KEY = \"$public\"|" wrangler.toml
  echo "made sysop.key: copy it somewhere safe now"
fi

echo "== the bucket"
buckets=$(wrangler r2 bucket list 2>/dev/null || true)
grep -q "jet64-exchange-disks" <<<"$buckets" || wrangler r2 bucket create jet64-exchange-disks

echo "== the database"
if grep -q "database_id = \"$ZERO_ID\"" wrangler.toml; then
  id=$(wrangler d1 create jet64-exchange 2>&1 | grep -oE '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' | head -1)
  [ -n "$id" ] || { echo "the database could not be made"; exit 1; }
  sed -i '' "s|database_id = \"$ZERO_ID\"|database_id = \"$id\"|" wrangler.toml
fi
wrangler d1 execute jet64-exchange --remote --file schema.sql --yes > /dev/null

echo "== the secrets"
if [ ! -f .secrets-set ]; then
  verdict=$(openssl rand -hex 32)
  printf '%s' "$verdict" | wrangler secret put VERDICT_TOKEN
  gh secret set VERDICT_TOKEN --repo "$REPO" --body "$verdict"
  openssl rand -hex 32 | tr -d '\n' | wrangler secret put IP_SALT
  read -rsp "The GitHub token that may start the validator (README step 3): " github
  echo
  printf '%s' "$github" | wrangler secret put GITHUB_TOKEN
  touch .secrets-set
fi

echo "== deploy"
wrangler deploy
curl -fsS https://exchange.jet64.com/ && echo
echo "deployed. Commit wrangler.toml, which now names the database and the sysop key."
