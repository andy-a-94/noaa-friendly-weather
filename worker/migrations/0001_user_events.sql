CREATE TABLE IF NOT EXISTS user_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_time TEXT NOT NULL,
  user_id TEXT NOT NULL,
  session_id TEXT,
  event_type TEXT NOT NULL,
  action TEXT,
  target TEXT,
  page TEXT,
  search_query TEXT,
  location_label TEXT,
  location_lat REAL,
  location_lon REAL,
  user_lat REAL,
  user_lon REAL,
  device_type TEXT,
  user_agent TEXT,
  ip_hash TEXT,
  metadata_json TEXT
);

CREATE INDEX IF NOT EXISTS idx_user_events_event_time ON user_events(event_time);
CREATE INDEX IF NOT EXISTS idx_user_events_user_id ON user_events(user_id);
CREATE INDEX IF NOT EXISTS idx_user_events_event_type ON user_events(event_type);
