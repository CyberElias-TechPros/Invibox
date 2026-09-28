CREATE TABLE plan_catalog(code TEXT PRIMARY KEY,name TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind IN ('plan','pack')),tier INTEGER NOT NULL DEFAULT 0,price_minor INTEGER NOT NULL CHECK(price_minor>=0),limits_json TEXT NOT NULL CHECK(json_valid(limits_json)),active INTEGER NOT NULL DEFAULT 0,updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
-- Proposed NGN prices: paid entries require an operator's explicit activation before checkout.
INSERT INTO plan_catalog VALUES
('free','Free','plan',0,0,'{"guests":50,"occasions":3,"collaborators":2,"photos":20,"storage":104857600,"messages":0}',1,CURRENT_TIMESTAMP),
('essential','Essential','plan',1,750000,'{"guests":200,"occasions":5,"collaborators":5,"photos":200,"storage":524288000,"messages":200}',0,CURRENT_TIMESTAMP),
('celebration','Celebration','plan',2,1500000,'{"guests":500,"occasions":10,"collaborators":10,"photos":1000,"storage":1073741824,"messages":500}',0,CURRENT_TIMESTAMP),
('professional','Professional','plan',3,3000000,'{"guests":1500,"occasions":25,"collaborators":20,"photos":2000,"storage":2147483648,"messages":1500}',0,CURRENT_TIMESTAMP),
('guest-pack','100 extra guest places','pack',0,250000,'{"guests":100,"occasions":0,"collaborators":0,"photos":0,"storage":0,"messages":0}',0,CURRENT_TIMESTAMP),
('photo-pack','100 extra photos / 100 MB','pack',0,150000,'{"guests":0,"occasions":0,"collaborators":0,"photos":100,"storage":104857600,"messages":0}',0,CURRENT_TIMESTAMP),
('message-pack','100 queued recipients','pack',0,300000,'{"guests":0,"occasions":0,"collaborators":0,"photos":0,"storage":0,"messages":100}',0,CURRENT_TIMESTAMP);
CREATE TABLE event_entitlements(event_id TEXT PRIMARY KEY REFERENCES events(id) ON DELETE CASCADE,plan_code TEXT NOT NULL DEFAULT 'free',tier INTEGER NOT NULL DEFAULT 0,guest_limit INTEGER NOT NULL,occasion_limit INTEGER NOT NULL,collaborator_limit INTEGER NOT NULL,photo_limit INTEGER NOT NULL,storage_limit INTEGER NOT NULL,message_limit INTEGER NOT NULL,messages_used INTEGER NOT NULL DEFAULT 0,bonus_json TEXT NOT NULL DEFAULT '{}',updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
INSERT INTO event_entitlements(event_id,guest_limit,occasion_limit,collaborator_limit,photo_limit,storage_limit,message_limit,messages_used)
 SELECT id,MAX(50,(SELECT COALESCE(SUM(party_size),0) FROM guests WHERE event_id=events.id)),MAX(3,(SELECT COUNT(*) FROM occasions WHERE event_id=events.id)),MAX(2,(SELECT COUNT(*) FROM event_members WHERE event_id=events.id AND role<>'owner')),MAX(20,(SELECT COUNT(*) FROM media WHERE event_id=events.id)),MAX(104857600,(SELECT COALESCE(SUM(size_bytes),0) FROM media WHERE event_id=events.id)),(SELECT COUNT(*) FROM announcement_recipients ar JOIN announcements a ON a.id=ar.announcement_id WHERE a.event_id=events.id),(SELECT COUNT(*) FROM announcement_recipients ar JOIN announcements a ON a.id=ar.announcement_id WHERE a.event_id=events.id) FROM events;
CREATE TRIGGER event_free_package AFTER INSERT ON events BEGIN
 INSERT INTO event_entitlements(event_id,guest_limit,occasion_limit,collaborator_limit,photo_limit,storage_limit,message_limit) SELECT NEW.id,json_extract(limits_json,'$.guests'),json_extract(limits_json,'$.occasions'),json_extract(limits_json,'$.collaborators'),json_extract(limits_json,'$.photos'),json_extract(limits_json,'$.storage'),json_extract(limits_json,'$.messages') FROM plan_catalog WHERE code='free';
END;
CREATE TRIGGER guest_package_insert BEFORE INSERT ON guests WHEN NOT EXISTS(SELECT 1 FROM sync_guards WHERE event_id=NEW.event_id AND collection='guests') BEGIN
 SELECT CASE WHEN NEW.party_size+(SELECT COALESCE(SUM(party_size),0) FROM guests WHERE event_id=NEW.event_id AND id<>NEW.id)>(SELECT guest_limit FROM event_entitlements WHERE event_id=NEW.event_id) THEN RAISE(ABORT,'package_limit') END;
END;
CREATE TRIGGER guest_package_update BEFORE UPDATE OF party_size ON guests WHEN NOT EXISTS(SELECT 1 FROM sync_guards WHERE event_id=NEW.event_id AND collection='guests') BEGIN
 SELECT CASE WHEN NEW.party_size+(SELECT COALESCE(SUM(party_size),0) FROM guests WHERE event_id=NEW.event_id AND id<>NEW.id)>(SELECT guest_limit FROM event_entitlements WHERE event_id=NEW.event_id) THEN RAISE(ABORT,'package_limit') END;
END;
CREATE TRIGGER occasion_package_insert BEFORE INSERT ON occasions WHEN NOT EXISTS(SELECT 1 FROM sync_guards WHERE event_id=NEW.event_id AND collection='schedule') BEGIN
 SELECT CASE WHEN (SELECT COUNT(*) FROM occasions WHERE event_id=NEW.event_id AND id<>NEW.id)+1>(SELECT occasion_limit FROM event_entitlements WHERE event_id=NEW.event_id) THEN RAISE(ABORT,'package_limit') END;
END;
CREATE TRIGGER package_sync_commit BEFORE DELETE ON sync_guards BEGIN
 SELECT CASE WHEN (OLD.collection='guests' AND (SELECT COALESCE(SUM(party_size),0) FROM guests WHERE event_id=OLD.event_id)>(SELECT guest_limit FROM event_entitlements WHERE event_id=OLD.event_id)) OR (OLD.collection='schedule' AND (SELECT COUNT(*) FROM occasions WHERE event_id=OLD.event_id)>(SELECT occasion_limit FROM event_entitlements WHERE event_id=OLD.event_id)) THEN RAISE(ABORT,'package_limit') END;
END;
CREATE TRIGGER member_package_insert BEFORE INSERT ON event_members WHEN NEW.role<>'owner' BEGIN
 SELECT CASE WHEN (SELECT COUNT(*) FROM event_members WHERE event_id=NEW.event_id AND role<>'owner' AND user_id<>NEW.user_id)+1>(SELECT collaborator_limit FROM event_entitlements WHERE event_id=NEW.event_id) THEN RAISE(ABORT,'package_limit') END;
END;
CREATE TRIGGER media_package_insert BEFORE INSERT ON media BEGIN
 SELECT CASE WHEN (SELECT COUNT(*) FROM media WHERE event_id=NEW.event_id)+1>(SELECT photo_limit FROM event_entitlements WHERE event_id=NEW.event_id) OR NEW.size_bytes+(SELECT COALESCE(SUM(size_bytes),0) FROM media WHERE event_id=NEW.event_id)>(SELECT storage_limit FROM event_entitlements WHERE event_id=NEW.event_id) THEN RAISE(ABORT,'package_limit') END;
END;
CREATE TRIGGER message_package_reserve BEFORE INSERT ON announcement_recipients BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM event_entitlements q JOIN announcements a ON a.event_id=q.event_id WHERE a.id=NEW.announcement_id AND q.messages_used>=q.message_limit) THEN RAISE(ABORT,'package_limit') END;
END;
CREATE TRIGGER message_package_consume AFTER INSERT ON announcement_recipients BEGIN
 UPDATE event_entitlements SET messages_used=messages_used+1 WHERE event_id=(SELECT event_id FROM announcements WHERE id=NEW.announcement_id);
