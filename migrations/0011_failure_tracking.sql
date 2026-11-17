ALTER TABLE watches ADD COLUMN consecutive_failures INTEGER NOT NULL DEFAULT 0;
ALTER TABLE watches ADD COLUMN last_error TEXT;

-- A Reader challenge was briefly accepted as a successful page before strict
-- response validation was added. Remove those synthetic labels so the next
-- successful check restores the real product title.
UPDATE watches
SET label = NULL
WHERE lower(trim(label)) IN ('just a moment...', 'access denied', 'allegro.pl');
