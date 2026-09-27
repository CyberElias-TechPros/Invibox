ALTER TABLE users ADD COLUMN auth_version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sessions ADD COLUMN auth_version INTEGER NOT NULL DEFAULT 0;
CREATE TABLE email_verifications (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE account_action_guards (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  password_hash TEXT NOT NULL
);
CREATE TRIGGER account_action_guard BEFORE INSERT ON account_action_guards BEGIN
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM users WHERE id=NEW.user_id AND password_hash=NEW.password_hash) THEN RAISE(ABORT,'account_changed') END;
END;
ALTER TABLE payments ADD COLUMN request_key TEXT;
ALTER TABLE payments ADD COLUMN request_hash TEXT;
ALTER TABLE payments ADD COLUMN initialization_state TEXT NOT NULL DEFAULT 'legacy' CHECK(initialization_state IN ('legacy','reserved','requesting','ready','uncertain','rejected'));
CREATE UNIQUE INDEX idx_payment_request ON payments(event_id,request_key) WHERE request_key IS NOT NULL;
CREATE TABLE media_deletions (
  object_key TEXT PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
ALTER TABLE payments ADD COLUMN last_verified_at TEXT;
ALTER TABLE users ADD COLUMN disabled_at TEXT;
CREATE TABLE password_reset_claims (id TEXT PRIMARY KEY,token_hash TEXT NOT NULL);
CREATE TRIGGER reset_claim_guard BEFORE INSERT ON password_reset_claims BEGIN
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM password_reset_tokens WHERE token_hash=NEW.token_hash AND consumed_at IS NULL AND julianday(expires_at)>julianday('now')) THEN RAISE(ABORT,'reset_consumed') END;
END;
