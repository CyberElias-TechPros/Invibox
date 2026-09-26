CREATE TABLE rate_limits (key TEXT PRIMARY KEY, count INTEGER NOT NULL, expires_at INTEGER NOT NULL);
CREATE INDEX idx_rate_limits_expiry ON rate_limits(expires_at);
CREATE TABLE notification_outbox (
  id TEXT PRIMARY KEY REFERENCES announcements(id) ON DELETE CASCADE,
  payload_json TEXT NOT NULL,
  dispatched_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_outbox_pending ON notification_outbox(dispatched_at,created_at);
ALTER TABLE notification_deliveries ADD COLUMN attempts INTEGER NOT NULL DEFAULT 1;
ALTER TABLE notification_deliveries ADD COLUMN retryable INTEGER NOT NULL DEFAULT 0;
-- Revoked or concurrently consumed password-reset tokens cannot update the password twice.
CREATE TRIGGER reset_single_use BEFORE UPDATE OF consumed_at ON password_reset_tokens WHEN OLD.consumed_at IS NOT NULL AND NEW.consumed_at<>OLD.consumed_at BEGIN
  SELECT RAISE(ABORT,'reset_consumed');
END;
