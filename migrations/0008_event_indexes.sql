-- Normalized event indexes derived from the stored notification payload.
--
-- The notification payload stays the source of truth.  These tables make the
-- campaign, maintainer and IOC pages a bounded indexed read instead of a scan
-- over every payload.  They are written by `worker/store.js` in the same D1
-- batch as the notification, and re-ingest is idempotent.

CREATE TABLE campaign_events (
    campaign_id TEXT NOT NULL,
    rule_id     TEXT NOT NULL,
    package     TEXT NOT NULL,
    time        INTEGER NOT NULL,
    slug        TEXT NOT NULL,
    maintainer  TEXT NOT NULL DEFAULT '',
    previous_maintainer TEXT NOT NULL DEFAULT '',
    version     TEXT NOT NULL DEFAULT '',
    legacy      INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (campaign_id, slug, package)
);
CREATE INDEX idx_campaign_events_time ON campaign_events (campaign_id, time DESC);
CREATE INDEX idx_campaign_events_rule ON campaign_events (rule_id, time DESC);

CREATE TABLE maintainer_events (
    maintainer_key      TEXT NOT NULL,
    maintainer          TEXT NOT NULL,
    package             TEXT NOT NULL,
    previous_maintainer TEXT NOT NULL DEFAULT '',
    rule_id             TEXT NOT NULL,
    time                INTEGER NOT NULL,
    slug                TEXT NOT NULL,
    PRIMARY KEY (maintainer_key, slug, package, rule_id)
);
CREATE INDEX idx_maintainer_events_time ON maintainer_events (maintainer_key, time DESC);
CREATE INDEX idx_maintainer_events_pkg ON maintainer_events (package, time DESC);

CREATE TABLE ioc_events (
    indicator TEXT NOT NULL,
    package   TEXT NOT NULL,
    time      INTEGER NOT NULL,
    slug      TEXT NOT NULL,
    PRIMARY KEY (indicator, package, slug)
);
CREATE INDEX idx_ioc_events_time ON ioc_events (time DESC);
CREATE INDEX idx_ioc_events_package ON ioc_events (package, time DESC);
