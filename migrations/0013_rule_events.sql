-- Every rule firing, normalized for trigger extraction: one row per package,
-- rule and located finding.  The notification payload remains the source of
-- truth; this table makes `/api/triggers` and campaign drill-down an indexed
-- read instead of a payload scan.
CREATE TABLE rule_events (
    package     TEXT NOT NULL,
    rule_id     TEXT NOT NULL,
    severity    TEXT NOT NULL DEFAULT '',
    weight      INTEGER NOT NULL DEFAULT 0,
    file        TEXT NOT NULL DEFAULT '',
    line        INTEGER,
    reason      TEXT NOT NULL DEFAULT '',
    source      TEXT NOT NULL DEFAULT '',
    campaign_id TEXT NOT NULL DEFAULT '',
    time        INTEGER NOT NULL,
    slug        TEXT NOT NULL,
    id          INTEGER PRIMARY KEY
);
CREATE UNIQUE INDEX idx_rule_events_dedupe ON rule_events
    (slug, package, rule_id, source, file, COALESCE(line, -1), reason);
CREATE INDEX idx_rule_events_rule_time ON rule_events (rule_id, time DESC);
CREATE INDEX idx_rule_events_package_time ON rule_events (package, time DESC);
CREATE INDEX idx_rule_events_campaign_time ON rule_events (campaign_id, time DESC);
CREATE INDEX idx_rule_events_time ON rule_events (time DESC);

-- The rule index needs a full re-scan of notifications stored before this
-- table existed; the old rowid marker would otherwise skip them.
UPDATE meta SET value = '13' WHERE key = 'schema';
