CREATE TABLE IF NOT EXISTS chat_settings (
  chat_id INTEGER PRIMARY KEY,
  currency TEXT
);

CREATE TABLE IF NOT EXISTS fx_rates (
  pair TEXT PRIMARY KEY,
  rate REAL NOT NULL,
  fetched_at TEXT NOT NULL
);
