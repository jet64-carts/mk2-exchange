-- mk2-exchange/migrations/0001_disks_about.sql
--
-- For a catalogue laid before a disk had its maker's sentence: the column
-- schema.sql now gives `disks`, in the same words and the same place, last.
-- SQLite will not add a column twice, so unlike schema.sql this may run once
-- only; scripts/catalogue.sh runs it where it finds the column missing.

ALTER TABLE disks ADD COLUMN about TEXT NOT NULL DEFAULT '';
