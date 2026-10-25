-- A signed document is identified by its bytes as well as its webhook id.
-- The replay window is short, but a captured request replayed under a new id
-- must not create a second row.  NULL hashes (the ntfy-shaped parity route)
-- are exempt, so existing unsigned rows are unaffected.
CREATE UNIQUE INDEX idx_notifications_body_sha256
    ON notifications(body_sha256) WHERE body_sha256 IS NOT NULL;
