-- Remaining product modules: subscriptions, ownership transfer, refunds/disputes, settlements, invoices/tax, tickets, transport/accommodation/registry/waitlist, messaging callbacks/suppression/scheduling, retention, passkeys, session attribution, offline queue, drafts, themes, localization
-- Expand plan_catalog to allow subscription kind
-- Drop dependent triggers first to allow table recreation without FK issues (SQLite drops triggers on parent when FK ON)
DROP TRIGGER IF EXISTS event_free_package;
DROP TRIGGER IF EXISTS guest_package_insert;
DROP TRIGGER IF EXISTS guest_package_update;
DROP TRIGGER IF EXISTS occasion_package_insert;
DROP TRIGGER IF EXISTS package_sync_commit;
DROP TRIGGER IF EXISTS member_package_insert;
DROP TRIGGER IF EXISTS media_package_insert;
DROP TRIGGER IF EXISTS message_package_reserve;
DROP TRIGGER IF EXISTS message_package_consume;
DROP TRIGGER IF EXISTS apply_billing_package;
DROP TRIGGER IF EXISTS billing_financial_retention;
DROP TRIGGER IF EXISTS billing_paid_immutable;
DROP TRIGGER IF EXISTS payment_payout_guard;
DROP TRIGGER IF EXISTS payment_route_immutable;
DROP TRIGGER IF EXISTS billing_snapshot_immutable;
DROP TRIGGER IF EXISTS payout_review_current;
DROP TRIGGER IF EXISTS billing_event_open;

CREATE TABLE plan_catalog_new(code TEXT PRIMARY KEY,name TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind IN ('plan','pack','subscription')),tier INTEGER NOT NULL DEFAULT 0,price_minor INTEGER NOT NULL CHECK(price_minor>=0),limits_json TEXT NOT NULL CHECK(json_valid(limits_json)),active INTEGER NOT NULL DEFAULT 0,updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
INSERT INTO plan_catalog_new SELECT * FROM plan_catalog;
DROP TABLE plan_catalog;
ALTER TABLE plan_catalog_new RENAME TO plan_catalog;

-- Recreate triggers from 0013
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
CREATE TRIGGER billing_paid_immutable BEFORE UPDATE ON billing_orders WHEN OLD.status='paid' AND NEW.status<>'paid' BEGIN SELECT RAISE(ABORT,'paid_order_immutable'); END;
CREATE TRIGGER payment_payout_guard BEFORE INSERT ON payments WHEN NEW.subaccount_code IS NOT NULL BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM payout_accounts p JOIN events e ON e.owner_id=p.user_id WHERE e.id=NEW.event_id AND p.state='verified' AND p.subaccount_code=NEW.subaccount_code) THEN RAISE(ABORT,'payout_not_verified') END;
END;
CREATE TRIGGER payment_route_immutable BEFORE UPDATE OF subaccount_code,platform_fee_minor ON payments WHEN NEW.subaccount_code IS NOT OLD.subaccount_code OR NEW.platform_fee_minor<>OLD.platform_fee_minor BEGIN SELECT RAISE(ABORT,'payment_route_immutable'); END;
CREATE TRIGGER billing_snapshot_immutable BEFORE UPDATE OF event_id,owner_id,request_key,product_code,kind,tier,amount_minor,currency,limits_json ON billing_orders
 WHEN NEW.event_id IS NOT OLD.event_id OR NEW.owner_id IS NOT OLD.owner_id OR NEW.request_key IS NOT OLD.request_key OR NEW.product_code IS NOT OLD.product_code OR NEW.kind IS NOT OLD.kind OR NEW.tier IS NOT OLD.tier OR NEW.amount_minor IS NOT OLD.amount_minor OR NEW.currency IS NOT OLD.currency OR NEW.limits_json IS NOT OLD.limits_json
 BEGIN SELECT RAISE(ABORT,'billing_snapshot_immutable'); END;
