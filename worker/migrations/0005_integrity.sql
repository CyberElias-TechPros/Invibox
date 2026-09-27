-- Database-enforced tenant boundaries and concurrency invariants.
ALTER TABLE events ADD COLUMN guests_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE events ADD COLUMN schedule_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE events ADD COLUMN sections_version INTEGER NOT NULL DEFAULT 1;
CREATE TABLE sync_guards (id TEXT PRIMARY KEY, event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE, collection TEXT NOT NULL, expected_version INTEGER NOT NULL);
CREATE TRIGGER sync_guard BEFORE INSERT ON sync_guards BEGIN
  SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM events WHERE id=NEW.event_id AND CASE NEW.collection WHEN 'guests' THEN guests_version WHEN 'schedule' THEN schedule_version WHEN 'sections' THEN sections_version ELSE -1 END=NEW.expected_version) THEN RAISE(ABORT,'stale_snapshot') END;
END;
CREATE TRIGGER guests_tenant_insert BEFORE INSERT ON guests BEGIN
  SELECT CASE WHEN EXISTS(SELECT 1 FROM guests WHERE id=NEW.id AND event_id<>NEW.event_id) THEN RAISE(ABORT,'tenant_conflict') END;
  SELECT CASE WHEN NEW.group_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM guest_groups WHERE id=NEW.group_id AND event_id=NEW.event_id) THEN RAISE(ABORT,'tenant_conflict') END;
END;
CREATE TRIGGER guests_tenant_update BEFORE UPDATE ON guests BEGIN
  SELECT CASE WHEN NEW.event_id<>OLD.event_id OR (NEW.group_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM guest_groups WHERE id=NEW.group_id AND event_id=NEW.event_id)) THEN RAISE(ABORT,'tenant_conflict') END;
END;
CREATE TRIGGER occasions_tenant_insert BEFORE INSERT ON occasions BEGIN
  SELECT CASE WHEN EXISTS(SELECT 1 FROM occasions WHERE id=NEW.id AND event_id<>NEW.event_id) THEN RAISE(ABORT,'tenant_conflict') END;
END;
CREATE TRIGGER access_tenant_insert BEFORE INSERT ON guest_occasion_access BEGIN
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM guests g JOIN occasions o ON o.event_id=g.event_id WHERE g.id=NEW.guest_id AND o.id=NEW.occasion_id) THEN RAISE(ABORT,'tenant_conflict') END;
END;
CREATE TRIGGER seat_capacity_insert BEFORE INSERT ON guests WHEN NEW.table_name IS NOT NULL BEGIN
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM seating_tables WHERE event_id=NEW.event_id AND name=NEW.table_name AND capacity >= NEW.party_size + (SELECT COALESCE(SUM(party_size),0) FROM guests WHERE event_id=NEW.event_id AND table_name=NEW.table_name AND id<>NEW.id)) THEN RAISE(ABORT,'seat_capacity') END;
END;
CREATE TRIGGER seat_capacity_update BEFORE UPDATE OF table_name,party_size ON guests WHEN NEW.table_name IS NOT NULL BEGIN
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM seating_tables WHERE event_id=NEW.event_id AND name=NEW.table_name AND capacity >= NEW.party_size + (SELECT COALESCE(SUM(party_size),0) FROM guests WHERE event_id=NEW.event_id AND table_name=NEW.table_name AND id<>NEW.id)) THEN RAISE(ABORT,'seat_capacity') END;
END;
CREATE TRIGGER guests_version_insert AFTER INSERT ON guests BEGIN UPDATE events SET guests_version=guests_version+1 WHERE id=NEW.event_id; END;
CREATE TRIGGER guests_version_update AFTER UPDATE ON guests BEGIN UPDATE events SET guests_version=guests_version+1 WHERE id=NEW.event_id; END;
CREATE TRIGGER guests_version_delete AFTER DELETE ON guests BEGIN UPDATE events SET guests_version=guests_version+1 WHERE id=OLD.event_id; END;
CREATE TRIGGER schedule_version_insert AFTER INSERT ON occasions BEGIN UPDATE events SET schedule_version=schedule_version+1 WHERE id=NEW.event_id; END;
CREATE TRIGGER schedule_version_update AFTER UPDATE ON occasions BEGIN UPDATE events SET schedule_version=schedule_version+1 WHERE id=NEW.event_id; END;
CREATE TRIGGER schedule_version_delete AFTER DELETE ON occasions BEGIN UPDATE events SET schedule_version=schedule_version+1 WHERE id=OLD.event_id; END;
CREATE TRIGGER sections_version_insert AFTER INSERT ON experience_sections BEGIN UPDATE events SET sections_version=sections_version+1 WHERE id=NEW.event_id; END;
CREATE TRIGGER sections_version_delete AFTER DELETE ON experience_sections BEGIN UPDATE events SET sections_version=sections_version+1 WHERE id=OLD.event_id; END;
CREATE INDEX idx_guests_table ON guests(event_id,table_name);
CREATE INDEX idx_access_occasion ON guest_occasion_access(occasion_id);
CREATE INDEX idx_audit_retention ON audit_logs(created_at);