END;
CREATE TABLE billing_orders(reference TEXT PRIMARY KEY,event_id TEXT NOT NULL REFERENCES events(id),owner_id TEXT NOT NULL REFERENCES users(id),request_key TEXT NOT NULL,product_code TEXT NOT NULL,kind TEXT NOT NULL,tier INTEGER NOT NULL,amount_minor INTEGER NOT NULL,currency TEXT NOT NULL DEFAULT 'NGN',limits_json TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'reserved' CHECK(status IN ('reserved','requesting','initialized','uncertain','rejected','paid')),checkout_url TEXT,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,paid_at TEXT,last_verified_at TEXT,review_reason TEXT,UNIQUE(event_id,request_key));
CREATE UNIQUE INDEX one_pending_order ON billing_orders(event_id) WHERE status IN ('reserved','requesting','initialized','uncertain');
CREATE TRIGGER apply_billing_package AFTER UPDATE OF status ON billing_orders WHEN NEW.status='paid' AND OLD.status<>'paid' BEGIN
 UPDATE event_entitlements SET
 plan_code=CASE WHEN NEW.kind='plan' AND NEW.tier>tier THEN NEW.product_code ELSE plan_code END,tier=MAX(tier,CASE WHEN NEW.kind='plan' THEN NEW.tier ELSE 0 END),
 guest_limit=CASE WHEN NEW.kind='pack' THEN guest_limit+json_extract(NEW.limits_json,'$.guests') ELSE MAX(guest_limit,MIN(5000,json_extract(NEW.limits_json,'$.guests')+COALESCE(json_extract(bonus_json,'$.guests'),0))) END,
 occasion_limit=CASE WHEN NEW.kind='pack' THEN occasion_limit+json_extract(NEW.limits_json,'$.occasions') ELSE MAX(occasion_limit,MIN(100,json_extract(NEW.limits_json,'$.occasions')+COALESCE(json_extract(bonus_json,'$.occasions'),0))) END,
 collaborator_limit=CASE WHEN NEW.kind='pack' THEN collaborator_limit+json_extract(NEW.limits_json,'$.collaborators') ELSE MAX(collaborator_limit,MIN(100,json_extract(NEW.limits_json,'$.collaborators')+COALESCE(json_extract(bonus_json,'$.collaborators'),0))) END,
 photo_limit=CASE WHEN NEW.kind='pack' THEN photo_limit+json_extract(NEW.limits_json,'$.photos') ELSE MAX(photo_limit,MIN(2000,json_extract(NEW.limits_json,'$.photos')+COALESCE(json_extract(bonus_json,'$.photos'),0))) END,
 storage_limit=CASE WHEN NEW.kind='pack' THEN storage_limit+json_extract(NEW.limits_json,'$.storage') ELSE MAX(storage_limit,MIN(2147483648,json_extract(NEW.limits_json,'$.storage')+COALESCE(json_extract(bonus_json,'$.storage'),0))) END,
 message_limit=CASE WHEN NEW.kind='pack' THEN message_limit+json_extract(NEW.limits_json,'$.messages') ELSE MAX(message_limit,MIN(100000,json_extract(NEW.limits_json,'$.messages')+COALESCE(json_extract(bonus_json,'$.messages'),0))) END,bonus_json=CASE WHEN NEW.kind='pack' THEN json_object('guests',COALESCE(json_extract(bonus_json,'$.guests'),0)+json_extract(NEW.limits_json,'$.guests'),'occasions',COALESCE(json_extract(bonus_json,'$.occasions'),0)+json_extract(NEW.limits_json,'$.occasions'),'collaborators',COALESCE(json_extract(bonus_json,'$.collaborators'),0)+json_extract(NEW.limits_json,'$.collaborators'),'photos',COALESCE(json_extract(bonus_json,'$.photos'),0)+json_extract(NEW.limits_json,'$.photos'),'storage',COALESCE(json_extract(bonus_json,'$.storage'),0)+json_extract(NEW.limits_json,'$.storage'),'messages',COALESCE(json_extract(bonus_json,'$.messages'),0)+json_extract(NEW.limits_json,'$.messages')) ELSE bonus_json END,updated_at=CURRENT_TIMESTAMP WHERE event_id=NEW.event_id;
