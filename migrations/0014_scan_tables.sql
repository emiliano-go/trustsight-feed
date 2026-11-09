-- All-scan analytics.  Scan documents are signed feed-only events produced
-- beside the alert stream; they never enter notifications, FTS or feed_stats.
-- Raw events are recent drill-down data.  Complete old days are squashed into
-- the scan_daily_* rollups, so the public dashboard keeps its history while
-- the raw table stays bounded.

CREATE TABLE scan_cycles (
    cycle_id       TEXT PRIMARY KEY,
    started_at     TEXT NOT NULL DEFAULT '',
    finished_at    TEXT NOT NULL DEFAULT '',
    received_at    INTEGER NOT NULL,
    tool_version   TEXT NOT NULL DEFAULT '',
    partial        INTEGER NOT NULL DEFAULT 0,
    bootstrap      INTEGER NOT NULL DEFAULT 0,
    backfill_day   TEXT NOT NULL DEFAULT '',
    chunk_count    INTEGER NOT NULL DEFAULT 0,
    chunks_received INTEGER NOT NULL DEFAULT 0,
    complete       INTEGER NOT NULL DEFAULT 0,
    attempted      INTEGER NOT NULL DEFAULT 0,
    succeeded      INTEGER NOT NULL DEFAULT 0,
    fetch_failed   INTEGER NOT NULL DEFAULT 0,
    not_vetted     INTEGER NOT NULL DEFAULT 0,
    vanished       INTEGER NOT NULL DEFAULT 0,
    reserved       INTEGER NOT NULL DEFAULT 0,
    with_diff      INTEGER NOT NULL DEFAULT 0,
    alerts         INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_scan_cycles_started ON scan_cycles (started_at DESC);

CREATE TABLE scan_cycle_chunks (
    cycle_id    TEXT NOT NULL,
    chunk_index INTEGER NOT NULL,
    received_at INTEGER NOT NULL,
    PRIMARY KEY (cycle_id, chunk_index)
);

CREATE TABLE scan_events (
    id           INTEGER PRIMARY KEY,
    cycle_id     TEXT NOT NULL,
    package      TEXT NOT NULL,
    status       TEXT NOT NULL,
    score        INTEGER,
    risk         TEXT NOT NULL DEFAULT '',
    old_version  TEXT NOT NULL DEFAULT '',
    new_version  TEXT NOT NULL DEFAULT '',
    maintainer   TEXT NOT NULL DEFAULT '',
    rules_json   TEXT NOT NULL DEFAULT '[]',
    coverage_gaps_json TEXT NOT NULL DEFAULT '[]',
    has_diff     INTEGER NOT NULL DEFAULT 0,
    time         INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_scan_events_cycle_package ON scan_events (cycle_id, package);
CREATE INDEX idx_scan_events_time ON scan_events (time DESC);
CREATE INDEX idx_scan_events_package_time ON scan_events (package, time DESC);
CREATE INDEX idx_scan_events_status_time ON scan_events (status, time DESC);
CREATE INDEX idx_scan_events_risk_time ON scan_events (risk, time DESC);

CREATE TABLE scan_rule_events (
    cycle_id TEXT NOT NULL,
    package  TEXT NOT NULL,
    rule_id  TEXT NOT NULL,
    severity TEXT NOT NULL DEFAULT '',
    time     INTEGER NOT NULL,
    PRIMARY KEY (cycle_id, package, rule_id)
);
CREATE INDEX idx_scan_rule_events_rule_time ON scan_rule_events (rule_id, time DESC);
CREATE INDEX idx_scan_rule_events_time ON scan_rule_events (time DESC);

-- Squashed daily rollups.  One row per complete UTC day; the retention job
-- writes them before deleting raw scan_events.
CREATE TABLE scan_daily_totals (
    day          TEXT PRIMARY KEY,
    cycles       INTEGER NOT NULL DEFAULT 0,
    attempted    INTEGER NOT NULL DEFAULT 0,
    succeeded    INTEGER NOT NULL DEFAULT 0,
    fetch_failed INTEGER NOT NULL DEFAULT 0,
    not_vetted   INTEGER NOT NULL DEFAULT 0,
    vanished     INTEGER NOT NULL DEFAULT 0,
    reserved     INTEGER NOT NULL DEFAULT 0,
    with_diff    INTEGER NOT NULL DEFAULT 0,
    alerts       INTEGER NOT NULL DEFAULT 0,
    score_sum    INTEGER NOT NULL DEFAULT 0,
    score_count  INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE scan_daily_risks (
    day  TEXT NOT NULL,
    risk TEXT NOT NULL,
    count INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (day, risk)
);
CREATE TABLE scan_daily_rules (
    day     TEXT NOT NULL,
    rule_id TEXT NOT NULL,
    severity TEXT NOT NULL DEFAULT '',
    count   INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (day, rule_id)
);
CREATE TABLE scan_daily_packages (
    day       TEXT NOT NULL,
    package   TEXT NOT NULL,
    scans     INTEGER NOT NULL DEFAULT 0,
    max_score INTEGER NOT NULL DEFAULT 0,
    last_status TEXT NOT NULL DEFAULT '',
    last_risk TEXT NOT NULL DEFAULT '',
    has_diff  INTEGER NOT NULL DEFAULT 0,
    rules_json TEXT NOT NULL DEFAULT '[]',
    PRIMARY KEY (day, package)
);
CREATE INDEX idx_scan_daily_packages_package ON scan_daily_packages (package, day DESC);

UPDATE meta SET value = '14' WHERE key = 'schema';
CREATE TABLE scan_daily_scores (
    day    TEXT NOT NULL,
    bucket INTEGER NOT NULL,
    count  INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (day, bucket)
);
