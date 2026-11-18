-- Fencing token i odnawialny lease chronią przed spóźnioną instancją Workera.
ALTER TABLE webhook_events ADD COLUMN lease_token TEXT;
ALTER TABLE webhook_events ADD COLUMN lease_expires_at_ms INTEGER;
