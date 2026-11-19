-- Rozszerzenie źródeł subskrypcji o wartości używane przez dotychczasowy backend KV.
-- Migracja zachowuje istniejące rekordy i indeksy; nie dotyka danych KV.
CREATE TABLE subscriptions_new (
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
    'gift',
    'new',
    'renewal',
    'admin'
  ))
);

INSERT INTO subscriptions_new (
  broadcaster_id, subscriber_key, kick_user_id, kick_username,
  expires_at_ms, source, updated_at_ms
)
SELECT
  broadcaster_id, subscriber_key, kick_user_id, kick_username,
  expires_at_ms, source, updated_at_ms
FROM subscriptions;

DROP TABLE subscriptions;
ALTER TABLE subscriptions_new RENAME TO subscriptions;

CREATE INDEX IF NOT EXISTS idx_subscriptions_username
  ON subscriptions (broadcaster_id, kick_username COLLATE NOCASE);

CREATE INDEX IF NOT EXISTS idx_subscriptions_expiry
  ON subscriptions (broadcaster_id, expires_at_ms);
