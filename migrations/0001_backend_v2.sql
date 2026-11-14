-- KickSubChecker v2: durable, relational state.
-- All durable records are scoped by Kick broadcaster to prevent cross-channel leakage.
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS channels (
  broadcaster_id TEXT PRIMARY KEY,
  broadcaster_username TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS guild_configs (
  broadcaster_id TEXT NOT NULL,
  guild_id TEXT NOT NULL,
  subscriber_role_id TEXT NOT NULL,
  configured_by_discord_id TEXT,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY (broadcaster_id, guild_id),
  FOREIGN KEY (broadcaster_id) REFERENCES channels(broadcaster_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS account_links (
  broadcaster_id TEXT NOT NULL,
  discord_user_id TEXT NOT NULL,
  kick_user_id TEXT NOT NULL,
  kick_username TEXT NOT NULL,
  linked_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY (broadcaster_id, discord_user_id),
  UNIQUE (broadcaster_id, kick_user_id),
  FOREIGN KEY (broadcaster_id) REFERENCES channels(broadcaster_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_account_links_kick_username
  ON account_links (broadcaster_id, kick_username COLLATE NOCASE);

CREATE TABLE IF NOT EXISTS subscriptions (
  broadcaster_id TEXT NOT NULL,
  subscriber_key TEXT NOT NULL,
  kick_user_id TEXT,
  kick_username TEXT NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  source TEXT NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY (broadcaster_id, subscriber_key),
  FOREIGN KEY (broadcaster_id) REFERENCES channels(broadcaster_id) ON DELETE CASCADE,
  CHECK (expires_at_ms > 0),
  CHECK (source IN (
    'channel.subscription.new',
    'channel.subscription.renewal',
    'channel.subscription.gifts',
    'admin'
  ))
);

CREATE INDEX IF NOT EXISTS idx_subscriptions_username
  ON subscriptions (broadcaster_id, kick_username COLLATE NOCASE);

CREATE INDEX IF NOT EXISTS idx_subscriptions_expiry
  ON subscriptions (broadcaster_id, expires_at_ms);

CREATE TABLE IF NOT EXISTS webhook_events (
  broadcaster_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'processing',
  received_at_ms INTEGER NOT NULL,
  processed_at_ms INTEGER,
  PRIMARY KEY (broadcaster_id, event_id),
  FOREIGN KEY (broadcaster_id) REFERENCES channels(broadcaster_id) ON DELETE CASCADE,
  CHECK (status IN ('processing', 'processed', 'failed'))
);

CREATE INDEX IF NOT EXISTS idx_webhook_events_status
  ON webhook_events (broadcaster_id, status, received_at_ms);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  broadcaster_id TEXT NOT NULL,
  actor_type TEXT NOT NULL,
  actor_id TEXT,
  action TEXT NOT NULL,
  target_type TEXT,
  target_id TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at_ms INTEGER NOT NULL,
  FOREIGN KEY (broadcaster_id) REFERENCES channels(broadcaster_id) ON DELETE CASCADE,
  CHECK (actor_type IN ('system', 'admin', 'discord_user'))
);

CREATE INDEX IF NOT EXISTS idx_audit_log_channel_created
  ON audit_log (broadcaster_id, created_at_ms DESC);
