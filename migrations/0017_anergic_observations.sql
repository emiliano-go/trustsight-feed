-- Anergic findings are observations, not alerts.  The scan stream already
-- carries every rule that fired; these two columns make the report-only
-- subset queryable without changing the alert path.
ALTER TABLE scan_rule_events ADD COLUMN weight INTEGER NOT NULL DEFAULT 0;
ALTER TABLE scan_rule_events ADD COLUMN anergic INTEGER NOT NULL DEFAULT 0;

CREATE INDEX idx_scan_rule_events_anergic_time
    ON scan_rule_events (time DESC) WHERE anergic = 1;
CREATE INDEX idx_scan_rule_events_anergic_package
    ON scan_rule_events (package, time DESC) WHERE anergic = 1;

UPDATE meta SET value = '17' WHERE key = 'schema';
