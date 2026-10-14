-- trustsight-feed: notifications persisted from the ntfy topic.
--
-- One row per ntfy `message` event. `id` is the ntfy message id, the natural
-- dedupe key; `payload` is the parsed TrustSight document (the ntfy `message`
-- field), kept alongside `message_raw` so nothing is lost if parsing changes.

CREATE TABLE notifications (
    id                TEXT PRIMARY KEY,
    time              INTEGER NOT NULL,
    event             TEXT NOT NULL,
    topic             TEXT NOT NULL DEFAULT '',
    title             TEXT NOT NULL DEFAULT '',
    priority          INTEGER,
    tags              TEXT NOT NULL DEFAULT '[]',
    day               TEXT NOT NULL DEFAULT '',
    slug              TEXT NOT NULL UNIQUE,
    message_raw       TEXT NOT NULL,
    payload           TEXT NOT NULL DEFAULT '{}',
    n_alerts          INTEGER NOT NULL DEFAULT 0,
    n_over_threshold  INTEGER NOT NULL DEFAULT 0,
    n_ioc             INTEGER NOT NULL DEFAULT 0,
    n_impersonation   INTEGER NOT NULL DEFAULT 0,
    search_text       TEXT NOT NULL DEFAULT '',
    created_at        INTEGER NOT NULL
);

CREATE INDEX idx_notifications_time ON notifications (time DESC);
CREATE INDEX idx_notifications_day ON notifications (day);
CREATE INDEX idx_notifications_event ON notifications (event);

-- Full-text search over the terms a reader would search by: package names,
-- rule ids, versions, title and day. External-content FTS5 kept in sync by
-- triggers, so the notification row stays the single source of truth.
CREATE VIRTUAL TABLE notifications_fts USING fts5 (
    search_text,
    content='notifications',
    content_rowid='rowid',
    tokenize='unicode61'
);

CREATE TRIGGER notifications_ai AFTER INSERT ON notifications BEGIN
    INSERT INTO notifications_fts (rowid, search_text)
    VALUES (new.rowid, new.search_text);
END;

CREATE TRIGGER notifications_ad AFTER DELETE ON notifications BEGIN
    INSERT INTO notifications_fts (notifications_fts, rowid, search_text)
    VALUES ('delete', old.rowid, old.search_text);
END;

CREATE TRIGGER notifications_au AFTER UPDATE ON notifications BEGIN
    INSERT INTO notifications_fts (notifications_fts, rowid, search_text)
    VALUES ('delete', old.rowid, old.search_text);
    INSERT INTO notifications_fts (rowid, search_text)
    VALUES (new.rowid, new.search_text);
END;

-- Ingestion bookkeeping: the ntfy cursor (last seen message id).
CREATE TABLE meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

INSERT INTO meta (key, value) VALUES ('cursor', '');
INSERT INTO meta (key, value) VALUES ('schema', '1');
