-- Cut the row reads the public endpoints spend on aggregates and filters.
--
-- `/api/stats` counted campaign_events, maintainer_events and ioc_events on
-- every call; each is a full scan, and the feed page asks for stats on every
-- visit.  The counts are now maintained incrementally by triggers beside the
-- notification counters, so the endpoint reads one row.
--
-- The feed toggles `campaigns=1`, `refusals=1`, `over=1` and `ioc=1` filtered
-- on a JSON extract or an unindexed column, so each was a scan of every
-- stored notification.  The two that had no column get one, and each filter
-- gets a partial index over the matching rows so the ordered walk reads only
-- candidates.

ALTER TABLE notifications ADD COLUMN n_campaigns INTEGER NOT NULL DEFAULT 0;
ALTER TABLE notifications ADD COLUMN n_refusals INTEGER NOT NULL DEFAULT 0;

UPDATE notifications SET
    n_campaigns = COALESCE(json_array_length(json_extract(payload, '$.campaign_cluster')), 0),
    n_refusals = COALESCE(json_array_length(json_extract(payload, '$.refusals')), 0);

CREATE INDEX idx_notifications_over_time
    ON notifications (time DESC) WHERE n_over_threshold > 0;
CREATE INDEX idx_notifications_ioc_time
    ON notifications (time DESC) WHERE n_ioc > 0;
CREATE INDEX idx_notifications_campaigns_time
    ON notifications (time DESC) WHERE n_campaigns > 0;
CREATE INDEX idx_notifications_refusals_time
    ON notifications (time DESC) WHERE n_refusals > 0;

ALTER TABLE feed_stats ADD COLUMN campaign_events INTEGER NOT NULL DEFAULT 0;
ALTER TABLE feed_stats ADD COLUMN maintainer_events INTEGER NOT NULL DEFAULT 0;
ALTER TABLE feed_stats ADD COLUMN ioc_events INTEGER NOT NULL DEFAULT 0;

UPDATE feed_stats SET
    campaign_events = (SELECT COUNT(*) FROM campaign_events),
    maintainer_events = (SELECT COUNT(*) FROM maintainer_events),
    ioc_events = (SELECT COUNT(*) FROM ioc_events)
WHERE id = 1;

CREATE TRIGGER campaign_events_budget_ai AFTER INSERT ON campaign_events BEGIN
    UPDATE feed_stats SET campaign_events = campaign_events + 1 WHERE id = 1;
END;
CREATE TRIGGER campaign_events_budget_ad AFTER DELETE ON campaign_events BEGIN
    UPDATE feed_stats SET campaign_events = campaign_events - 1 WHERE id = 1;
END;

CREATE TRIGGER maintainer_events_budget_ai AFTER INSERT ON maintainer_events BEGIN
    UPDATE feed_stats SET maintainer_events = maintainer_events + 1 WHERE id = 1;
END;
CREATE TRIGGER maintainer_events_budget_ad AFTER DELETE ON maintainer_events BEGIN
    UPDATE feed_stats SET maintainer_events = maintainer_events - 1 WHERE id = 1;
END;

CREATE TRIGGER ioc_events_budget_ai AFTER INSERT ON ioc_events BEGIN
    UPDATE feed_stats SET ioc_events = ioc_events + 1 WHERE id = 1;
END;
CREATE TRIGGER ioc_events_budget_ad AFTER DELETE ON ioc_events BEGIN
    UPDATE feed_stats SET ioc_events = ioc_events - 1 WHERE id = 1;
END;

UPDATE meta SET value = '16' WHERE key = 'schema';
