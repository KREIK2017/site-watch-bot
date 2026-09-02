CREATE TABLE IF NOT EXISTS watches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id INTEGER NOT NULL,
  url TEXT NOT NULL,
  label TEXT,
  last_status INTEGER,
  last_hash TEXT,
  last_price TEXT,
  last_stock TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_checked_at TEXT,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_watches_active ON watches(active);
CREATE INDEX IF NOT EXISTS idx_watches_chat ON watches(chat_id);
