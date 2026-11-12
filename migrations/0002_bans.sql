-- mk2-exchange/migrations/0002_bans.sql
--
-- For a catalogue laid before David could ban a maker: the table of banned
-- addresses, and the index that finds a maker's addresses, in the same words
-- schema.sql now gives them. A new table, unlike a new column, may be made if
-- it is not there, so this is harmless twice and scripts/catalogue.sh runs it
-- every time, as it runs schema.sql.

CREATE INDEX IF NOT EXISTS uploads_by_key ON uploads (key);

CREATE TABLE IF NOT EXISTS bans (
  ip       TEXT PRIMARY KEY,           -- salted hash of the address, never the address
  maker    TEXT NOT NULL,              -- the maker banned, whose uploads came from it
  created  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS bans_by_maker ON bans (maker);