END;
CREATE TRIGGER billing_financial_retention BEFORE DELETE ON events WHEN EXISTS(SELECT 1 FROM billing_orders WHERE event_id=OLD.id) BEGIN SELECT RAISE(ABORT,'financial_retention'); END;
CREATE TABLE payout_accounts(user_id TEXT PRIMARY KEY REFERENCES users(id),request_id TEXT NOT NULL DEFAULT (lower(hex(randomblob(16)))) UNIQUE,request_hash TEXT NOT NULL,bank_code TEXT NOT NULL,bank_name TEXT,account_name TEXT,last_four TEXT NOT NULL,subaccount_code TEXT UNIQUE,state TEXT NOT NULL CHECK(state IN ('requesting','uncertain','review','verified','blocked','rejected')),created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,reviewed_at TEXT,reviewed_by TEXT,review_reason TEXT);
ALTER TABLE payments ADD COLUMN subaccount_code TEXT;
ALTER TABLE payments ADD COLUMN platform_fee_minor INTEGER NOT NULL DEFAULT 0;

-- Keep fulfillment monotonic even if an operator closes a pending checkout concurrently with a webhook.
CREATE TRIGGER billing_paid_immutable BEFORE UPDATE ON billing_orders WHEN OLD.status='paid' AND NEW.status<>'paid' BEGIN SELECT RAISE(ABORT,'paid_order_immutable'); END;
CREATE TRIGGER payment_payout_guard BEFORE INSERT ON payments WHEN NEW.subaccount_code IS NOT NULL BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM payout_accounts p JOIN events e ON e.owner_id=p.user_id WHERE e.id=NEW.event_id AND p.state='verified' AND p.subaccount_code=NEW.subaccount_code) THEN RAISE(ABORT,'payout_not_verified') END;
END;
CREATE TRIGGER payment_route_immutable BEFORE UPDATE OF subaccount_code,platform_fee_minor ON payments WHEN NEW.subaccount_code IS NOT OLD.subaccount_code OR NEW.platform_fee_minor<>OLD.platform_fee_minor BEGIN SELECT RAISE(ABORT,'payment_route_immutable'); END;

