-- Trwały stan importu KV -> D1. Jeden aktywny przebieg na kanał.
CREATE TABLE IF NOT EXISTS migration_runs (
  broadcaster_id TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'running',
  phase TEXT NOT NULL DEFAULT 'links',
  cursor TEXT,
  counts_json TEXT NOT NULL DEFAULT '{}',
  lease_token TEXT,
  lease_expires_at_ms INTEGER,
  started_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  completed_at_ms INTEGER,
  FOREIGN KEY (broadcaster_id) REFERENCES channels(broadcaster_id) ON DELETE CASCADE,
  CHECK (status IN ('running', 'completed', 'failed')),
  CHECK (phase IN ('links', 'subscriptions', 'completed'))
);
CREATE INDEX IF NOT EXISTS idx_migration_runs_status
  ON migration_runs (status, lease_expires_at_ms);
