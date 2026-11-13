-- Dependency-walk summaries on scan events.  The analysis publishes only a
-- bounded summary (depth reached, counts, flagged/failed identities); full
-- dependency analyses stay in the watcher's own database.

ALTER TABLE scan_events ADD COLUMN dependencies_json TEXT NOT NULL DEFAULT '';
ALTER TABLE scan_daily_packages ADD COLUMN dependencies_json TEXT NOT NULL DEFAULT '';

UPDATE meta SET value = '15' WHERE key = 'schema';
