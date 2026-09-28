-- Contact details are not consent. Existing and new guests start opted out.
ALTER TABLE guests ADD COLUMN email_opt_in INTEGER NOT NULL DEFAULT 0 CHECK(email_opt_in IN (0,1));
ALTER TABLE guests ADD COLUMN sms_opt_in INTEGER NOT NULL DEFAULT 0 CHECK(sms_opt_in IN (0,1));
ALTER TABLE guests ADD COLUMN whatsapp_opt_in INTEGER NOT NULL DEFAULT 0 CHECK(whatsapp_opt_in IN (0,1));
ALTER TABLE guests ADD COLUMN communication_consent_at TEXT;
CREATE TRIGGER reset_consent_on_contact_change AFTER UPDATE OF email,phone ON guests WHEN COALESCE(OLD.email,'')<>COALESCE(NEW.email,'') OR COALESCE(OLD.phone,'')<>COALESCE(NEW.phone,'') BEGIN
  UPDATE guests SET email_opt_in=CASE WHEN COALESCE(OLD.email,'')<>COALESCE(NEW.email,'') THEN 0 ELSE email_opt_in END,sms_opt_in=CASE WHEN COALESCE(OLD.phone,'')<>COALESCE(NEW.phone,'') THEN 0 ELSE sms_opt_in END,whatsapp_opt_in=CASE WHEN COALESCE(OLD.phone,'')<>COALESCE(NEW.phone,'') THEN 0 ELSE whatsapp_opt_in END,communication_consent_at=CURRENT_TIMESTAMP WHERE id=NEW.id;
END;
