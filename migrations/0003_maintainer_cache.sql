-- The current AUR maintainer per package, so the watcher-feed UI can group by
-- maintainer without an AUR RPC on every view.
CREATE TABLE maintainer_cache (
    package    TEXT PRIMARY KEY,
    maintainer TEXT NOT NULL DEFAULT '',
    fetched_at INTEGER NOT NULL
);
