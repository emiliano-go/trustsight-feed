-- Per-notification provenance.  The signed ingest path verifies an Ed25519
-- signature over `webhook-id.webhook-timestamp.rawbody`; these columns keep
-- that proof beside the stored document so a client can verify the archive
-- later instead of trusting the store.  Rows written before this migration
-- (or through the ntfy-shaped parity route) leave the columns NULL.

ALTER TABLE notifications ADD COLUMN webhook_id TEXT;
ALTER TABLE notifications ADD COLUMN key_id TEXT;
ALTER TABLE notifications ADD COLUMN signed_at INTEGER;
ALTER TABLE notifications ADD COLUMN signature TEXT;
ALTER TABLE notifications ADD COLUMN body_sha256 TEXT;
