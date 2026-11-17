-- mk2-exchange/migrations/0003_review.sql
--
-- For a catalogue laid before the exchange reviewed every disk (R85 in the
-- machine's repository, docs/exchange_review.md): the hash of the file its maker
-- sent, kept beside the hash of the disk the checker built afresh, and the facts
-- the checker found for the reviewer, in the same words schema.sql now gives
-- them. A column can be added only once, so scripts/catalogue.sh runs this only
-- where it finds no `facts`.

ALTER TABLE disks ADD COLUMN sent TEXT;
ALTER TABLE disks ADD COLUMN facts TEXT NOT NULL DEFAULT '[]';
