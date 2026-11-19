-- D1 permits NULL in a TEXT PRIMARY KEY for legacy rowid tables.
-- Keep the existing table and rows; reject NULL at the database boundary.
CREATE TRIGGER IF NOT EXISTS channels_broadcaster_id_required_insert
BEFORE INSERT ON channels
FOR EACH ROW
WHEN NEW.broadcaster_id IS NULL
BEGIN
  SELECT RAISE(ABORT, 'channels.broadcaster_id is required');
END;

CREATE TRIGGER IF NOT EXISTS channels_broadcaster_id_required_update
BEFORE UPDATE OF broadcaster_id ON channels
FOR EACH ROW
WHEN NEW.broadcaster_id IS NULL
BEGIN
  SELECT RAISE(ABORT, 'channels.broadcaster_id is required');
END;
