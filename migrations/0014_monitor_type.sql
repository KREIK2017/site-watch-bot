ALTER TABLE watches ADD COLUMN monitor_type TEXT NOT NULL DEFAULT 'auto';

UPDATE watches
SET monitor_type = CASE
  WHEN last_price IS NOT NULL OR last_stock IS NOT NULL OR last_seller IS NOT NULL THEN 'product'
  ELSE 'site'
END
WHERE monitor_type = 'auto';
