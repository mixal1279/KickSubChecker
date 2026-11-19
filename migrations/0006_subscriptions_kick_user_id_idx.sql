-- Accelerates the exact ID lookup and expiry ordering used by /api/check?user_id=.
CREATE INDEX IF NOT EXISTS idx_subscriptions_broadcaster_user_expiry
  ON subscriptions (broadcaster_id, kick_user_id, expires_at_ms DESC)
  WHERE kick_user_id IS NOT NULL;
