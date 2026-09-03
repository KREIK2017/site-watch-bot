ALTER TABLE watches ADD COLUMN price_trusted INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS steam_cache (
  app_id TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  fetched_at TEXT NOT NULL
);

-- One-off cleanup: bot-challenge page titles ("Just a moment...", Cloudflare's
-- JS-challenge interstitial) got saved as product names before analyzeUrl
-- started gating title extraction on a successful (2xx) status.
UPDATE watches SET label = NULL WHERE label = 'Just a moment...';
