-- AUR source and diff fetched once, then served from here, so a page view
-- never hammers the AUR. Keyed by the requested file ('' for a diff); the
-- actual repository file may differ (see actual_file).
CREATE TABLE source_cache (
    package     TEXT NOT NULL,
    file        TEXT NOT NULL,
    kind        TEXT NOT NULL,
    actual_file TEXT NOT NULL DEFAULT '',
    content     TEXT NOT NULL,
    fetched_at  INTEGER NOT NULL,
    PRIMARY KEY (package, file, kind)
);
