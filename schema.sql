-- mk2-exchange/schema.sql
--
-- The catalogue (docs/exchange.md §4 in the machine's repository), as a new
-- database is given it. Laid by scripts/catalogue.sh, which runs
-- `wrangler d1 execute jet64-exchange --remote --file schema.sql`; every
-- statement may run again harmlessly. A column added to a table since cannot
-- be: SQLite adds a column once only, so a database laid earlier gains it from
-- migrations/, which the same script runs once.

-- A maker: the name a key claimed on its first publish (§7).
CREATE TABLE IF NOT EXISTS makers (
  name     TEXT PRIMARY KEY,           -- as typed: lowercase letters, digits, - and _
  fold     TEXT NOT NULL UNIQUE,       -- the name with lookalikes folded together
  key      TEXT NOT NULL UNIQUE,       -- the Ed25519 public key, base64url
  created  INTEGER NOT NULL,           -- unix seconds
  revoked  INTEGER NOT NULL DEFAULT 0, -- 1: the key may no longer publish
  vouched  INTEGER NOT NULL DEFAULT 0  -- 1: David's mark beside the name
);

-- A disk: one upload, from quarantine to live (or failed, hidden, yanked, removed).
CREATE TABLE IF NOT EXISTS disks (
  id       TEXT PRIMARY KEY,           -- random, hex
  maker    TEXT NOT NULL,
  sha256   TEXT NOT NULL,              -- of the disk file, as the maker signed it
  bytes    INTEGER NOT NULL,
  state    TEXT NOT NULL,              -- checking | live | failed | hidden | yanked | removed
  reason   TEXT,                       -- why it failed, or who hid or removed it
  name     TEXT,                       -- the cart's name, from its head, once checked
  title    TEXT,
  kind     TEXT,                       -- game | theme | tool
  machine  TEXT,                       -- the machine version it was made on
  version  INTEGER,                    -- 1, 2, ... for each live upload of maker/name
  created  INTEGER NOT NULL,
  checked  INTEGER,
  reports  INTEGER NOT NULL DEFAULT 0,
  about    TEXT NOT NULL DEFAULT ''    -- its maker's one sentence, once checked (migrations/0001)
);
CREATE INDEX IF NOT EXISTS disks_by_state ON disks (state, created);
CREATE INDEX IF NOT EXISTS disks_by_sha ON disks (sha256);
CREATE INDEX IF NOT EXISTS disks_by_cart ON disks (maker, name);

-- Every upload accepted, for the daily caps (§8).
CREATE TABLE IF NOT EXISTS uploads (
  day      TEXT NOT NULL,              -- YYYY-MM-DD, UTC
  key      TEXT NOT NULL,
  ip       TEXT NOT NULL,              -- salted hash of the address, never the address
  bytes    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS uploads_by_day ON uploads (day);
CREATE INDEX IF NOT EXISTS uploads_by_key ON uploads (key);   -- the addresses a banned maker published from

-- The addresses David has banned with a maker: none may publish again until he
-- lifts the maker's ban (migrations/0002).
CREATE TABLE IF NOT EXISTS bans (
  ip       TEXT PRIMARY KEY,           -- salted hash of the address, never the address
  maker    TEXT NOT NULL,              -- the maker banned, whose uploads came from it
  created  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS bans_by_maker ON bans (maker);

-- One report a key a disk (§9).
CREATE TABLE IF NOT EXISTS reports (
  id       TEXT NOT NULL,
  key      TEXT NOT NULL,
  ip       TEXT NOT NULL,
  created  INTEGER NOT NULL,
  PRIMARY KEY (id, key)
);

-- How often a cart has been taken (§10): a cart is a maker's disks of one name,
-- every version together, so a new version keeps the takes of those before it.
CREATE TABLE IF NOT EXISTS takes (
  maker    TEXT NOT NULL,
  name     TEXT NOT NULL,
  takes    INTEGER NOT NULL,
  PRIMARY KEY (maker, name)
) WITHOUT ROWID;

-- Who took which cart today, so a computer counts once a cart a day. Keyed by
-- day first, so the rows of earlier days are found, and swept away, without
-- reading today's.
CREATE TABLE IF NOT EXISTS taken (
  day      TEXT NOT NULL,              -- YYYY-MM-DD, UTC
  maker    TEXT NOT NULL,
  name     TEXT NOT NULL,
  ip       TEXT NOT NULL,              -- salted hash of the address, never the address
  PRIMARY KEY (day, maker, name, ip)
) WITHOUT ROWID;

-- The takes counted today, for the daily cap (§8); an earlier day's row is
-- swept away with its takers.
CREATE TABLE IF NOT EXISTS take_days (
  day      TEXT PRIMARY KEY,           -- YYYY-MM-DD, UTC
  counted  INTEGER NOT NULL
) WITHOUT ROWID;

-- Switches: `paused` = '1' stops every upload.
CREATE TABLE IF NOT EXISTS settings (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
);