CREATE TRIGGER payout_review_current BEFORE INSERT ON payout_review_guards BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM payout_accounts WHERE user_id=NEW.user_id AND request_id=NEW.request_id AND state=NEW.expected_state AND subaccount_code IS NEW.expected_subaccount) THEN RAISE(ABORT,'payout_review_changed') END;
END;
CREATE TRIGGER billing_event_open BEFORE INSERT ON billing_orders BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM events WHERE id=NEW.event_id AND lifecycle IN ('completed','archived')) THEN RAISE(ABORT,'billing_event_closed') END;
END;


-- Organizer-level recurring subscriptions (monthly/yearly), separate from per-event packages
CREATE TABLE organizer_subscriptions(
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plan_code TEXT NOT NULL REFERENCES plan_catalog(code),
  billing_interval TEXT NOT NULL CHECK(billing_interval IN ('month','year')),
  status TEXT NOT NULL CHECK(status IN ('incomplete','active','past_due','canceled','unpaid')),
  current_period_start TEXT NOT NULL,
  current_period_end TEXT NOT NULL,
  cancel_at TEXT,
  canceled_at TEXT,
  reference TEXT UNIQUE,
  checkout_url TEXT,
  last_verified_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_org_sub_user ON organizer_subscriptions(user_id,status);

-- Subscription entitlements: extra capacity applied to all owned events while active
CREATE TABLE subscription_entitlements(
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  guest_bonus INTEGER NOT NULL DEFAULT 0,
  occasion_bonus INTEGER NOT NULL DEFAULT 0,
  collaborator_bonus INTEGER NOT NULL DEFAULT 0,
  photo_bonus INTEGER NOT NULL DEFAULT 0,
  storage_bonus INTEGER NOT NULL DEFAULT 0,
  message_bonus INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Ownership transfer: owner initiates, target must accept with password+MFA
CREATE TABLE ownership_transfers(
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  from_user_id TEXT NOT NULL REFERENCES users(id),
  to_user_id TEXT NOT NULL REFERENCES users(id),
  to_email TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK(status IN ('pending','accepted','rejected','expired')),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  decided_at TEXT
);
CREATE INDEX idx_transfer_event ON ownership_transfers(event_id,status);

-- Refunds and disputes for contributions and package orders
CREATE TABLE refund_requests(
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK(kind IN ('contribution','package','subscription')),
  payment_reference TEXT REFERENCES payments(reference),
  billing_reference TEXT REFERENCES billing_orders(reference),
  subscription_id TEXT REFERENCES organizer_subscriptions(id),
  event_id TEXT REFERENCES events(id),
  requester_id TEXT NOT NULL REFERENCES users(id),
  amount_minor INTEGER NOT NULL CHECK(amount_minor>0),
  reason TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('requested','approved','processing','refunded','rejected','failed')),
  provider_refund_id TEXT,
  provider_status TEXT,
  reviewed_by TEXT REFERENCES users(id),
  reviewed_at TEXT,
  review_note TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_refund_event ON refund_requests(event_id,status);
CREATE INDEX idx_refund_payment ON refund_requests(payment_reference);

CREATE TABLE dispute_events(
  id TEXT PRIMARY KEY,
  payment_reference TEXT NOT NULL REFERENCES payments(reference),
  provider_dispute_id TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL,
  amount_minor INTEGER NOT NULL,
  reason TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Settlement accounting: Paystack settlements are ingested via API, not just webhooks
CREATE TABLE settlement_batches(
  id TEXT PRIMARY KEY,
  provider_batch_id TEXT UNIQUE,
  total_minor INTEGER NOT NULL DEFAULT 0,
  fee_minor INTEGER NOT NULL DEFAULT 0,
  net_minor INTEGER NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'NGN',
  settled_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE settlement_items(
  id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL REFERENCES settlement_batches(id) ON DELETE CASCADE,
  payment_reference TEXT NOT NULL REFERENCES payments(reference),
  subaccount_code TEXT,
  amount_minor INTEGER NOT NULL,
  fee_minor INTEGER NOT NULL DEFAULT 0,
  net_minor INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_settlement_item_ref ON settlement_items(payment_reference);
CREATE INDEX idx_settlement_item_sub ON settlement_items(subaccount_code);

-- Invoices / tax receipts: generated on paid package/subscription, not a legal tax filing by itself
CREATE TABLE invoices(
  id TEXT PRIMARY KEY,
  invoice_number TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL REFERENCES users(id),
  event_id TEXT REFERENCES events(id),
  billing_reference TEXT REFERENCES billing_orders(reference),
  subscription_id TEXT REFERENCES organizer_subscriptions(id),
  amount_minor INTEGER NOT NULL,
  tax_minor INTEGER NOT NULL DEFAULT 0,
  total_minor INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'NGN',
  status TEXT NOT NULL CHECK(status IN ('draft','issued','void')),
  issued_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_invoice_user ON invoices(user_id,issued_at);

-- Ticket inventory for ticketed events
CREATE TABLE ticket_types(
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  capacity INTEGER NOT NULL CHECK(capacity>=0),
  price_minor INTEGER NOT NULL CHECK(price_minor>=0),
  sold INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(event_id,name)
);
CREATE TABLE ticket_holds(
  id TEXT PRIMARY KEY,
  ticket_type_id TEXT NOT NULL REFERENCES ticket_types(id) ON DELETE CASCADE,
  guest_id TEXT NOT NULL REFERENCES guests(id) ON DELETE CASCADE,
  quantity INTEGER NOT NULL CHECK(quantity>0),
  status TEXT NOT NULL CHECK(status IN ('held','confirmed','released','expired')),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_ticket_hold_guest ON ticket_holds(guest_id,status);
CREATE TRIGGER ticket_capacity_guard BEFORE INSERT ON ticket_holds
WHEN NEW.status IN ('held','confirmed') BEGIN
  SELECT CASE WHEN (SELECT capacity FROM ticket_types WHERE id=NEW.ticket_type_id) < (SELECT COALESCE(SUM(quantity),0) FROM ticket_holds WHERE ticket_type_id=NEW.ticket_type_id AND status IN ('held','confirmed') AND id<>NEW.id) + NEW.quantity THEN RAISE(ABORT,'ticket_capacity') END;
END;

-- Transport, accommodation, registry, waitlist
CREATE TABLE transport_bookings(
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  guest_id TEXT NOT NULL REFERENCES guests(id) ON DELETE CASCADE,
  mode TEXT NOT NULL,
  details_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(details_json)),
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','confirmed','canceled')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE accommodations(
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  capacity INTEGER NOT NULL,
  allocated INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE accommodation_assignments(
  id TEXT PRIMARY KEY,
  accommodation_id TEXT NOT NULL REFERENCES accommodations(id) ON DELETE CASCADE,
  guest_id TEXT NOT NULL REFERENCES guests(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(accommodation_id,guest_id)
);
CREATE TABLE registry_items(
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  url TEXT,
  desired_quantity INTEGER NOT NULL DEFAULT 1,
  fulfilled_quantity INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE registry_fulfillments(
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL REFERENCES registry_items(id) ON DELETE CASCADE,
  guest_id TEXT REFERENCES guests(id) ON DELETE SET NULL,
  quantity INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE waitlist_entries(
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'waiting' CHECK(status IN ('waiting','invited','expired')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(event_id,email)
);

-- Messaging callbacks and suppression
CREATE TABLE message_events(
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  provider_event_id TEXT NOT NULL UNIQUE,
  channel TEXT NOT NULL,
  guest_id TEXT REFERENCES guests(id) ON DELETE SET NULL,
  announcement_id TEXT REFERENCES announcements(id) ON DELETE SET NULL,
  type TEXT NOT NULL CHECK(type IN ('delivered','bounced','complained','opened','clicked','failed')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE suppression_list(
  id TEXT PRIMARY KEY,
  channel TEXT NOT NULL,
  address TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(channel,address)
);
CREATE INDEX idx_suppression_addr ON suppression_list(channel,address);

-- Retention policies per category (configurable, not hard-coded 90d only)
CREATE TABLE retention_policies(
  category TEXT PRIMARY KEY CHECK(category IN ('analytics','media','announcements','audit','consents','payments','billing')),
  retain_days INTEGER NOT NULL CHECK(retain_days>=0),
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_by TEXT REFERENCES users(id)
);
INSERT INTO retention_policies(category,retain_days) VALUES
('analytics',90),('media',365),('announcements',365),('audit',365),('consents',365),('payments',2555),('billing',2555);

-- WebAuthn passkeys
CREATE TABLE webauthn_credentials(
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  credential_id TEXT NOT NULL UNIQUE,
  public_key TEXT NOT NULL,
  counter INTEGER NOT NULL DEFAULT 0,
  transports TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE webauthn_challenges(
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  challenge TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL CHECK(type IN ('registration','authentication')),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Turnstile attempts (abuse control, optional)
CREATE TABLE turnstile_verifications(
  id TEXT PRIMARY KEY,
  ip_hash TEXT NOT NULL,
  success INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Session attribution (richer device info, not PII-heavy)
ALTER TABLE sessions ADD COLUMN device_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(device_json));

-- Offline check-in queue with conflict resolution
CREATE TABLE offline_checkin_queue(
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  guest_id TEXT NOT NULL REFERENCES guests(id) ON DELETE CASCADE,
  checked_in_at TEXT NOT NULL,
  device_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  synced_at TEXT,
  UNIQUE(event_id,guest_id,device_id,checked_in_at)
);
CREATE INDEX idx_offline_pending ON offline_checkin_queue(event_id,synced_at);

-- Draft snapshots for invitation editor (offline draft store)
CREATE TABLE draft_snapshots(
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  content_json TEXT NOT NULL CHECK(json_valid(content_json)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_drafts_event_user ON draft_snapshots(event_id,user_id,created_at);

-- Scheduled announcements
CREATE TABLE scheduled_announcements(
  id TEXT PRIMARY KEY,
  announcement_id TEXT NOT NULL REFERENCES announcements(id) ON DELETE CASCADE,
  send_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'scheduled' CHECK(status IN ('scheduled','sent','canceled')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_scheduled_send ON scheduled_announcements(send_at,status);

-- Theme presets and localization
CREATE TABLE theme_presets(
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  theme_json TEXT NOT NULL CHECK(json_valid(theme_json)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(event_id,name)
);
CREATE TABLE event_translations(
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  locale TEXT NOT NULL CHECK(locale IN ('en','yo','ig','ha')),
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY(event_id,locale,key)
);

-- Plus-one / household extensions
ALTER TABLE guests ADD COLUMN plus_one_email TEXT;
ALTER TABLE guests ADD COLUMN plus_one_phone TEXT;
ALTER TABLE guests ADD COLUMN notes TEXT;
ALTER TABLE households ADD COLUMN notes TEXT;

-- Billing: add tax fields and settlement linkage
ALTER TABLE billing_orders ADD COLUMN tax_minor INTEGER NOT NULL DEFAULT 0;
ALTER TABLE billing_orders ADD COLUMN total_minor INTEGER NOT NULL DEFAULT 0;
ALTER TABLE billing_orders ADD COLUMN invoice_id TEXT REFERENCES invoices(id);
ALTER TABLE payments ADD COLUMN refunded_minor INTEGER NOT NULL DEFAULT 0;
ALTER TABLE payments ADD COLUMN settlement_batch_id TEXT REFERENCES settlement_batches(id);
ALTER TABLE payments ADD COLUMN settlement_status TEXT CHECK(settlement_status IN ('pending','settled','failed'));

-- Subscriptions catalog entries
INSERT INTO plan_catalog(code,name,kind,tier,price_minor,limits_json,active) VALUES
('organizer_starter','Organizer Starter','subscription',10,1500000,'{"guests":500,"occasions":10,"collaborators":10,"photos":1000,"storage":1073741824,"messages":1000}',0),
('organizer_pro','Organizer Pro','subscription',20,4000000,'{"guests":2000,"occasions":30,"collaborators":25,"photos":5000,"storage":5368709120,"messages":5000}',0);

-- Update existing entitlements to include subscription bonus (0 by default)
ALTER TABLE event_entitlements ADD COLUMN subscription_bonus_json TEXT NOT NULL DEFAULT '{"guests":0,"occasions":0,"collaborators":0,"photos":0,"storage":0,"messages":0}' CHECK(json_valid(subscription_bonus_json));
