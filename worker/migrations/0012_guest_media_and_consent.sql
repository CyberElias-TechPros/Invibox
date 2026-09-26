ALTER TABLE guests ADD COLUMN communication_consent_source TEXT NOT NULL DEFAULT 'legacy';
CREATE TABLE communication_consents (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
 guest_id TEXT NOT NULL REFERENCES guests(id) ON DELETE CASCADE,
 email_opt_in INTEGER NOT NULL,sms_opt_in INTEGER NOT NULL,whatsapp_opt_in INTEGER NOT NULL,
 source TEXT NOT NULL,policy_version TEXT NOT NULL DEFAULT 'event-updates-v1',created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_communication_consents_event ON communication_consents(event_id,id);
INSERT INTO communication_consents(event_id,guest_id,email_opt_in,sms_opt_in,whatsapp_opt_in,source)
 SELECT event_id,id,email_opt_in,sms_opt_in,whatsapp_opt_in,'migration_snapshot' FROM guests WHERE email_opt_in=1 OR sms_opt_in=1 OR whatsapp_opt_in=1;
CREATE TRIGGER record_communication_consent AFTER UPDATE OF email_opt_in,sms_opt_in,whatsapp_opt_in ON guests
 WHEN NEW.email_opt_in<>OLD.email_opt_in OR NEW.sms_opt_in<>OLD.sms_opt_in OR NEW.whatsapp_opt_in<>OLD.whatsapp_opt_in BEGIN
 INSERT INTO communication_consents(event_id,guest_id,email_opt_in,sms_opt_in,whatsapp_opt_in,source) VALUES(NEW.event_id,NEW.id,NEW.email_opt_in,NEW.sms_opt_in,NEW.whatsapp_opt_in,NEW.communication_consent_source);
END;
DROP TRIGGER reset_consent_on_contact_change;
CREATE TRIGGER reset_consent_on_contact_change AFTER UPDATE OF email,phone ON guests WHEN COALESCE(OLD.email,'')<>COALESCE(NEW.email,'') OR COALESCE(OLD.phone,'')<>COALESCE(NEW.phone,'') BEGIN
 UPDATE guests SET email_opt_in=CASE WHEN COALESCE(OLD.email,'')<>COALESCE(NEW.email,'') THEN 0 ELSE email_opt_in END,sms_opt_in=CASE WHEN COALESCE(OLD.phone,'')<>COALESCE(NEW.phone,'') THEN 0 ELSE sms_opt_in END,whatsapp_opt_in=CASE WHEN COALESCE(OLD.phone,'')<>COALESCE(NEW.phone,'') THEN 0 ELSE whatsapp_opt_in END,communication_consent_at=CURRENT_TIMESTAMP,communication_consent_source='contact_change' WHERE id=NEW.id;
END;
ALTER TABLE media ADD COLUMN share_with_guests INTEGER NOT NULL DEFAULT 0 CHECK(share_with_guests IN (0,1));
ALTER TABLE media ADD COLUMN upload_state TEXT NOT NULL DEFAULT 'ready' CHECK(upload_state IN ('uploading','ready'));
ALTER TABLE media ADD COLUMN consent_at TEXT;
-- Reservations survive metadata/event erasure so the purge worker cannot race an in-flight upload.
CREATE TABLE media_uploads(object_key TEXT PRIMARY KEY,expires_at TEXT NOT NULL);
CREATE TRIGGER guest_media_quota BEFORE INSERT ON media WHEN NEW.guest_id IS NOT NULL BEGIN
 SELECT CASE WHEN (SELECT COUNT(*) FROM media WHERE guest_id=NEW.guest_id)>=20 OR (SELECT COALESCE(SUM(size_bytes),0) FROM media WHERE guest_id=NEW.guest_id)+NEW.size_bytes>104857600 OR (SELECT COUNT(*) FROM media WHERE event_id=NEW.event_id)>=2000 OR (SELECT COALESCE(SUM(size_bytes),0) FROM media WHERE event_id=NEW.event_id)+NEW.size_bytes>2147483648 THEN RAISE(ABORT,'guest_media_quota') END;
 SELECT CASE WHEN NEW.upload_state='uploading' AND NOT EXISTS(SELECT 1 FROM guests g JOIN events e ON e.id=g.event_id WHERE g.id=NEW.guest_id AND g.event_id=NEW.event_id AND e.lifecycle IN ('published','active','live') AND json_extract(e.settings_json,'$.guestUploads')=1) THEN RAISE(ABORT,'guest_uploads_closed') END;
END;
CREATE INDEX idx_guest_media_owner ON media(guest_id);
CREATE INDEX idx_guest_media_page ON media(event_id,id);
CREATE INDEX idx_consent_guest_history ON communication_consents(guest_id,id);
