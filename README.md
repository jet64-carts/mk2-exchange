# The Jet64 Mk II exchange

Where people swap disks. A maker ticks EXCHANGE in the island's EXPORT; the disk
file streams through this Worker into a private R2 bucket; a GitHub Action runs
the machine's own validator over it; and within about a minute it is on the
board for everyone to TAKE.

- **`src/`** — the Worker, the only door (routes listed at the top of
  `src/index.ts`). It never parses a disk.
- **`schema.sql`** — the D1 catalogue: makers, disks, uploads, reports.
- **`.github/workflows/check.yml`** — the validator: one job reads the stranger's
  disk with no permissions and no secrets, a second hands the verdict back.
  The one action used is pinned by its commit SHA, the runner by its image.
- **`scripts/exchange.mjs`** — a client in one file: keys, publish, take,
  report, and the sysop's switches.
- **`tests/e2e.sh`** — the whole exchange on one machine, the validator run by hand.

## What it costs

Nothing, on Cloudflare's free plan, which refuses past its limits rather than
billing: the Worker stops at 100,000 requests a day, D1 at its daily quotas, and
the Worker's own caps (1,000 uploads and 1 GB a day, 10 a key, 20 an address)
keep R2 inside its free 10 GB, 1 million writes and 10 million reads a month.
Never move the account to Workers Paid without changing the caps first.

## Setting it up

Once, on a Mac with Docker and `gh`:

1. **A Cloudflare API token.** Cloudflare → My Profile → API Tokens → Create
   Token → *Edit Cloudflare Workers* template; add **Account · D1 · Edit**;
   account resources: your account; zone resources: jet64.com. Copy the token.
2. **The validator's release.** From this folder:
   `scripts/release-validator.sh ../jet64/mk2 --release 0.4.0`, and check the
   SHA-256 it prints is the one in `check.yml`.
3. **A GitHub token that may only start the validator.** GitHub → Settings →
   Developer settings → Fine-grained tokens → Generate: repository access *only
   jet64-carts/mk2-exchange*; permissions **Actions: Read and write**, nothing
   else. Copy it; `deploy.sh` asks for it.
4. **Deploy:** `CLOUDFLARE_API_TOKEN=<token> scripts/deploy.sh`. It makes the
   sysop key (`sysop.key`: keep a copy somewhere safe), the bucket, the database
   and the secrets, deploys to `exchange.jet64.com`, and edits `wrangler.toml`,
   which you then commit.
5. **A budget alert at $1** (Billing → Billable Usage → Create budget alert), so
   any bill at all is an email at once.

## Day to day

Nothing per disk. When something is reported (`hidden` lists them):

```console
$ node scripts/exchange.mjs sysop sysop.key hidden
$ node scripts/exchange.mjs sysop sysop.key unhide <id>     # it was fine
$ node scripts/exchange.mjs sysop sysop.key yank <id>       # it was not
$ node scripts/exchange.mjs sysop sysop.key pause           # stop every upload
$ node scripts/exchange.mjs sysop sysop.key vouch <maker>   # the ✓ beside a name
```

Without Node on the Mac, run any of these as
`docker run --rm -v "$PWD":/x -w /x node:22-bookworm node scripts/exchange.mjs ...`.

## Testing

```console
$ docker run --rm --platform linux/amd64 -v "$PWD":/x -w /x -v <folder>:/v node:22-bookworm bash tests/e2e.sh
```

where `<folder>` holds `mk2disk-linux-x86_64`, `small.disk.png` (a whole disk
under 4 MiB) and `large.disk.png` (one over 4 MiB).
