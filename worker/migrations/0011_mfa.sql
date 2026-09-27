CREATE TABLE mfa_credentials (
 user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
 secret_ciphertext TEXT NOT NULL,
 enabled_at TEXT,
 pending_expires_at TEXT NOT NULL,
 last_counter INTEGER NOT NULL DEFAULT -1
);
CREATE TABLE mfa_recovery_codes (
 user_id TEXT NOT NULL REFERENCES mfa_credentials(user_id) ON DELETE CASCADE,
 code_hash TEXT NOT NULL,
 PRIMARY KEY(user_id,code_hash)
);
CREATE TABLE mfa_challenges (
 token_hash TEXT PRIMARY KEY,
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 auth_version INTEGER NOT NULL,
 expires_at TEXT NOT NULL,
 attempts INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE mfa_proof_guards (
 id TEXT PRIMARY KEY,user_id TEXT NOT NULL,secret_ciphertext TEXT NOT NULL,
 mode TEXT NOT NULL CHECK(mode IN ('enable','verify')),counter INTEGER NOT NULL,recovery_hash TEXT
);
CREATE TRIGGER mfa_proof_guard BEFORE INSERT ON mfa_proof_guards BEGIN
 SELECT CASE WHEN NOT EXISTS(
  SELECT 1 FROM mfa_credentials m WHERE m.user_id=NEW.user_id AND m.secret_ciphertext=NEW.secret_ciphertext
  AND ((NEW.mode='enable' AND m.enabled_at IS NULL AND julianday(m.pending_expires_at)>julianday('now')) OR (NEW.mode='verify' AND m.enabled_at IS NOT NULL))
  AND ((NEW.counter>=0 AND NEW.counter>m.last_counter) OR (NEW.recovery_hash IS NOT NULL AND EXISTS(SELECT 1 FROM mfa_recovery_codes r WHERE r.user_id=NEW.user_id AND r.code_hash=NEW.recovery_hash)))
 ) THEN RAISE(ABORT,'mfa_proof_used') END;
END;
CREATE TRIGGER mfa_proof_consume AFTER INSERT ON mfa_proof_guards BEGIN
 UPDATE mfa_credentials SET last_counter=NEW.counter WHERE user_id=NEW.user_id AND NEW.counter>=0;
 DELETE FROM mfa_recovery_codes WHERE user_id=NEW.user_id AND code_hash=NEW.recovery_hash;
END;
CREATE TABLE mfa_login_claims(token_hash TEXT PRIMARY KEY);
CREATE TRIGGER mfa_login_claim BEFORE INSERT ON mfa_login_claims BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM mfa_challenges c JOIN users u ON u.id=c.user_id WHERE c.token_hash=NEW.token_hash AND u.auth_version=c.auth_version AND u.disabled_at IS NULL AND julianday(c.expires_at)>julianday('now') AND c.attempts<=5) THEN RAISE(ABORT,'mfa_challenge_expired') END;
 DELETE FROM mfa_challenges WHERE token_hash=NEW.token_hash;
END;
CREATE TABLE mfa_attempts(user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,window_start INTEGER NOT NULL,attempts INTEGER NOT NULL DEFAULT 0);
