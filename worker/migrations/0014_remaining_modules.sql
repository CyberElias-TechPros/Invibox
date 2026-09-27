-- Remaining product modules: subscriptions, ownership transfer, refunds/disputes, settlements, invoices/tax, tickets, transport/accommodation/registry/waitlist, messaging callbacks/suppression/scheduling, retention, passkeys, session attribution, offline queue, drafts, themes, localization
PRAGMA foreign_keys=ON;

-- Expand plan_catalog to allow subscription kind (SQLite needs FK off and trigger drop)
PRAGMA foreign_keys=OFF;
DROP TRIGGER IF EXISTS event_free_package;
CREATE TABLE plan_catalog_new(code TEXT PRIMARY KEY,name TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind IN ('plan','pack','subscription')),tier INTEGER NOT NULL DEFAULT 0,price_minor INTEGER NOT NULL CHECK(price_minor>=0),limits_json TEXT NOT NULL CHECK(json_valid(limits_json)),active INTEGER NOT NULL DEFAULT 0,updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
INSERT INTO plan_catalog_new SELECT * FROM plan_catalog;
DROP TABLE plan_catalog;
ALTER TABLE plan_catalog_new RENAME TO plan_catalog;
CREATE TRIGGER event_free_package AFTER INSERT ON events BEGIN
 INSERT INTO event_entitlements(event_id,guest_limit,occasion_limit,collaborator_limit,photo_limit,storage_limit,message_limit) SELECT NEW.id,json_extract(limits_json,'$.guests'),json_extract(limits_json,'$.occasions'),json_extract(limits_json,'$.collaborators'),json_extract(limits_json,'$.photos'),json_extract(limits_json,'$.storage'),json_extract(limits_json,'$.messages') FROM plan_catalog WHERE code='free';
END;
PRAGMA foreign_keys=ON;

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
