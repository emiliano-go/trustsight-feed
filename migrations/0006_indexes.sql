-- The list endpoints filter by event or day and then order by time.  A
-- single-column index made SQLite scan every row of the other events before
-- it found enough matches (a heartbeat filter walked the whole alert table).
-- Lead with the filter, then time, so the keyset order comes out of the index.
CREATE INDEX idx_notifications_event_time ON notifications (event, time DESC);
CREATE INDEX idx_notifications_day_time ON notifications (day, time DESC);

-- Superseded by the composites above; dropping them saves write and storage
-- cost on every ingest.
DROP INDEX IF EXISTS idx_notifications_event;
DROP INDEX IF EXISTS idx_notifications_day;
