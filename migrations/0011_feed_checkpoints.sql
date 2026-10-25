-- Append-only signed checkpoints over batches of stored notifications.
-- Each checkpoint covers the rows between from_rowid and through_rowid and
-- chains to the previous checkpoint's root.  Leaves are stored so an audit
-- path can be produced without re-reading the notification payloads.

CREATE TABLE feed_checkpoints (
    id             TEXT PRIMARY KEY,
    generated_at   INTEGER NOT NULL,
    from_rowid     INTEGER NOT NULL,
    through_rowid  INTEGER NOT NULL,
    count          INTEGER NOT NULL,
    previous_id    TEXT NOT NULL DEFAULT '',
    previous_root  TEXT NOT NULL DEFAULT '',
    root_hash      TEXT NOT NULL,
    key_id         TEXT NOT NULL DEFAULT '',
    algorithm      TEXT NOT NULL DEFAULT 'Ed25519',
    canonical      TEXT NOT NULL,
    signature      TEXT NOT NULL,
    complete       INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_feed_checkpoints_time ON feed_checkpoints (generated_at DESC);

CREATE TABLE feed_checkpoint_leaves (
    checkpoint_id TEXT NOT NULL,
    rowid         INTEGER NOT NULL,
    slug          TEXT NOT NULL,
    leaf_hash     TEXT NOT NULL,
    leaf_index    INTEGER NOT NULL,
    PRIMARY KEY (checkpoint_id, rowid)
);
CREATE INDEX idx_feed_checkpoint_leaves_order
    ON feed_checkpoint_leaves (checkpoint_id, leaf_index);

CREATE TABLE feed_checkpoint_state (
    id                 INTEGER PRIMARY KEY CHECK (id = 1),
    last_rowid         INTEGER NOT NULL DEFAULT 0,
    last_root          TEXT NOT NULL DEFAULT '',
    last_checkpoint_id TEXT NOT NULL DEFAULT '',
    locked_until       INTEGER NOT NULL DEFAULT 0
);
INSERT INTO feed_checkpoint_state (id) VALUES (1);