CREATE TRIGGER billing_snapshot_immutable BEFORE UPDATE OF event_id,owner_id,request_key,product_code,kind,tier,amount_minor,currency,limits_json ON billing_orders
 WHEN NEW.event_id IS NOT OLD.event_id OR NEW.owner_id IS NOT OLD.owner_id OR NEW.request_key IS NOT OLD.request_key OR NEW.product_code IS NOT OLD.product_code OR NEW.kind IS NOT OLD.kind OR NEW.tier IS NOT OLD.tier OR NEW.amount_minor IS NOT OLD.amount_minor OR NEW.currency IS NOT OLD.currency OR NEW.limits_json IS NOT OLD.limits_json
 BEGIN SELECT RAISE(ABORT,'billing_snapshot_immutable'); END;

CREATE TABLE payout_review_guards(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,request_id TEXT NOT NULL,expected_state TEXT NOT NULL,expected_subaccount TEXT);
CREATE TRIGGER payout_review_current BEFORE INSERT ON payout_review_guards BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM payout_accounts WHERE user_id=NEW.user_id AND request_id=NEW.request_id AND state=NEW.expected_state AND subaccount_code IS NEW.expected_subaccount) THEN RAISE(ABORT,'payout_review_changed') END;
END;
CREATE INDEX billing_recovery ON billing_orders(status,last_verified_at,created_at);
CREATE TRIGGER billing_event_open BEFORE INSERT ON billing_orders BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM events WHERE id=NEW.event_id AND lifecycle IN ('completed','archived')) THEN RAISE(ABORT,'billing_event_closed') END;
END;
