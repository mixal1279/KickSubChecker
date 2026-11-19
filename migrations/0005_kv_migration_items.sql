-- Idempotencja rekordów importowanych z KV. Marker i rekord docelowy zapisujemy atomowo.
CREATE TABLE IF NOT EXISTS migration_items (
  broadcaster_id TEXT NOT NULL,
  phase TEXT NOT NULL,
  source_key TEXT NOT NULL,
  imported_at_ms INTEGER NOT NULL,
  PRIMARY KEY (broadcaster_id, phase, source_key),
  FOREIGN KEY (broadcaster_id) REFERENCES channels(broadcaster_id) ON DELETE CASCADE,
  CHECK (phase IN ('links', 'subscriptions'))
);
