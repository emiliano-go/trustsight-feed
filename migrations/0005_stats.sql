-- A one-row rollup of the figures /api/stats publishes, maintained by
-- triggers.  The old query counted and summed every alert row on every call;
-- the feed page polls it every 30 seconds, so that scan alone could exhaust a
-- free D1 database.  Reads here are one row.
--
-- Semantics mirror the old aggregate exactly: total/first/sums cover
-- `trustsight.alerts` rows, while `last` is the newest notification of any
-- event (a heartbeat proves the watcher is alive).

CREATE TABLE feed_stats (
    id                INTEGER PRIMARY KEY CHECK (id = 1),
    total             INTEGER NOT NULL DEFAULT 0,
    first             INTEGER,
    last              INTEGER,
    alerts            INTEGER NOT NULL DEFAULT 0,
    over_threshold    INTEGER NOT NULL DEFAULT 0,
    ioc               INTEGER NOT NULL DEFAULT 0,
    impersonation     INTEGER NOT NULL DEFAULT 0
);

INSERT INTO feed_stats (id, total, first, last, alerts, over_threshold, ioc, impersonation)
SELECT 1,
       COUNT(*),
       MIN(time),
       (SELECT MAX(time) FROM notifications),
       COALESCE(SUM(n_alerts), 0),
       COALESCE(SUM(n_over_threshold), 0),
       COALESCE(SUM(n_ioc), 0),
       COALESCE(SUM(n_impersonation), 0)
  FROM notifications
 WHERE event = 'trustsight.alerts';

CREATE TRIGGER notifications_stats_ai AFTER INSERT ON notifications BEGIN
    UPDATE feed_stats SET
        total = total + (new.event = 'trustsight.alerts'),
        first = CASE
            WHEN new.event = 'trustsight.alerts'
             AND (first IS NULL OR new.time < first) THEN new.time
            ELSE first
        END,
        last = CASE
            WHEN last IS NULL OR new.time > last THEN new.time
            ELSE last
        END,
        alerts = alerts + CASE WHEN new.event = 'trustsight.alerts' THEN new.n_alerts ELSE 0 END,
        over_threshold = over_threshold + CASE WHEN new.event = 'trustsight.alerts' THEN new.n_over_threshold ELSE 0 END,
        ioc = ioc + CASE WHEN new.event = 'trustsight.alerts' THEN new.n_ioc ELSE 0 END,
        impersonation = impersonation + CASE WHEN new.event = 'trustsight.alerts' THEN new.n_impersonation ELSE 0 END
     WHERE id = 1;
END;

CREATE TRIGGER notifications_stats_ad AFTER DELETE ON notifications BEGIN
    UPDATE feed_stats SET
        total = total - (old.event = 'trustsight.alerts'),
        first = CASE
            WHEN old.event = 'trustsight.alerts' AND old.time = first
            THEN (SELECT MIN(time) FROM notifications WHERE event = 'trustsight.alerts')
            ELSE first
        END,
        last = CASE
            WHEN old.time = last THEN (SELECT MAX(time) FROM notifications)
            ELSE last
        END,
        alerts = alerts - CASE WHEN old.event = 'trustsight.alerts' THEN old.n_alerts ELSE 0 END,
        over_threshold = over_threshold - CASE WHEN old.event = 'trustsight.alerts' THEN old.n_over_threshold ELSE 0 END,
        ioc = ioc - CASE WHEN old.event = 'trustsight.alerts' THEN old.n_ioc ELSE 0 END,
        impersonation = impersonation - CASE WHEN old.event = 'trustsight.alerts' THEN old.n_impersonation ELSE 0 END
     WHERE id = 1;
END;
