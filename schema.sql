-- mk2-exchange/schema.sql
--
-- The catalogue (docs/exchange.md §4 in the machine's repository). Applied once
-- with `wrangler d1 execute jet64-exchange --remote --file schema.sql`; every
-- statement may run again harmlessly.

-- A maker: the name a key claimed on its first publish (§7).
CREATE TABLE IF NOT EXISTS makers (
  name     TEXT PRIMARY KEY,           -- as typed: lowercase letters, digits, - and _
  fold     TEXT NOT NULL UNIQUE,       -- the name with lookalikes folded together
  key      TEXT NOT NULL UNIQUE,       -- the Ed25519 public key, base64url
  created  INTEGER NOT NULL,           -- unix seconds
  revoked  INTEGER NOT NULL DEFAULT 0, -- 1: the key may no longer publish
  vouched  INTEGER NOT NULL DEFAULT 0  -- 1: David's mark beside the name
);

-- A disk: one upload, from quarantine to live (or failed, hidden, yanked).
CREATE TABLE IF NOT EXISTS disks (
  id       TEXT PRIMARY KEY,           -- random, hex
  maker    TEXT NOT NULL,
  sha256   TEXT NOT NULL,              -- of the disk file, as the maker signed it
  bytes    INTEGER NOT NULL,
  state    TEXT NOT NULL,              -- checking | live | failed | hidden | yanked
  reason   TEXT,                       -- why it failed, or who hid it
  name     TEXT,                       -- the cart's name, from its head, once checked
  title    TEXT,
  kind     TEXT,                       -- game | theme | tool
  machine  TEXT,                       -- the machine version it was made on
  version  INTEGER,                    -- 1, 2, ... for each live upload of maker/name
  created  INTEGER NOT NULL,
  checked  INTEGER,
  reports  INTEGER NOT NULL DEFAULT 0
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

-- One report a key a disk (§9).
CREATE TABLE IF NOT EXISTS reports (
  id       TEXT NOT NULL,
  key      TEXT NOT NULL,
  ip       TEXT NOT NULL,
  created  INTEGER NOT NULL,
  PRIMARY KEY (id, key)
);

-- Switches: `paused` = '1' stops every upload.
CREATE TABLE IF NOT EXISTS settings (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
);
