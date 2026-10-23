-- The masthead reports total scans as alerts + alive heartbeats, and the
-- "last refreshed" clock considers both.  Alerts already live in feed_stats;
-- this adds the heartbeat counter and keeps it in step with inserts/deletes.
-- The last-alert/last-heartbeat timestamps are read from the indexed
-- notifications table at query time, so they do not need a rollup column.

ALTER TABLE feed_stats ADD COLUMN alive INTEGER NOT NULL DEFAULT 0;

UPDATE feed_stats
   SET alive = (SELECT COUNT(*) FROM notifications
                 WHERE event = 'trustsight.heartbeat');

CREATE TRIGGER notifications_stats_alive_ai
AFTER INSERT ON notifications
WHEN new.event = 'trustsight.heartbeat'
BEGIN
    UPDATE feed_stats SET alive = alive + 1 WHERE id = 1;
END;

CREATE TRIGGER notifications_stats_alive_ad
AFTER DELETE ON notifications
WHEN old.event = 'trustsight.heartbeat'
BEGIN
    UPDATE feed_stats SET alive = alive - 1 WHERE id = 1;
END;
