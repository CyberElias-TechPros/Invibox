-- Freeze the intended audience at enqueue time; later RSVP changes must not skip or add recipients.
CREATE TABLE announcement_recipients (
  announcement_id TEXT NOT NULL REFERENCES announcements(id) ON DELETE CASCADE,
  guest_id TEXT NOT NULL REFERENCES guests(id) ON DELETE CASCADE,
  PRIMARY KEY(announcement_id,guest_id)
);
INSERT OR IGNORE INTO announcement_recipients(announcement_id,guest_id)
SELECT a.id,g.id FROM announcements a JOIN guests g ON g.event_id=a.event_id LEFT JOIN guest_groups gg ON gg.id=g.group_id
WHERE a.status IN ('queued','processing','failed') AND (a.audience='all' OR (a.audience='pending' AND g.status='pending') OR (a.audience='attending' AND g.status='attending') OR (a.audience='vip' AND gg.name='VIP'));
CREATE TABLE notification_leases (
  announcement_id TEXT NOT NULL REFERENCES announcements(id) ON DELETE CASCADE,
  guest_id TEXT NOT NULL REFERENCES guests(id) ON DELETE CASCADE,
  lease_token TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY(announcement_id,guest_id)
);
CREATE INDEX idx_notification_leases_expiry ON notification_leases(expires_at);
