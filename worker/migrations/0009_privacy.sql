-- Financial records must not disappear through self-service cascade deletion.
CREATE TRIGGER retain_event_payments BEFORE DELETE ON events WHEN EXISTS(SELECT 1 FROM payments WHERE event_id=OLD.id) BEGIN
  SELECT RAISE(ABORT,'financial_retention');
END;
CREATE TRIGGER archive_before_delete BEFORE DELETE ON events WHEN OLD.lifecycle<>'archived' BEGIN
  SELECT RAISE(ABORT,'archive_required');
END;
