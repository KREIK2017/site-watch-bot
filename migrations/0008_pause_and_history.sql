ALTER TABLE watches ADD COLUMN paused INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS watch_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  watch_id INTEGER NOT NULL,
  price TEXT,
  stock TEXT,
  status INTEGER,
  checked_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_watch_history_watch ON watch_history(watch_id, checked_at);
