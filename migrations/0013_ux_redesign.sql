ALTER TABLE watches ADD COLUMN monitor_state TEXT NOT NULL DEFAULT 'UNKNOWN';
ALTER TABLE watches ADD COLUMN last_success_at TEXT;
ALTER TABLE watches ADD COLUMN last_attempt_at TEXT;
ALTER TABLE watches ADD COLUMN last_state_notified_at TEXT;

UPDATE watches
SET monitor_state = CASE
  WHEN paused = 1 THEN 'PAUSED'
  WHEN last_error IS NOT NULL THEN 'UNKNOWN'
  WHEN last_status BETWEEN 200 AND 299 THEN 'ONLINE'
  WHEN last_status BETWEEN 300 AND 399 THEN 'DEGRADED'
  WHEN last_status IS NOT NULL THEN 'OFFLINE'
  ELSE 'UNKNOWN'
END,
last_attempt_at = last_checked_at,
last_success_at = CASE WHEN last_error IS NULL AND last_status BETWEEN 200 AND 399 THEN last_checked_at ELSE NULL END;

CREATE TABLE IF NOT EXISTS monitor_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  watch_id INTEGER NOT NULL,
  chat_id INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  from_state TEXT,
  to_state TEXT,
  details TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_monitor_events_chat ON monitor_events(chat_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_monitor_events_watch ON monitor_events(watch_id, created_at DESC);

CREATE TABLE IF NOT EXISTS add_sessions (
  chat_id INTEGER PRIMARY KEY,
  monitor_type TEXT NOT NULL,
  step TEXT NOT NULL,
  url TEXT,
  draft_json TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

ALTER TABLE chat_settings ADD COLUMN blocked_reminder_hours INTEGER NOT NULL DEFAULT 24;
