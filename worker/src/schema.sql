-- Flying Japan Luggage Storage - D1 Schema
-- Migrated from PostgreSQL (Supabase) to SQLite (Cloudflare D1)
-- All tables prefixed with luggage_ to avoid conflicts

-- Core: Orders
CREATE TABLE IF NOT EXISTS luggage_orders (
  order_id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  name TEXT,
  phone TEXT,
  email TEXT,
  companion_count INTEGER NOT NULL DEFAULT 0,
  suitcase_qty INTEGER NOT NULL DEFAULT 0,
  backpack_qty INTEGER NOT NULL DEFAULT 0,
  set_qty INTEGER NOT NULL DEFAULT 0,
  expected_pickup_at TEXT,
  actual_pickup_at TEXT,
  expected_storage_days INTEGER NOT NULL DEFAULT 0,
  actual_storage_days INTEGER NOT NULL DEFAULT 0,
  extra_days INTEGER NOT NULL DEFAULT 0,
  price_per_day INTEGER NOT NULL DEFAULT 0,
  discount_rate REAL NOT NULL DEFAULT 0,
  prepaid_amount INTEGER NOT NULL DEFAULT 0,
  flying_pass_tier TEXT NOT NULL DEFAULT 'NONE',
  flying_pass_discount_amount INTEGER NOT NULL DEFAULT 0,
  staff_prepaid_override_amount INTEGER,
  extra_amount INTEGER NOT NULL DEFAULT 0,
  final_amount INTEGER NOT NULL DEFAULT 0,
  payment_method TEXT,
  status TEXT NOT NULL DEFAULT 'PAYMENT_PENDING',
  tag_no TEXT,
  note TEXT,
  id_image_url TEXT,
  luggage_image_url TEXT,
  view_token TEXT,
  consent_checked INTEGER NOT NULL DEFAULT 0,
  manual_entry INTEGER NOT NULL DEFAULT 0,
  staff_id TEXT,
  parent_order_id TEXT,
  extension_date TEXT,
  in_warehouse INTEGER NOT NULL DEFAULT 0
);

-- Actual tender allocations recorded by staff at payment time.
-- payment_method on luggage_orders remains as the customer's requested/legacy method.
CREATE TABLE IF NOT EXISTS luggage_order_payments (
  payment_id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id TEXT NOT NULL,
  business_date TEXT NOT NULL,
  tender_type TEXT NOT NULL CHECK (tender_type IN ('CASH', 'PAY_QR')),
  amount INTEGER NOT NULL CHECK (amount >= 0),
  staff_id TEXT,
  recorded_at TEXT NOT NULL DEFAULT (datetime('now')),
  receipt_request_id TEXT,
  FOREIGN KEY (order_id) REFERENCES luggage_orders(order_id)
);

CREATE TABLE IF NOT EXISTS luggage_referral_counts (
  business_date TEXT NOT NULL,
  floor TEXT NOT NULL CHECK (floor IN ('4F', '8F')),
  count INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (business_date, floor)
);

-- Core: Audit logs for image views
CREATE TABLE IF NOT EXISTS luggage_audit_logs (
  log_id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id TEXT,
  staff_id TEXT,
  device_id TEXT,
  action TEXT NOT NULL,
  details TEXT,
  timestamp TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Core: Daily order ID sequence
CREATE TABLE IF NOT EXISTS luggage_daily_counters (
  business_date TEXT PRIMARY KEY,
  last_seq INTEGER NOT NULL DEFAULT 0
);

-- Core: Daily tag number sequence
CREATE TABLE IF NOT EXISTS luggage_daily_tag_counters (
  business_date TEXT PRIMARY KEY,
  last_seq INTEGER NOT NULL DEFAULT 0
);

-- Operations: Lost & Found
CREATE TABLE IF NOT EXISTS luggage_lost_found_entries (
  entry_id INTEGER PRIMARY KEY AUTOINCREMENT,
  found_at TEXT,
  item_name TEXT,
  quantity INTEGER NOT NULL DEFAULT 1,
  found_location TEXT,
  status TEXT NOT NULL DEFAULT 'UNCLAIMED',
  claimed_by TEXT,
  note TEXT,
  staff_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Operations: Handover notes
CREATE TABLE IF NOT EXISTS luggage_handover_notes (
  note_id INTEGER PRIMARY KEY AUTOINCREMENT,
  category TEXT,
  title TEXT,
  content TEXT,
  is_pinned INTEGER NOT NULL DEFAULT 0,
  staff_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Operations: Handover read tracking
CREATE TABLE IF NOT EXISTS luggage_handover_reads (
  read_id INTEGER PRIMARY KEY AUTOINCREMENT,
  note_id INTEGER NOT NULL,
  staff_id TEXT NOT NULL,
  read_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Operations: Handover comments
CREATE TABLE IF NOT EXISTS luggage_handover_comments (
  comment_id INTEGER PRIMARY KEY AUTOINCREMENT,
  note_id INTEGER NOT NULL,
  staff_id TEXT NOT NULL,
  content TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Operations: Handover edit history
CREATE TABLE IF NOT EXISTS luggage_handover_edits (
  edit_id INTEGER PRIMARY KEY AUTOINCREMENT,
  note_id INTEGER NOT NULL,
  staff_id TEXT NOT NULL,
  old_title TEXT,
  old_content TEXT,
  new_title TEXT,
  new_content TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Operations: Cash closing
CREATE TABLE IF NOT EXISTS luggage_cash_closings (
  closing_id INTEGER PRIMARY KEY AUTOINCREMENT,
  business_date TEXT,
  closing_type TEXT NOT NULL DEFAULT 'EVENING',
  workflow_status TEXT NOT NULL DEFAULT 'DRAFT',
  count_10000 INTEGER NOT NULL DEFAULT 0,
  count_5000 INTEGER NOT NULL DEFAULT 0,
  count_2000 INTEGER NOT NULL DEFAULT 0,
  count_1000 INTEGER NOT NULL DEFAULT 0,
  count_500 INTEGER NOT NULL DEFAULT 0,
  count_100 INTEGER NOT NULL DEFAULT 0,
  count_50 INTEGER NOT NULL DEFAULT 0,
  count_10 INTEGER NOT NULL DEFAULT 0,
  count_5 INTEGER NOT NULL DEFAULT 0,
  count_1 INTEGER NOT NULL DEFAULT 0,
  total_amount INTEGER NOT NULL DEFAULT 0,
  paypay_amount INTEGER NOT NULL DEFAULT 0,
  actual_qr_amount INTEGER NOT NULL DEFAULT 0,
  qr_difference_amount INTEGER NOT NULL DEFAULT 0,
  check_auto_amount INTEGER NOT NULL DEFAULT 0,
  expected_amount INTEGER NOT NULL DEFAULT 0,
  actual_amount INTEGER NOT NULL DEFAULT 0,
  difference_amount INTEGER NOT NULL DEFAULT 0,
  submitted_by_staff_id TEXT,
  submitted_at TEXT,
  verified_by_staff_id TEXT,
  verified_at TEXT,
  check_cash_match INTEGER NOT NULL DEFAULT 0,
  check_qr_match INTEGER NOT NULL DEFAULT 0,
  check_pending_items INTEGER NOT NULL DEFAULT 0,
  check_handover_note INTEGER NOT NULL DEFAULT 0,
  floor_4f_count INTEGER NOT NULL DEFAULT 0,
  floor_8f_count INTEGER NOT NULL DEFAULT 0,
  owner_name TEXT,
  note TEXT,
  staff_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Operations: Cash closing audit trail
CREATE TABLE IF NOT EXISTS luggage_cash_closing_audits (
  audit_id INTEGER PRIMARY KEY AUTOINCREMENT,
  closing_id INTEGER NOT NULL,
  action TEXT NOT NULL,
  reason TEXT,
  payload TEXT,
  staff_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- DEPRECATED: JPY-converted rental sales (unit_price x quantity / 9.5). No longer written or read;
-- replaced by luggage_naver_rental_daily_sales. Kept only as a historical record.
CREATE TABLE IF NOT EXISTS luggage_rental_daily_sales (
  rental_id INTEGER PRIMARY KEY AUTOINCREMENT,
  business_date TEXT UNIQUE,
  revenue_amount INTEGER NOT NULL DEFAULT 0,
  customer_count INTEGER NOT NULL DEFAULT 0,
  note TEXT,
  staff_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_rental_daily_sales_date ON luggage_rental_daily_sales(business_date);

-- Analytics: Naver (online) rental daily revenue in KRW, synced from Supabase product_orders via cron.
-- Same formula as the center dashboard /revenue page. Never converted to JPY or added to luggage totals.
CREATE TABLE IF NOT EXISTS luggage_naver_rental_daily_sales (
  business_date TEXT PRIMARY KEY,
  revenue_krw INTEGER NOT NULL DEFAULT 0,
  order_count INTEGER NOT NULL DEFAULT 0,
  synced_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Config: App settings (key-value)
CREATE TABLE IF NOT EXISTS luggage_app_settings (
  setting_id INTEGER PRIMARY KEY AUTOINCREMENT,
  setting_key TEXT UNIQUE NOT NULL,
  setting_value TEXT,
  staff_id TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Config: Work schedules
CREATE TABLE IF NOT EXISTS luggage_work_schedules (
  schedule_id INTEGER PRIMARY KEY AUTOINCREMENT,
  work_date TEXT,
  staff_name TEXT,
  start_time TEXT,
  end_time TEXT,
  role TEXT,
  note TEXT,
  created_by_staff_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Daily sales (imported from Google Sheets — luggage + rental combined)
CREATE TABLE IF NOT EXISTS luggage_daily_sales (
  sale_date TEXT PRIMARY KEY,
  people INTEGER NOT NULL DEFAULT 0,
  cash INTEGER NOT NULL DEFAULT 0,
  qr INTEGER NOT NULL DEFAULT 0,
  luggage_total INTEGER NOT NULL DEFAULT 0,
  rental_total INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Operations: Handover mentions
CREATE TABLE IF NOT EXISTS luggage_handover_mentions (
  mention_id INTEGER PRIMARY KEY AUTOINCREMENT,
  note_id INTEGER NOT NULL,
  comment_id INTEGER,
  staff_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_handover_mentions_staff ON luggage_handover_mentions(staff_id);
CREATE INDEX IF NOT EXISTS idx_handover_mentions_note ON luggage_handover_mentions(note_id);

-- Tag pool: static reference table for same-day tags 1-145 (read-only after seed)
CREATE TABLE IF NOT EXISTS luggage_tag_pool (
  tag_no INTEGER PRIMARY KEY  -- 1 to 145
);
-- Seed/expand tag pool (INSERT OR IGNORE keeps existing 1-90 rows intact)
INSERT OR IGNORE INTO luggage_tag_pool (tag_no) VALUES
  (1),(2),(3),(4),(5),(6),(7),(8),(9),(10),
  (11),(12),(13),(14),(15),(16),(17),(18),(19),(20),
  (21),(22),(23),(24),(25),(26),(27),(28),(29),(30),
  (31),(32),(33),(34),(35),(36),(37),(38),(39),(40),
  (41),(42),(43),(44),(45),(46),(47),(48),(49),(50),
  (51),(52),(53),(54),(55),(56),(57),(58),(59),(60),
  (61),(62),(63),(64),(65),(66),(67),(68),(69),(70),
  (71),(72),(73),(74),(75),(76),(77),(78),(79),(80),
  (81),(82),(83),(84),(85),(86),(87),(88),(89),(90),
  (91),(92),(93),(94),(95),(96),(97),(98),(99),(100),
  (101),(102),(103),(104),(105),(106),(107),(108),(109),(110),
  (111),(112),(113),(114),(115),(116),(117),(118),(119),(120),
  (121),(122),(123),(124),(125),(126),(127),(128),(129),(130),
  (131),(132),(133),(134),(135),(136),(137),(138),(139),(140),
  (141),(142),(143),(144),(145);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_luggage_orders_status ON luggage_orders(status);
CREATE INDEX IF NOT EXISTS idx_luggage_orders_created_at ON luggage_orders(created_at);
CREATE INDEX IF NOT EXISTS idx_luggage_orders_in_warehouse ON luggage_orders(in_warehouse) WHERE in_warehouse = 1;
CREATE INDEX IF NOT EXISTS idx_luggage_orders_parent_order_id ON luggage_orders(parent_order_id) WHERE parent_order_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_luggage_order_payments_order_id ON luggage_order_payments(order_id);
CREATE INDEX IF NOT EXISTS idx_luggage_order_payments_business_date ON luggage_order_payments(business_date);
CREATE INDEX IF NOT EXISTS idx_luggage_audit_logs_order_id ON luggage_audit_logs(order_id);
CREATE INDEX IF NOT EXISTS idx_luggage_handover_notes_created ON luggage_handover_notes(created_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_cash_closings_date_type ON luggage_cash_closings(business_date, closing_type);
CREATE INDEX IF NOT EXISTS idx_luggage_cash_closings_date ON luggage_cash_closings(business_date);

-- Structured experience rentals; the existing experience visits table is retained.
CREATE TABLE IF NOT EXISTS luggage_experience_rentals (
  rental_id INTEGER PRIMARY KEY AUTOINCREMENT,
  visit_id INTEGER NOT NULL REFERENCES luggage_experience_visits(visit_id) ON DELETE CASCADE,
  product_group TEXT NOT NULL CHECK (product_group IN (
    '에어랩', '에어스트레이트', '트라이크', '싸이벡스', '보조배터리', '밴드',
    '지팡이', '키즈트래블', '머리띠', '폴라로이드 카메라', '풀리오'
  )),
  quantity INTEGER NOT NULL CHECK (typeof(quantity) = 'integer' AND quantity > 0 AND quantity <= 9007199254740991),
  start_date TEXT NOT NULL CHECK (
    start_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
    AND start_date >= '0001-01-01' AND date(start_date, '+0 days') IS NOT NULL
    AND date(start_date, '+0 days') = start_date
  ),
  end_date TEXT NOT NULL CHECK (
    end_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
    AND date(end_date, '+0 days') IS NOT NULL AND date(end_date, '+0 days') = end_date
    AND end_date >= start_date
  ),
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_experience_rentals_visit ON luggage_experience_rentals(visit_id);
CREATE INDEX IF NOT EXISTS idx_experience_rentals_dates ON luggage_experience_rentals(start_date, end_date);

-- Phase 1 only: no billing/sales View changes. Public routes remain settlement-gated.
CREATE TABLE IF NOT EXISTS luggage_flying_pass_refunds (
  refund_id TEXT NOT NULL PRIMARY KEY CHECK (length(refund_id) = 36),
  order_id TEXT NOT NULL REFERENCES luggage_orders(order_id),
  sequence INTEGER NOT NULL CHECK (typeof(sequence) = 'integer' AND sequence > 0),
  previous_refund_id TEXT REFERENCES luggage_flying_pass_refunds(refund_id),
  status TEXT NOT NULL CHECK (status IN ('PAYOUT_PENDING', 'CONFIRMED', 'CANCELLED')),
  currency TEXT NOT NULL DEFAULT 'JPY' CHECK (currency = 'JPY'),
  refund_method TEXT NOT NULL DEFAULT 'CASH' CHECK (refund_method = 'CASH'),
  before_tier TEXT NOT NULL CHECK (before_tier IN ('NONE','BLUE','SILVER','GOLD','PLATINUM','BLACK')),
  after_tier TEXT NOT NULL CHECK (after_tier IN ('BLUE','SILVER','GOLD','PLATINUM','BLACK')),
  original_amount INTEGER NOT NULL CHECK (typeof(original_amount) = 'integer' AND original_amount BETWEEN 1 AND 500000),
  before_amount INTEGER NOT NULL CHECK (typeof(before_amount) = 'integer' AND before_amount BETWEEN 1 AND original_amount),
  after_amount INTEGER NOT NULL CHECK (typeof(after_amount) = 'integer' AND after_amount >= 0),
  amount INTEGER NOT NULL CHECK (typeof(amount) = 'integer' AND amount BETWEEN 1 AND 500000 AND amount = before_amount - after_amount),
  reason TEXT NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 200),
  request_hash TEXT NOT NULL CHECK (length(request_hash) = 64),
  root_snapshot TEXT NOT NULL CHECK (json_valid(root_snapshot)),
  receipt_snapshot TEXT NOT NULL CHECK (json_valid(receipt_snapshot)),
  registered_by_staff_id TEXT NOT NULL CHECK (length(trim(registered_by_staff_id)) > 0),
  actor_user_id TEXT NOT NULL CHECK (length(trim(actor_user_id)) > 0),
  business_date TEXT NOT NULL,
  created_at TEXT NOT NULL,
  register_audit_id INTEGER NOT NULL UNIQUE REFERENCES luggage_audit_logs(log_id),
  terminal_hash TEXT,
  terminal_by_staff_id TEXT,
  terminal_at TEXT,
  terminal_audit_id INTEGER UNIQUE REFERENCES luggage_audit_logs(log_id),
  paid_at TEXT,
  cancel_reason TEXT,
  UNIQUE(order_id, sequence),
  CHECK (julianday(created_at) IS NOT NULL AND business_date = date(created_at, '+9 hours')),
  CHECK ((status = 'PAYOUT_PENDING' AND terminal_hash IS NULL AND terminal_by_staff_id IS NULL AND terminal_at IS NULL AND terminal_audit_id IS NULL AND paid_at IS NULL AND cancel_reason IS NULL)
    OR (status = 'CONFIRMED' AND terminal_hash IS NOT NULL AND length(terminal_hash) = 64 AND terminal_by_staff_id IS NOT NULL AND terminal_at IS NOT NULL AND terminal_audit_id IS NOT NULL AND julianday(paid_at) IS NOT NULL AND cancel_reason IS NULL
      AND ((paid_at = terminal_at AND date(paid_at, '+9 hours') = business_date)
        OR (julianday(paid_at) >= julianday(created_at) AND julianday(paid_at) < julianday(terminal_at) AND business_date < date(terminal_at, '+9 hours'))))
    OR (status = 'CANCELLED' AND terminal_hash IS NOT NULL AND length(terminal_hash) = 64 AND terminal_by_staff_id IS NOT NULL AND terminal_at IS NOT NULL AND terminal_audit_id IS NOT NULL AND paid_at IS NULL AND cancel_reason IS NOT NULL AND length(trim(cancel_reason)) BETWEEN 1 AND 200)),
  CHECK (status = 'PAYOUT_PENDING' OR (julianday(terminal_at) IS NOT NULL AND julianday(terminal_at) >= julianday(created_at)))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_flying_pass_refund_pending ON luggage_flying_pass_refunds(order_id) WHERE status = 'PAYOUT_PENDING';
CREATE INDEX IF NOT EXISTS idx_flying_pass_refund_day ON luggage_flying_pass_refunds(business_date, status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_flying_pass_refund_audit ON luggage_audit_logs(device_id, action)
  WHERE action IN ('FLYING_PASS_REFUND_REGISTER','FLYING_PASS_REFUND_CONFIRM','FLYING_PASS_REFUND_CANCEL');

CREATE TRIGGER IF NOT EXISTS luggage_refund_insert_guard BEFORE INSERT ON luggage_flying_pass_refunds
BEGIN
  SELECT CASE WHEN EXISTS (SELECT 1 FROM luggage_flying_pass_refunds WHERE refund_id = NEW.refund_id)
    OR NEW.status != 'PAYOUT_PENDING' OR NEW.business_date != date('now', '+9 hours')
    OR NOT EXISTS (SELECT 1 FROM luggage_orders o JOIN luggage_billing_balances b ON b.root_id = o.order_id
      WHERE o.order_id = NEW.order_id AND o.parent_order_id IS NULL AND o.status = 'PAID'
        AND o.staff_prepaid_override_amount IS NULL AND o.final_amount = NEW.original_amount AND o.prepaid_amount = o.final_amount
        AND b.invalid_amount = 0 AND b.root_review_required = 0 AND b.review_pickup_blocked = 0
        AND b.outstanding_amount = 0 AND b.unbilled_days = 0 AND b.legacy_paid_estimate = 0
        AND EXISTS (SELECT 1 FROM luggage_order_payments p WHERE p.order_id = o.order_id)
        AND (SELECT SUM(amount) FROM luggage_order_payments p WHERE p.order_id = o.order_id) = o.final_amount + o.extra_amount)

    OR NEW.root_snapshot IS NOT (SELECT json_object('order_id',order_id,'parent_order_id',parent_order_id,'status',status,'created_at',created_at,'prepaid_amount',prepaid_amount,'final_amount',final_amount,'extra_amount',extra_amount,'price_per_day',price_per_day,'expected_storage_days',expected_storage_days,'flying_pass_tier',flying_pass_tier,'flying_pass_discount_amount',flying_pass_discount_amount,'staff_prepaid_override_amount',staff_prepaid_override_amount,'suitcase_qty',suitcase_qty,'backpack_qty',backpack_qty,'set_qty',set_qty,'expected_pickup_at',expected_pickup_at,'extension_date',extension_date) FROM luggage_orders WHERE order_id = NEW.order_id)
    OR NEW.receipt_snapshot IS NOT (SELECT json_group_array(json_object('payment_id',payment_id,'tender_type',tender_type,'amount',amount,'business_date',business_date,'recorded_at',recorded_at,'staff_id',staff_id,'receipt_request_id',receipt_request_id)) FROM (SELECT * FROM luggage_order_payments WHERE order_id = NEW.order_id ORDER BY payment_id))
    OR EXISTS (SELECT 1 FROM luggage_cash_closings WHERE business_date = NEW.business_date AND closing_type = 'FINAL_CLOSE')
    OR EXISTS (SELECT 1 FROM luggage_flying_pass_refunds WHERE order_id = NEW.order_id AND status = 'PAYOUT_PENDING')
    OR NEW.sequence != COALESCE((SELECT MAX(sequence) FROM luggage_flying_pass_refunds WHERE order_id = NEW.order_id), 0) + 1
    OR NEW.previous_refund_id IS NOT (SELECT refund_id FROM luggage_flying_pass_refunds WHERE order_id = NEW.order_id AND status = 'CONFIRMED' ORDER BY sequence DESC LIMIT 1)
    OR NEW.before_amount != NEW.original_amount - COALESCE((SELECT SUM(amount) FROM luggage_flying_pass_refunds WHERE order_id = NEW.order_id AND status = 'CONFIRMED'), 0)
    OR NEW.before_tier != COALESCE((SELECT after_tier FROM luggage_flying_pass_refunds WHERE order_id = NEW.order_id AND status = 'CONFIRMED' ORDER BY sequence DESC LIMIT 1),
      (SELECT flying_pass_tier FROM luggage_orders WHERE order_id = NEW.order_id))
    OR NOT EXISTS (SELECT 1 FROM luggage_audit_logs a WHERE a.log_id = NEW.register_audit_id AND a.order_id = NEW.order_id
      AND a.device_id = NEW.refund_id AND a.action = 'FLYING_PASS_REFUND_REGISTER' AND a.staff_id = NEW.registered_by_staff_id
      AND json_valid(a.details) AND json_extract(a.details, '$.requestHash') = NEW.request_hash
      AND json_extract(a.details, '$.amount') = NEW.amount
      AND json_extract(a.details, '$.beforeTier') = NEW.before_tier AND json_extract(a.details, '$.afterTier') = NEW.after_tier
      AND json_extract(a.details, '$.beforeAmount') = NEW.before_amount AND json_extract(a.details, '$.afterAmount') = NEW.after_amount AND json_extract(a.details, '$.actor.userId') = NEW.actor_user_id)
    THEN RAISE(ABORT, 'REFUND_REGISTRATION_CONFLICT') END;
END;

CREATE TRIGGER IF NOT EXISTS luggage_refund_transition_guard BEFORE UPDATE ON luggage_flying_pass_refunds
BEGIN
  SELECT CASE WHEN OLD.status != 'PAYOUT_PENDING' OR NEW.status NOT IN ('CONFIRMED','CANCELLED')
    OR NEW.refund_id IS NOT OLD.refund_id OR NEW.order_id IS NOT OLD.order_id OR NEW.sequence IS NOT OLD.sequence
    OR NEW.previous_refund_id IS NOT OLD.previous_refund_id OR NEW.currency IS NOT OLD.currency OR NEW.refund_method IS NOT OLD.refund_method
    OR NEW.before_tier IS NOT OLD.before_tier OR NEW.after_tier IS NOT OLD.after_tier
    OR NEW.original_amount IS NOT OLD.original_amount OR NEW.before_amount IS NOT OLD.before_amount OR NEW.after_amount IS NOT OLD.after_amount OR NEW.amount IS NOT OLD.amount
    OR NEW.reason IS NOT OLD.reason OR NEW.request_hash IS NOT OLD.request_hash OR NEW.root_snapshot IS NOT OLD.root_snapshot OR NEW.receipt_snapshot IS NOT OLD.receipt_snapshot
    OR NEW.registered_by_staff_id IS NOT OLD.registered_by_staff_id OR NEW.actor_user_id IS NOT OLD.actor_user_id
    OR NEW.business_date IS NOT OLD.business_date OR NEW.created_at IS NOT OLD.created_at OR NEW.register_audit_id IS NOT OLD.register_audit_id
    OR NOT EXISTS (SELECT 1 FROM luggage_audit_logs a WHERE a.log_id = NEW.terminal_audit_id AND a.order_id = NEW.order_id AND a.device_id = NEW.refund_id
      AND a.staff_id = NEW.terminal_by_staff_id AND a.action = CASE NEW.status WHEN 'CONFIRMED' THEN 'FLYING_PASS_REFUND_CONFIRM' ELSE 'FLYING_PASS_REFUND_CANCEL' END
      AND json_valid(a.details) AND json_extract(a.details, '$.terminalHash') = NEW.terminal_hash
      AND length(trim(COALESCE(json_extract(a.details, '$.actor.userId'), ''))) > 0 AND json_extract(a.details, '$.legacyStaff.id') = NEW.terminal_by_staff_id
      AND CASE NEW.status WHEN 'CONFIRMED' THEN json_extract(a.details, '$.cashPaid') = 1 ELSE json_extract(a.details, '$.confirmNotPaid') = 1 END)
    THEN RAISE(ABORT, 'REFUND_IMMUTABLE_OR_INVALID_TRANSITION') END;
  SELECT CASE WHEN NEW.status = 'CONFIRMED' AND (
    CASE WHEN json_extract((SELECT details FROM luggage_audit_logs WHERE log_id = NEW.terminal_audit_id), '$.lateConfirm') IS NULL
      THEN NEW.business_date != date('now', '+9 hours') OR NEW.paid_at IS NOT NEW.terminal_at
      ELSE NEW.business_date >= date('now', '+9 hours') OR julianday(NEW.paid_at) IS NULL
        OR julianday(NEW.paid_at) < julianday(NEW.created_at) OR julianday(NEW.paid_at) > julianday('now')
        OR NEW.paid_at IS NOT json_extract((SELECT details FROM luggage_audit_logs WHERE log_id = NEW.terminal_audit_id), '$.lateConfirm.paidAt')
        OR length(trim(COALESCE(json_extract((SELECT details FROM luggage_audit_logs WHERE log_id = NEW.terminal_audit_id), '$.lateConfirm.reason'), ''))) NOT BETWEEN 1 AND 200
        OR COALESCE(json_extract((SELECT details FROM luggage_audit_logs WHERE log_id = NEW.terminal_audit_id), '$.actor.role'), '') NOT IN ('manager', 'super_admin')
    END
    OR NEW.root_snapshot IS NOT (SELECT json_object('order_id',order_id,'parent_order_id',parent_order_id,'status',status,'created_at',created_at,'prepaid_amount',prepaid_amount,'final_amount',final_amount,'extra_amount',extra_amount,'price_per_day',price_per_day,'expected_storage_days',expected_storage_days,'flying_pass_tier',flying_pass_tier,'flying_pass_discount_amount',flying_pass_discount_amount,'staff_prepaid_override_amount',staff_prepaid_override_amount,'suitcase_qty',suitcase_qty,'backpack_qty',backpack_qty,'set_qty',set_qty,'expected_pickup_at',expected_pickup_at,'extension_date',extension_date) FROM luggage_orders WHERE order_id = NEW.order_id)
    OR NEW.receipt_snapshot IS NOT (SELECT json_group_array(json_object('payment_id',payment_id,'tender_type',tender_type,'amount',amount,'business_date',business_date,'recorded_at',recorded_at,'staff_id',staff_id,'receipt_request_id',receipt_request_id)) FROM (SELECT * FROM luggage_order_payments WHERE order_id = NEW.order_id ORDER BY payment_id))
    OR EXISTS (SELECT 1 FROM luggage_cash_closings WHERE business_date = date(NEW.paid_at, '+9 hours') AND closing_type = 'FINAL_CLOSE')
    OR NOT EXISTS (SELECT 1 FROM luggage_orders o JOIN luggage_billing_balances b ON b.root_id = o.order_id
      WHERE o.order_id = NEW.order_id AND o.status = 'PAID' AND o.parent_order_id IS NULL AND o.staff_prepaid_override_amount IS NULL
        AND o.final_amount = NEW.original_amount AND o.prepaid_amount = o.final_amount
        AND b.invalid_amount = 0 AND b.root_review_required = 0 AND b.review_pickup_blocked = 0 AND b.outstanding_amount = 0 AND b.unbilled_days = 0 AND b.legacy_paid_estimate = 0
        AND (SELECT SUM(amount) FROM luggage_order_payments p WHERE p.order_id = o.order_id) = o.final_amount + o.extra_amount)
    OR NEW.before_amount != NEW.original_amount - COALESCE((SELECT SUM(amount) FROM luggage_flying_pass_refunds WHERE order_id = NEW.order_id AND status = 'CONFIRMED'), 0)
    OR NEW.previous_refund_id IS NOT (SELECT refund_id FROM luggage_flying_pass_refunds WHERE order_id = NEW.order_id AND status = 'CONFIRMED' ORDER BY sequence DESC LIMIT 1))
    THEN RAISE(ABORT, 'REFUND_CONFIRMATION_CONFLICT') END;
END;
CREATE TRIGGER IF NOT EXISTS luggage_refund_no_delete BEFORE DELETE ON luggage_flying_pass_refunds
BEGIN SELECT RAISE(ABORT, 'REFUND_IMMUTABLE'); END;

CREATE TRIGGER IF NOT EXISTS luggage_refund_preserve_order_insert BEFORE INSERT ON luggage_orders
WHEN EXISTS (SELECT 1 FROM luggage_flying_pass_refunds WHERE order_id = NEW.order_id)
BEGIN SELECT RAISE(ABORT, 'REFUND_PRESERVE_ORIGINAL_ORDER'); END;
CREATE TRIGGER IF NOT EXISTS luggage_refund_preserve_order BEFORE UPDATE ON luggage_orders
WHEN EXISTS (SELECT 1 FROM luggage_flying_pass_refunds WHERE order_id = OLD.order_id AND status IN ('PAYOUT_PENDING','CONFIRMED'))
  AND (NEW.order_id IS NOT OLD.order_id OR NEW.status IS NOT OLD.status OR NEW.parent_order_id IS NOT OLD.parent_order_id
    OR NEW.prepaid_amount IS NOT OLD.prepaid_amount OR NEW.final_amount IS NOT OLD.final_amount OR NEW.extra_amount IS NOT OLD.extra_amount
    OR NEW.flying_pass_tier IS NOT OLD.flying_pass_tier OR NEW.flying_pass_discount_amount IS NOT OLD.flying_pass_discount_amount
    OR NEW.staff_prepaid_override_amount IS NOT OLD.staff_prepaid_override_amount OR NEW.price_per_day IS NOT OLD.price_per_day
    OR NEW.expected_storage_days IS NOT OLD.expected_storage_days OR NEW.expected_pickup_at IS NOT OLD.expected_pickup_at
    OR NEW.created_at IS NOT OLD.created_at OR NEW.suitcase_qty IS NOT OLD.suitcase_qty OR NEW.backpack_qty IS NOT OLD.backpack_qty OR NEW.set_qty IS NOT OLD.set_qty
    OR NEW.extension_date IS NOT OLD.extension_date)
BEGIN SELECT RAISE(ABORT, 'REFUND_SETTLEMENT_NOT_READY'); END;
CREATE TRIGGER IF NOT EXISTS luggage_refund_preserve_order_delete BEFORE DELETE ON luggage_orders
WHEN EXISTS (SELECT 1 FROM luggage_flying_pass_refunds WHERE order_id = OLD.order_id)
BEGIN SELECT RAISE(ABORT, 'REFUND_PRESERVE_ORIGINAL_ORDER'); END;
CREATE TRIGGER IF NOT EXISTS luggage_refund_preserve_receipt_insert BEFORE INSERT ON luggage_order_payments
WHEN EXISTS (SELECT 1 FROM luggage_flying_pass_refunds f WHERE f.status IN ('PAYOUT_PENDING','CONFIRMED') AND (f.order_id = NEW.order_id
  OR EXISTS (SELECT 1 FROM luggage_order_payments p WHERE p.payment_id = NEW.payment_id AND p.order_id = f.order_id)))
BEGIN SELECT RAISE(ABORT, 'REFUND_PRESERVE_ORIGINAL_RECEIPT'); END;
CREATE TRIGGER IF NOT EXISTS luggage_refund_preserve_receipt_update BEFORE UPDATE ON luggage_order_payments
WHEN EXISTS (SELECT 1 FROM luggage_flying_pass_refunds WHERE order_id IN (OLD.order_id, NEW.order_id) AND status IN ('PAYOUT_PENDING','CONFIRMED'))
BEGIN SELECT RAISE(ABORT, 'REFUND_PRESERVE_ORIGINAL_RECEIPT'); END;
CREATE TRIGGER IF NOT EXISTS luggage_refund_preserve_receipt_delete BEFORE DELETE ON luggage_order_payments
WHEN EXISTS (SELECT 1 FROM luggage_flying_pass_refunds WHERE order_id = OLD.order_id AND status IN ('PAYOUT_PENDING','CONFIRMED'))
BEGIN SELECT RAISE(ABORT, 'REFUND_PRESERVE_ORIGINAL_RECEIPT'); END;
CREATE TRIGGER IF NOT EXISTS luggage_refund_preserve_audit_insert BEFORE INSERT ON luggage_audit_logs
WHEN EXISTS (SELECT 1 FROM luggage_flying_pass_refunds WHERE register_audit_id = NEW.log_id OR terminal_audit_id = NEW.log_id)
BEGIN SELECT RAISE(ABORT, 'REFUND_PRESERVE_AUDIT'); END;
CREATE TRIGGER IF NOT EXISTS luggage_refund_preserve_audit_update BEFORE UPDATE ON luggage_audit_logs
WHEN EXISTS (SELECT 1 FROM luggage_flying_pass_refunds WHERE register_audit_id = OLD.log_id OR terminal_audit_id = OLD.log_id)
BEGIN SELECT RAISE(ABORT, 'REFUND_PRESERVE_AUDIT'); END;
CREATE TRIGGER IF NOT EXISTS luggage_refund_preserve_audit_delete BEFORE DELETE ON luggage_audit_logs
WHEN EXISTS (SELECT 1 FROM luggage_flying_pass_refunds WHERE register_audit_id = OLD.log_id OR terminal_audit_id = OLD.log_id)
BEGIN SELECT RAISE(ABORT, 'REFUND_PRESERVE_AUDIT'); END;

-- Remove/replace these holds only with the later settlement integration, never by enabling a flag.
CREATE TRIGGER IF NOT EXISTS luggage_refund_phase1_closing_insert BEFORE INSERT ON luggage_cash_closings
WHEN NEW.closing_type = 'FINAL_CLOSE' AND EXISTS (SELECT 1 FROM luggage_flying_pass_refunds WHERE business_date = NEW.business_date AND status IN ('PAYOUT_PENDING','CONFIRMED'))
BEGIN SELECT RAISE(ABORT, 'REFUND_SETTLEMENT_NOT_READY'); END;
CREATE TRIGGER IF NOT EXISTS luggage_refund_phase1_closing_update BEFORE UPDATE ON luggage_cash_closings
WHEN NEW.closing_type = 'FINAL_CLOSE' AND EXISTS (SELECT 1 FROM luggage_flying_pass_refunds WHERE business_date = NEW.business_date AND status IN ('PAYOUT_PENDING','CONFIRMED'))
BEGIN SELECT RAISE(ABORT, 'REFUND_SETTLEMENT_NOT_READY'); END;

-- Extension billing and receipt guards (also supplied as a one-time migration).
CREATE UNIQUE INDEX IF NOT EXISTS idx_luggage_extension_date
  ON luggage_orders(parent_order_id, extension_date) WHERE extension_date IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_luggage_receipt_request
  ON luggage_order_payments(receipt_request_id, order_id, tender_type)
  WHERE receipt_request_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_luggage_collection_request
  ON luggage_audit_logs(device_id) WHERE action = 'CONFIRM_COLLECTION';

-- Stored charges and real tender receipts remain separate. A paid root mismatch is a
-- reconciliation item, never an instruction to collect again or offset a child invoice.
CREATE VIEW IF NOT EXISTS luggage_billing_lines AS
WITH ledger AS (
  SELECT order_id, COUNT(*) AS payment_count, SUM(amount) AS recorded_amount,
    MAX(julianday(recorded_at)) AS last_receipt_at,
    SUM(CASE WHEN julianday(recorded_at) IS NULL THEN 1 ELSE 0 END) AS invalid_receipt_dates,
    SUM(receipt_request_id IS NOT NULL) AS modern_receipt_count,
    SUM(CASE WHEN typeof(amount) != 'integer' OR amount < 0 THEN 1 ELSE 0 END) AS invalid_receipt_amounts
  FROM luggage_order_payments GROUP BY order_id
), price_events AS (
  SELECT log_id, order_id, staff_id, timestamp,
    CASE WHEN json_valid(details) THEN details ELSE '{}' END AS payload
  FROM luggage_audit_logs WHERE action = 'UPDATE_PRICE'
), amounts AS (
  SELECT o.*, COALESCE(o.parent_order_id, o.order_id) AS root_id,
    COALESCE(o.final_amount, o.prepaid_amount, 0) + COALESCE(o.extra_amount, 0) AS billed_amount,
    COALESCE(p.recorded_amount, 0) AS recorded_amount, COALESCE(p.payment_count, 0) AS payment_count,
    p.last_receipt_at, p.invalid_receipt_dates, COALESCE(p.modern_receipt_count, 0) AS modern_receipt_count,
    COALESCE(p.invalid_receipt_amounts, 0) AS invalid_receipt_amounts,
    CASE WHEN o.status IN ('PAID', 'PICKED_UP') AND COALESCE(p.payment_count, 0) = 0
      THEN COALESCE(o.final_amount, o.prepaid_amount, 0) + COALESCE(o.extra_amount, 0) ELSE 0 END AS legacy_paid_estimate,
    CASE WHEN o.parent_order_id IS NOT NULL THEN COALESCE(o.extension_date,
      CASE WHEN o.expected_storage_days > 1 THEN date(o.expected_pickup_at, '+9 hours') END,
      MAX(date(o.created_at, '+9 hours'), date(r.expected_pickup_at, '+9 hours', '+1 day')))
    END AS coverage_end
  FROM luggage_orders o LEFT JOIN luggage_orders r ON r.order_id = o.parent_order_id
  LEFT JOIN ledger p ON p.order_id = o.order_id WHERE o.status != 'CANCELLED'
), evidence AS (
  SELECT m.*, m.billed_amount - m.recorded_amount - m.legacy_paid_estimate AS raw_balance,
    CASE WHEN m.parent_order_id IS NULL AND m.status IN ('PAID', 'PICKED_UP')
      AND m.payment_count > 0 AND m.billed_amount != m.recorded_amount THEN 1 ELSE 0 END AS root_review_required,
    (SELECT a.log_id FROM price_events a WHERE a.order_id = m.order_id
      AND m.parent_order_id IS NULL AND m.status IN ('PAID', 'PICKED_UP')
      AND m.payment_count > 0 AND m.billed_amount != m.recorded_amount
      AND m.modern_receipt_count = 0 AND m.invalid_receipt_dates = 0 AND m.invalid_receipt_amounts = 0
      AND a.staff_id IS NOT NULL AND trim(a.staff_id) != '' AND a.staff_id != 'SYSTEM'
      -- Same-second events cannot prove ordering. Legacy text-only events lack a before image.
      AND julianday(a.timestamp) > m.last_receipt_at
      AND json_type(a.payload, '$.before.prepaid_amount') = 'integer'
      AND json_type(a.payload, '$.after.finalAmount') = 'integer'
      AND COALESCE(json_extract(a.payload, '$.before.final_amount'), json_extract(a.payload, '$.before.prepaid_amount'))
        + COALESCE(json_extract(a.payload, '$.before.extra_amount'), 0) = m.recorded_amount
      AND COALESCE(json_extract(a.payload, '$.before.extra_amount'), 0) = m.extra_amount
      AND json_extract(a.payload, '$.after.finalAmount') = m.final_amount
      AND json_extract(a.payload, '$.after.finalAmount') = m.prepaid_amount
      ORDER BY julianday(a.timestamp) DESC, a.log_id DESC LIMIT 1) AS reprice_audit_log_id
  FROM amounts m
)
SELECT e.*,
  CASE WHEN root_review_required = 1 THEN ABS(raw_balance) ELSE 0 END AS root_review_amount,
  CASE WHEN root_review_required = 1 THEN raw_balance ELSE 0 END AS root_review_difference,
  CASE WHEN root_review_required = 1 AND reprice_audit_log_id IS NOT NULL
    THEN 'AUDITED_POST_PAYMENT_REPRICE'
    WHEN root_review_required = 1 THEN 'UNVERIFIED_ROOT_DIFFERENCE' END AS root_review_reason,
  CASE WHEN root_review_required = 1 AND (reprice_audit_log_id IS NULL OR raw_balance < 0) THEN 1 ELSE 0 END AS review_pickup_blocked,
  CASE WHEN root_review_required = 1 THEN 0 ELSE MAX(0, raw_balance) END AS collectible_amount
FROM evidence e;

-- Independent of tags and AUTO_EXTENSION_ENABLED. Reads never create orders.
-- Do not LIMIT this recursive date range: silently dropping old days would understate debt.
-- Operational follow-up: bound historical materialization separately and require explicit review
-- for a backlog beyond that bound; a review state must block pickup, never mean zero outstanding.
CREATE VIEW IF NOT EXISTS luggage_unbilled_extension_days AS
WITH RECURSIVE days(root_id, billing_date, last_date, amount) AS (
  SELECT order_id, date(expected_pickup_at, '+9 hours', '+1 day'),
         date('now', '+9 hours'), price_per_day
  FROM luggage_orders
  WHERE parent_order_id IS NULL AND status IN ('PAID', 'PAYMENT_PENDING')
    AND date(expected_pickup_at, '+9 hours') < date('now', '+9 hours')
  UNION ALL
  SELECT root_id, date(billing_date, '+1 day'), last_date, amount FROM days
  WHERE billing_date < last_date
)
SELECT root_id, billing_date, amount FROM days d
WHERE NOT EXISTS (
  SELECT 1 FROM luggage_billing_lines e WHERE e.parent_order_id = d.root_id
    AND d.billing_date BETWEEN date(e.coverage_end, '-' || (MAX(1, e.expected_storage_days) - 1) || ' days') AND e.coverage_end
);

CREATE VIEW IF NOT EXISTS luggage_billing_balances AS
WITH totals AS (
  SELECT root_id, SUM(parent_order_id IS NOT NULL) AS extension_count, SUM(billed_amount) AS billed_amount,
    SUM(recorded_amount) AS recorded_amount, SUM(legacy_paid_estimate) AS legacy_paid_estimate,
    SUM(MAX(0, -raw_balance)) AS overpaid_amount,
    SUM(collectible_amount) AS line_outstanding,
    SUM(CASE WHEN parent_order_id IS NOT NULL THEN collectible_amount ELSE 0 END) AS extension_line_outstanding,
    SUM(root_review_required) AS root_review_required, SUM(root_review_amount) AS root_review_amount,
    SUM(root_review_difference) AS root_review_difference, MAX(root_review_reason) AS root_review_reason,
    MAX(reprice_audit_log_id) AS reprice_audit_log_id, MAX(review_pickup_blocked) AS review_pickup_blocked,
    MAX(CASE WHEN invalid_receipt_amounts > 0 OR typeof(prepaid_amount) != 'integer' OR prepaid_amount < 0
      OR (final_amount IS NOT NULL AND (typeof(final_amount) != 'integer' OR final_amount < 0))
      OR typeof(extra_amount) != 'integer' OR extra_amount < 0
      OR typeof(price_per_day) != 'integer' OR recorded_amount < 0
      OR raw_balance < 0 OR billed_amount < 0 OR billed_amount != CAST(billed_amount AS INTEGER)
      OR price_per_day < 0 OR price_per_day != CAST(price_per_day AS INTEGER)
      OR billed_amount > 500000 OR price_per_day > 500000 THEN 1 ELSE 0 END) AS invalid_amount
  FROM luggage_billing_lines GROUP BY root_id
), projected AS (
  SELECT root_id, SUM(amount) AS amount, COUNT(*) AS days FROM luggage_unbilled_extension_days GROUP BY root_id
)
SELECT t.*, COALESCE(p.amount, 0) AS unbilled_amount, COALESCE(p.days, 0) AS unbilled_days,
  t.billed_amount + COALESCE(p.amount, 0) AS total_billed_amount,
  t.extension_line_outstanding + COALESCE(p.amount, 0) AS extension_outstanding_amount,
  t.line_outstanding + COALESCE(p.amount, 0) AS outstanding_amount
FROM totals t LEFT JOIN projected p ON p.root_id = t.root_id;

-- Ledger receipts belong to the actual JST receipt day, irrespective of order status/creation.
-- The legacy fallback is mutually exclusive with ledger rows, so it cannot duplicate receipts.
CREATE VIEW IF NOT EXISTS luggage_receipt_sales AS
SELECT p.order_id, p.business_date, p.tender_type, p.amount, 0 AS estimated
FROM luggage_order_payments p
UNION ALL
SELECT o.order_id, date(o.created_at, '+9 hours'),
       CASE WHEN o.payment_method = 'PAY_QR' THEN 'PAY_QR' ELSE 'CASH' END,
       COALESCE(o.final_amount, o.prepaid_amount, 0) + COALESCE(o.extra_amount, 0), 1
FROM luggage_orders o WHERE o.status IN ('PAID', 'PICKED_UP')
  AND NOT EXISTS (SELECT 1 FROM luggage_order_payments p WHERE p.order_id = o.order_id);

-- DB guards also cover bulk/internal/legacy endpoints and races between reads and writes.
CREATE TRIGGER IF NOT EXISTS luggage_extension_insert_guard BEFORE INSERT ON luggage_orders
WHEN NEW.parent_order_id IS NOT NULL
BEGIN
  SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM luggage_orders r
    WHERE r.order_id = NEW.parent_order_id AND r.parent_order_id IS NULL
      AND r.status IN ('PAID', 'PAYMENT_PENDING'))
    THEN RAISE(ABORT, 'Extension requires an active root order') END;
  SELECT CASE WHEN NEW.extension_date IS NOT NULL AND EXISTS (
    SELECT 1 FROM luggage_billing_lines e WHERE e.parent_order_id = NEW.parent_order_id
      AND NEW.extension_date BETWEEN date(e.coverage_end, '-' || (MAX(1, e.expected_storage_days) - 1) || ' days') AND e.coverage_end)
    THEN RAISE(ABORT, 'Extension date already covered') END;
END;

CREATE TRIGGER IF NOT EXISTS luggage_pickup_balance_guard BEFORE UPDATE OF status ON luggage_orders
WHEN NEW.status = 'PICKED_UP' AND OLD.status != 'PICKED_UP'
BEGIN
  SELECT CASE WHEN OLD.parent_order_id IS NOT NULL
    AND EXISTS (SELECT 1 FROM luggage_orders r WHERE r.order_id = OLD.parent_order_id AND r.status != 'PICKED_UP')
    THEN RAISE(ABORT, 'Pick up the root order') END;
  SELECT CASE WHEN EXISTS (SELECT 1 FROM luggage_billing_balances b
    WHERE b.root_id = COALESCE(OLD.parent_order_id, OLD.order_id)
      AND (b.outstanding_amount > 0 OR b.invalid_amount != 0 OR b.review_pickup_blocked != 0))
    THEN RAISE(ABORT, 'Outstanding collection prevents pickup') END;
END;

-- A review item cannot be hidden by resetting its status to pending/cancelled.
CREATE TRIGGER IF NOT EXISTS luggage_root_review_status_guard BEFORE UPDATE OF status ON luggage_orders
WHEN OLD.parent_order_id IS NULL AND NEW.status NOT IN ('PAID', 'PICKED_UP')
  AND EXISTS (SELECT 1 FROM luggage_billing_lines l WHERE l.order_id = OLD.order_id AND l.root_review_required = 1)
BEGIN SELECT RAISE(ABORT, 'Preserve original settlement review'); END;

CREATE TRIGGER IF NOT EXISTS luggage_pickup_extensions AFTER UPDATE OF status ON luggage_orders
WHEN NEW.status = 'PICKED_UP' AND OLD.status != 'PICKED_UP' AND NEW.parent_order_id IS NULL
BEGIN
  UPDATE luggage_orders SET status = 'PICKED_UP', actual_pickup_at = NEW.actual_pickup_at,
    updated_at = datetime('now') WHERE parent_order_id = NEW.order_id AND status IN ('PAID', 'PAYMENT_PENDING');
END;

-- Retain the existing cancellation of legacy unpaid drafts, never a dated/accrued charge or receipt.
-- An undated draft has no confirmed service date. Known past service dates require an approved correction policy.
CREATE VIEW IF NOT EXISTS luggage_cancellation_policy AS
SELECT o.order_id,
  CASE
    WHEN l.root_review_required = 1 THEN 'ROOT_SETTLEMENT_REVIEW_REQUIRED'
    WHEN o.parent_order_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM luggage_order_payments p WHERE p.order_id = o.order_id) THEN 'COLLECTED_EXTENSION'
    WHEN o.parent_order_id IS NOT NULL AND (
      o.status != 'PAYMENT_PENDING' OR o.extension_date IS NOT NULL
      OR date(l.coverage_end, '-' || (MAX(1, l.expected_storage_days) - 1) || ' days') <= date('now', '+9 hours')
      OR NOT EXISTS (SELECT 1 FROM luggage_orders r WHERE r.order_id = o.parent_order_id
        AND r.status IN ('PAID', 'PAYMENT_PENDING'))) THEN 'EXTENSION_POLICY_REQUIRED'
    WHEN o.parent_order_id IS NULL AND (
      EXISTS (SELECT 1 FROM luggage_orders e WHERE e.parent_order_id = o.order_id AND e.status != 'CANCELLED')
      OR EXISTS (SELECT 1 FROM luggage_unbilled_extension_days d WHERE d.root_id = o.order_id AND d.amount > 0))
      THEN 'EXTENSION_POLICY_REQUIRED'
  END AS block_reason
FROM luggage_orders o LEFT JOIN luggage_billing_lines l ON l.order_id = o.order_id;

CREATE TRIGGER IF NOT EXISTS luggage_no_extension_waiver BEFORE UPDATE OF status ON luggage_orders
WHEN NEW.status = 'CANCELLED' AND OLD.status != 'CANCELLED'
  AND EXISTS (SELECT 1 FROM luggage_cancellation_policy p WHERE p.order_id = OLD.order_id AND p.block_reason IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'Extension cancellation requires an approved policy'); END;

CREATE TRIGGER IF NOT EXISTS luggage_preserve_collection_delete BEFORE DELETE ON luggage_order_payments
WHEN OLD.receipt_request_id IS NOT NULL
  OR EXISTS (SELECT 1 FROM luggage_billing_lines l WHERE l.order_id = OLD.order_id AND l.root_review_required = 1)
  OR EXISTS (SELECT 1 FROM luggage_orders o
  WHERE o.order_id = OLD.order_id AND (o.parent_order_id IS NOT NULL
    OR EXISTS (SELECT 1 FROM luggage_orders e WHERE e.parent_order_id = o.order_id)))
BEGIN SELECT RAISE(ABORT, 'Preserve collection history'); END;
CREATE TRIGGER IF NOT EXISTS luggage_preserve_collection_update BEFORE UPDATE ON luggage_order_payments
WHEN OLD.receipt_request_id IS NOT NULL
  OR EXISTS (SELECT 1 FROM luggage_billing_lines l WHERE l.order_id = OLD.order_id AND l.root_review_required = 1)
  OR EXISTS (SELECT 1 FROM luggage_orders o
  WHERE o.order_id = OLD.order_id AND (o.parent_order_id IS NOT NULL
    OR EXISTS (SELECT 1 FROM luggage_orders e WHERE e.parent_order_id = o.order_id)))
BEGIN SELECT RAISE(ABORT, 'Preserve collection history'); END;

CREATE TRIGGER IF NOT EXISTS luggage_preserve_collected_price BEFORE UPDATE OF prepaid_amount, final_amount, extra_amount, parent_order_id, extension_date ON luggage_orders
WHEN (NEW.prepaid_amount IS NOT OLD.prepaid_amount OR NEW.final_amount IS NOT OLD.final_amount
  OR NEW.extra_amount IS NOT OLD.extra_amount OR NEW.parent_order_id IS NOT OLD.parent_order_id
  OR NEW.extension_date IS NOT OLD.extension_date)
  AND EXISTS (SELECT 1 FROM luggage_order_payments p WHERE p.order_id = OLD.order_id)
BEGIN SELECT RAISE(ABORT, 'Collected amounts require a separate correction policy'); END;

CREATE TRIGGER IF NOT EXISTS luggage_receipt_insert_guard BEFORE INSERT ON luggage_order_payments
WHEN NEW.receipt_request_id IS NOT NULL
BEGIN
  SELECT CASE WHEN NEW.amount <= 0 OR NEW.amount != CAST(NEW.amount AS INTEGER) OR NEW.amount > 500000
    OR NEW.staff_id IS NULL OR NEW.business_date != date(NEW.recorded_at, '+9 hours')
    OR NOT EXISTS (SELECT 1 FROM luggage_audit_logs a WHERE a.device_id = NEW.receipt_request_id
      AND a.action = 'CONFIRM_COLLECTION' AND a.staff_id = NEW.staff_id)
    OR NOT EXISTS (SELECT 1 FROM luggage_billing_lines l JOIN luggage_orders r ON r.order_id = l.root_id
      WHERE l.order_id = NEW.order_id AND r.status IN ('PAID', 'PAYMENT_PENDING')
        AND l.collectible_amount >= NEW.amount)
    THEN RAISE(ABORT, 'Invalid or excess collection') END;
END;
CREATE TRIGGER IF NOT EXISTS luggage_legacy_extension_payment_guard BEFORE INSERT ON luggage_order_payments
WHEN NEW.receipt_request_id IS NULL AND EXISTS (SELECT 1 FROM luggage_orders o WHERE o.order_id = NEW.order_id
  AND (o.parent_order_id IS NOT NULL OR EXISTS (SELECT 1 FROM luggage_orders e WHERE e.parent_order_id = o.order_id)))
BEGIN SELECT RAISE(ABORT, 'Use collection confirmation for extensions'); END;
CREATE TRIGGER IF NOT EXISTS luggage_extension_paid_guard BEFORE UPDATE OF status ON luggage_orders
WHEN NEW.status = 'PAID' AND OLD.status = 'PAYMENT_PENDING'
  AND (OLD.parent_order_id IS NOT NULL OR EXISTS (SELECT 1 FROM luggage_orders e WHERE e.parent_order_id = OLD.order_id))
  AND COALESCE(NEW.final_amount, NEW.prepaid_amount, 0) + COALESCE(NEW.extra_amount, 0)
    > COALESCE((SELECT SUM(p.amount) FROM luggage_order_payments p WHERE p.order_id = OLD.order_id), 0)
BEGIN SELECT RAISE(ABORT, 'Actual collection is required'); END;

CREATE VIEW IF NOT EXISTS luggage_sales_daily AS
WITH receipts AS (
  SELECT business_date, SUM(CASE WHEN tender_type = 'CASH' THEN amount ELSE 0 END) AS cash,
    SUM(CASE WHEN tender_type = 'PAY_QR' THEN amount ELSE 0 END) AS qr, SUM(amount) AS total_amount,
    SUM(CASE WHEN estimated = 1 THEN amount ELSE 0 END) AS legacy_estimated_amount,
    SUM(CASE WHEN estimated = 0 THEN amount ELSE 0 END) AS recorded_amount
  FROM luggage_receipt_sales GROUP BY business_date
), orders AS (
  SELECT date(created_at, '+9 hours') AS business_date, COUNT(*) AS order_count,
    SUM(status IN ('PAID', 'PICKED_UP')) AS paid_count, SUM(status = 'PAYMENT_PENDING') AS pending_count,
    SUM(CASE WHEN status IN ('PAID', 'PICKED_UP') THEN 1 + companion_count ELSE 0 END) AS people,
    SUM(CASE WHEN status IN ('PAID', 'PICKED_UP') THEN suitcase_qty ELSE 0 END) AS suitcase_total,
    SUM(CASE WHEN status IN ('PAID', 'PICKED_UP') THEN backpack_qty ELSE 0 END) AS backpack_total
  FROM luggage_orders WHERE parent_order_id IS NULL AND status != 'CANCELLED' GROUP BY business_date
), dates AS (SELECT business_date FROM receipts UNION SELECT business_date FROM orders)
SELECT d.business_date, COALESCE(r.cash, 0) AS cash, COALESCE(r.qr, 0) AS qr,
  COALESCE(r.total_amount, 0) AS total_amount, COALESCE(o.order_count, 0) AS order_count,
  COALESCE(r.legacy_estimated_amount, 0) AS legacy_estimated_amount, COALESCE(r.recorded_amount, 0) AS recorded_amount,
  COALESCE(o.paid_count, 0) AS paid_count, COALESCE(o.pending_count, 0) AS pending_count,
  COALESCE(o.people, 0) AS people, COALESCE(o.suitcase_total, 0) AS suitcase_total,
  COALESCE(o.backpack_total, 0) AS backpack_total
FROM dates d LEFT JOIN receipts r ON r.business_date = d.business_date LEFT JOIN orders o ON o.business_date = d.business_date;

-- Actual extension identity/coverage remains immutable. A projection alone is not an issued invoice:
-- preserve existing audited pickup-date/rate corrections on standalone orders, even on historical fixtures.
-- Such corrections never delete receipts or alter an already-created extension's service dates.
CREATE TRIGGER IF NOT EXISTS luggage_preserve_extension_coverage BEFORE UPDATE OF parent_order_id, extension_date, expected_pickup_at, price_per_day ON luggage_orders
WHEN (NEW.parent_order_id IS NOT OLD.parent_order_id OR NEW.extension_date IS NOT OLD.extension_date)
  OR (((NEW.expected_pickup_at IS NOT OLD.expected_pickup_at
      AND (date(NEW.expected_pickup_at, '+9 hours') IS NULL
        OR date(NEW.expected_pickup_at, '+9 hours') IS NOT date(OLD.expected_pickup_at, '+9 hours')))
      OR NEW.price_per_day IS NOT OLD.price_per_day)
    AND (OLD.parent_order_id IS NOT NULL OR EXISTS (SELECT 1 FROM luggage_orders e
      WHERE e.parent_order_id = OLD.order_id AND (e.status != 'CANCELLED' OR e.extension_date IS NOT NULL
        OR EXISTS (SELECT 1 FROM luggage_order_payments p WHERE p.order_id = e.order_id)))))
BEGIN SELECT RAISE(ABORT, 'Preserve accrued extension coverage'); END;

-- 21:00 JST automatic extension cutover
-- Apply once to the deployed F1 schema, as one atomic D1 import.
-- Existing orders and receipts are never changed. All pre-cutover orders are
-- excluded from new automatic accrual until separately reviewed by staff.
CREATE TABLE luggage_automatic_billing_policy (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  starts_at TEXT NOT NULL CHECK (julianday(starts_at) IS NOT NULL)
);
INSERT INTO luggage_automatic_billing_policy(singleton, starts_at)
VALUES (1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

DROP VIEW luggage_unbilled_extension_days;
CREATE VIEW luggage_unbilled_extension_days AS
WITH RECURSIVE days(root_id, billing_date, last_date, amount) AS (
  SELECT r.order_id, date(r.expected_pickup_at, '+9 hours', '+1 day'),
    date('now', '+9 hours', CASE WHEN time('now', '+9 hours') >= '21:00:00' THEN '+1 day' ELSE '+0 days' END),
    r.price_per_day
  FROM luggage_orders r CROSS JOIN luggage_automatic_billing_policy policy
  WHERE policy.singleton = 1 AND r.parent_order_id IS NULL
    AND r.status IN ('PAID', 'PAYMENT_PENDING') AND r.actual_pickup_at IS NULL
    AND julianday(r.created_at) >= julianday(policy.starts_at)
    AND julianday(r.created_at) <= julianday('now')
    AND date(r.expected_pickup_at, '+9 hours') >= date(r.created_at, '+9 hours')
    AND (r.status = 'PAID' OR EXISTS (
      SELECT 1 FROM luggage_order_payments p WHERE p.order_id = r.order_id AND p.amount > 0))
    AND typeof(r.price_per_day) = 'integer' AND r.price_per_day BETWEEN 0 AND 500000
    AND datetime(r.expected_pickup_at, '+9 hours', 'start of day', '+21 hours')
      <= datetime('now', '+9 hours')
  UNION ALL
  SELECT root_id, date(billing_date, '+1 day'), last_date, amount FROM days
  WHERE billing_date < last_date
)
SELECT root_id, billing_date, amount FROM days d
WHERE NOT EXISTS (
  SELECT 1 FROM luggage_billing_lines e WHERE e.parent_order_id = d.root_id
    AND d.billing_date BETWEEN date(e.coverage_end, '-' || (MAX(1, e.expected_storage_days) - 1) || ' days') AND e.coverage_end
);

-- Verified intake precedes automatic overnight accrual
-- Forward safety refinement; preserve the existing cutover and all financial rows.
DROP VIEW luggage_unbilled_extension_days;
CREATE VIEW luggage_unbilled_extension_days AS
WITH RECURSIVE confirmed_intakes(order_id, confirmed_at) AS (
  SELECT order_id, MIN(confirmed_at) FROM (
    SELECT order_id, julianday(recorded_at) AS confirmed_at FROM luggage_order_payments
      WHERE amount > 0 AND julianday(recorded_at) IS NOT NULL
    UNION ALL
    SELECT order_id, julianday(timestamp) FROM luggage_audit_logs
      WHERE action IN ('MARK_PAID', 'TOGGLE_PAYMENT', 'UNIFIED_ADMIN_PAYMENT_STATUS_UPDATE')
        AND julianday(timestamp) IS NOT NULL
  ) GROUP BY order_id
), days(root_id, billing_date, last_date, amount, confirmed_at) AS (
  SELECT r.order_id, date(r.expected_pickup_at, '+9 hours', '+1 day'),
    date('now', '+9 hours', CASE WHEN time('now', '+9 hours') >= '21:00:00' THEN '+1 day' ELSE '+0 days' END),
    r.price_per_day, COALESCE(intake.confirmed_at,
      CASE WHEN r.price_per_day = 0 THEN julianday(r.created_at) END)
  FROM luggage_orders r CROSS JOIN luggage_automatic_billing_policy policy
  LEFT JOIN confirmed_intakes intake ON intake.order_id = r.order_id
  WHERE policy.singleton = 1 AND r.parent_order_id IS NULL
    AND r.status IN ('PAID', 'PAYMENT_PENDING') AND r.actual_pickup_at IS NULL
    AND julianday(r.created_at) >= julianday(policy.starts_at)
    AND julianday(r.created_at) <= julianday('now')
    AND date(r.expected_pickup_at, '+9 hours') >= date(r.created_at, '+9 hours')
    AND (intake.confirmed_at IS NOT NULL OR (r.status = 'PAID' AND r.price_per_day = 0))
    AND typeof(r.price_per_day) = 'integer' AND r.price_per_day BETWEEN 0 AND 500000
    AND datetime(r.expected_pickup_at, '+9 hours', 'start of day', '+21 hours')
      <= datetime('now', '+9 hours')
  UNION ALL
  SELECT root_id, date(billing_date, '+1 day'), last_date, amount, confirmed_at FROM days
  WHERE billing_date < last_date
)
SELECT root_id, billing_date, amount FROM days d
-- An unconfirmed form is not evidence of physical overnight storage.
WHERE julianday(d.billing_date || 'T12:00:00Z', '-1 day') >= d.confirmed_at
AND NOT EXISTS (
  SELECT 1 FROM luggage_billing_lines e WHERE e.parent_order_id = d.root_id
    AND d.billing_date BETWEEN date(e.coverage_end, '-' || (MAX(1, e.expected_storage_days) - 1) || ' days') AND e.coverage_end
);

-- Flying Pass phase 2: preserve original claims/receipts; recognize confirmed cash payouts only.
-- Public refund API remains gated until phase 3. Apply after 20261028_flying_pass_refunds.sql.

DROP VIEW IF EXISTS luggage_billing_lines;
CREATE VIEW IF NOT EXISTS luggage_billing_lines AS
WITH ledger AS (
  SELECT order_id, COUNT(*) AS payment_count, SUM(amount) AS recorded_amount,
    MAX(julianday(recorded_at)) AS last_receipt_at,
    SUM(CASE WHEN julianday(recorded_at) IS NULL THEN 1 ELSE 0 END) AS invalid_receipt_dates,
    SUM(receipt_request_id IS NOT NULL) AS modern_receipt_count,
    SUM(CASE WHEN typeof(amount) != 'integer' OR amount < 0 THEN 1 ELSE 0 END) AS invalid_receipt_amounts
  FROM luggage_order_payments GROUP BY order_id
), refunds AS (
  SELECT order_id, SUM(CASE WHEN status = 'CONFIRMED' THEN amount ELSE 0 END) AS refunded,
    SUM(status = 'PAYOUT_PENDING') AS pending, SUM(status = 'CONFIRMED') AS refund_count
  FROM luggage_flying_pass_refunds GROUP BY order_id
), price_events AS (
  SELECT log_id, order_id, staff_id, timestamp,
    CASE WHEN json_valid(details) THEN details ELSE '{}' END AS payload
  FROM luggage_audit_logs WHERE action = 'UPDATE_PRICE'
), amounts AS (
  SELECT o.*, COALESCE(o.parent_order_id, o.order_id) AS root_id,
    COALESCE(o.final_amount, o.prepaid_amount, 0) + COALESCE(o.extra_amount, 0) AS billed_amount,
    COALESCE(p.recorded_amount, 0) AS recorded_amount, COALESCE(p.payment_count, 0) AS payment_count,
    COALESCE(f.refunded, 0) AS discount_credit_amount, COALESCE(f.refunded, 0) AS cash_refunded_amount,
    COALESCE(f.pending, 0) AS pending_refund_count, COALESCE(f.refund_count, 0) AS refund_count,
    COALESCE(o.final_amount, o.prepaid_amount, 0) + COALESCE(o.extra_amount, 0) - COALESCE(f.refunded, 0) AS effective_billed_amount,
    COALESCE(p.recorded_amount, 0) - COALESCE(f.refunded, 0) AS net_received_amount,
    (SELECT refund_id FROM luggage_flying_pass_refunds f3 WHERE f3.order_id = o.order_id AND f3.status = 'CONFIRMED' ORDER BY sequence DESC LIMIT 1) AS latest_confirmed_refund_id,
    (SELECT refund_id FROM luggage_flying_pass_refunds f4 WHERE f4.order_id = o.order_id AND f4.status = 'PAYOUT_PENDING') AS pending_refund_id,
    COALESCE((SELECT after_tier FROM luggage_flying_pass_refunds f2 WHERE f2.order_id = o.order_id AND f2.status = 'CONFIRMED' ORDER BY sequence DESC LIMIT 1), o.flying_pass_tier) AS effective_flying_pass_tier,
    p.last_receipt_at, p.invalid_receipt_dates, COALESCE(p.modern_receipt_count, 0) AS modern_receipt_count,
    COALESCE(p.invalid_receipt_amounts, 0) AS invalid_receipt_amounts,
    CASE WHEN o.status IN ('PAID', 'PICKED_UP') AND COALESCE(p.payment_count, 0) = 0
      THEN COALESCE(o.final_amount, o.prepaid_amount, 0) + COALESCE(o.extra_amount, 0) ELSE 0 END AS legacy_paid_estimate,
    CASE WHEN o.parent_order_id IS NOT NULL THEN COALESCE(o.extension_date,
      CASE WHEN o.expected_storage_days > 1 THEN date(o.expected_pickup_at, '+9 hours') END,
      MAX(date(o.created_at, '+9 hours'), date(r.expected_pickup_at, '+9 hours', '+1 day')))
    END AS coverage_end
  FROM luggage_orders o LEFT JOIN luggage_orders r ON r.order_id = o.parent_order_id
  LEFT JOIN ledger p ON p.order_id = o.order_id LEFT JOIN refunds f ON f.order_id = o.order_id WHERE o.status != 'CANCELLED'
), evidence AS (
  SELECT m.*, m.effective_billed_amount - m.net_received_amount - m.legacy_paid_estimate AS raw_balance,
    CASE WHEN m.parent_order_id IS NULL AND m.status IN ('PAID', 'PICKED_UP')
      AND m.payment_count > 0 AND m.effective_billed_amount != m.net_received_amount THEN 1 ELSE 0 END AS root_review_required,
    (SELECT a.log_id FROM price_events a WHERE a.order_id = m.order_id
      AND m.parent_order_id IS NULL AND m.status IN ('PAID', 'PICKED_UP')
      AND m.payment_count > 0 AND m.effective_billed_amount != m.net_received_amount
      AND m.modern_receipt_count = 0 AND m.invalid_receipt_dates = 0 AND m.invalid_receipt_amounts = 0
      AND a.staff_id IS NOT NULL AND trim(a.staff_id) != '' AND a.staff_id != 'SYSTEM'
      -- Same-second events cannot prove ordering. Legacy text-only events lack a before image.
      AND julianday(a.timestamp) > m.last_receipt_at
      AND json_type(a.payload, '$.before.prepaid_amount') = 'integer'
      AND json_type(a.payload, '$.after.finalAmount') = 'integer'
      AND COALESCE(json_extract(a.payload, '$.before.final_amount'), json_extract(a.payload, '$.before.prepaid_amount'))
        + COALESCE(json_extract(a.payload, '$.before.extra_amount'), 0) = m.recorded_amount
      AND COALESCE(json_extract(a.payload, '$.before.extra_amount'), 0) = m.extra_amount
      AND json_extract(a.payload, '$.after.finalAmount') = m.final_amount
      AND json_extract(a.payload, '$.after.finalAmount') = m.prepaid_amount
      ORDER BY julianday(a.timestamp) DESC, a.log_id DESC LIMIT 1) AS reprice_audit_log_id
  FROM amounts m
)
SELECT e.*,
  CASE WHEN root_review_required = 1 THEN ABS(raw_balance) ELSE 0 END AS root_review_amount,
  CASE WHEN root_review_required = 1 THEN raw_balance ELSE 0 END AS root_review_difference,
  CASE WHEN root_review_required = 1 AND reprice_audit_log_id IS NOT NULL
    THEN 'AUDITED_POST_PAYMENT_REPRICE'
    WHEN root_review_required = 1 THEN 'UNVERIFIED_ROOT_DIFFERENCE' END AS root_review_reason,
  CASE WHEN root_review_required = 1 AND (reprice_audit_log_id IS NULL OR raw_balance < 0) THEN 1 ELSE 0 END AS review_pickup_blocked,
  CASE WHEN root_review_required = 1 THEN 0 ELSE MAX(0, raw_balance) END AS collectible_amount
FROM evidence e;

DROP VIEW IF EXISTS luggage_billing_balances;
CREATE VIEW IF NOT EXISTS luggage_billing_balances AS
WITH totals AS (
  SELECT root_id, SUM(parent_order_id IS NOT NULL) AS extension_count, SUM(billed_amount) AS billed_amount,
    SUM(recorded_amount) AS recorded_amount, SUM(discount_credit_amount) AS discount_credit_amount,
    SUM(cash_refunded_amount) AS cash_refunded_amount, SUM(net_received_amount) AS net_received_amount,
    SUM(effective_billed_amount) AS effective_billed_amount, SUM(pending_refund_count) AS pending_refund_count, SUM(refund_count) AS refund_count,
    MAX(latest_confirmed_refund_id) AS latest_confirmed_refund_id, MAX(pending_refund_id) AS pending_refund_id,
    MAX(CASE WHEN parent_order_id IS NULL THEN effective_flying_pass_tier END) AS effective_flying_pass_tier, SUM(legacy_paid_estimate) AS legacy_paid_estimate,
    SUM(MAX(0, -raw_balance)) AS overpaid_amount,
    SUM(collectible_amount) AS line_outstanding,
    SUM(CASE WHEN parent_order_id IS NOT NULL THEN collectible_amount ELSE 0 END) AS extension_line_outstanding,
    SUM(root_review_required) AS root_review_required, SUM(root_review_amount) AS root_review_amount,
    SUM(root_review_difference) AS root_review_difference, MAX(root_review_reason) AS root_review_reason,
    MAX(reprice_audit_log_id) AS reprice_audit_log_id, MAX(review_pickup_blocked) AS review_pickup_blocked,
    MAX(CASE WHEN invalid_receipt_amounts > 0 OR typeof(prepaid_amount) != 'integer' OR prepaid_amount < 0
      OR (final_amount IS NOT NULL AND (typeof(final_amount) != 'integer' OR final_amount < 0))
      OR typeof(extra_amount) != 'integer' OR extra_amount < 0
      OR typeof(price_per_day) != 'integer' OR recorded_amount < 0
      OR discount_credit_amount > COALESCE(final_amount, prepaid_amount) OR effective_billed_amount < 0 OR net_received_amount < 0
      OR raw_balance < 0 OR billed_amount < 0 OR billed_amount != CAST(billed_amount AS INTEGER)
      OR price_per_day < 0 OR price_per_day != CAST(price_per_day AS INTEGER)
      OR billed_amount > 500000 OR price_per_day > 500000 THEN 1 ELSE 0 END) AS invalid_amount
  FROM luggage_billing_lines GROUP BY root_id
), projected AS (
  SELECT root_id, SUM(amount) AS amount, COUNT(*) AS days FROM luggage_unbilled_extension_days GROUP BY root_id
)
SELECT t.*, 2 AS refund_settlement_version, t.effective_billed_amount + COALESCE(p.amount, 0) AS total_effective_billed_amount, COALESCE(p.amount, 0) AS unbilled_amount, COALESCE(p.days, 0) AS unbilled_days,
  t.billed_amount + COALESCE(p.amount, 0) AS total_billed_amount,
  t.extension_line_outstanding + COALESCE(p.amount, 0) AS extension_outstanding_amount,
  t.line_outstanding + COALESCE(p.amount, 0) AS outstanding_amount
FROM totals t LEFT JOIN projected p ON p.root_id = t.root_id;

DROP VIEW IF EXISTS luggage_sales_daily;
CREATE VIEW IF NOT EXISTS luggage_sales_daily AS
WITH receipts AS (
  SELECT business_date, SUM(CASE WHEN tender_type = 'CASH' THEN amount ELSE 0 END) AS cash,
    SUM(CASE WHEN tender_type = 'PAY_QR' THEN amount ELSE 0 END) AS qr, SUM(amount) AS total_amount,
    SUM(CASE WHEN estimated = 1 THEN amount ELSE 0 END) AS legacy_estimated_amount,
    SUM(CASE WHEN estimated = 0 THEN amount ELSE 0 END) AS recorded_amount
  FROM luggage_receipt_sales GROUP BY business_date
), refunds AS (
  SELECT date(paid_at, '+9 hours') AS business_date, SUM(amount) AS amount, COUNT(*) AS refund_count FROM luggage_flying_pass_refunds
  WHERE status = 'CONFIRMED' GROUP BY date(paid_at, '+9 hours')
), orders AS (
  SELECT date(created_at, '+9 hours') AS business_date, COUNT(*) AS order_count,
    SUM(status IN ('PAID', 'PICKED_UP')) AS paid_count, SUM(status = 'PAYMENT_PENDING') AS pending_count,
    SUM(CASE WHEN status IN ('PAID', 'PICKED_UP') THEN 1 + companion_count ELSE 0 END) AS people,
    SUM(CASE WHEN status IN ('PAID', 'PICKED_UP') THEN suitcase_qty ELSE 0 END) AS suitcase_total,
    SUM(CASE WHEN status IN ('PAID', 'PICKED_UP') THEN backpack_qty ELSE 0 END) AS backpack_total
  FROM luggage_orders WHERE parent_order_id IS NULL AND status != 'CANCELLED' GROUP BY business_date
), dates AS (SELECT business_date FROM receipts UNION SELECT business_date FROM orders UNION SELECT business_date FROM refunds)
SELECT d.business_date, COALESCE(r.cash, 0) - COALESCE(f.amount, 0) AS cash, COALESCE(r.qr, 0) AS qr,
  COALESCE(r.total_amount, 0) - COALESCE(f.amount, 0) AS total_amount,
  COALESCE(r.cash, 0) AS gross_cash, COALESCE(r.qr, 0) AS gross_qr, COALESCE(f.amount, 0) AS cash_refund_amount, COALESCE(f.refund_count, 0) AS refund_count, COALESCE(o.order_count, 0) AS order_count,
  COALESCE(r.legacy_estimated_amount, 0) AS legacy_estimated_amount, COALESCE(r.recorded_amount, 0) AS recorded_amount,
  COALESCE(o.paid_count, 0) AS paid_count, COALESCE(o.pending_count, 0) AS pending_count,
  COALESCE(o.people, 0) AS people, COALESCE(o.suitcase_total, 0) AS suitcase_total,
  COALESCE(o.backpack_total, 0) AS backpack_total
FROM dates d LEFT JOIN receipts r ON r.business_date = d.business_date LEFT JOIN orders o ON o.business_date = d.business_date LEFT JOIN refunds f ON f.business_date = d.business_date;

DROP TRIGGER IF EXISTS luggage_refund_preserve_order;
CREATE TRIGGER IF NOT EXISTS luggage_refund_preserve_order BEFORE UPDATE ON luggage_orders
WHEN EXISTS (SELECT 1 FROM luggage_flying_pass_refunds WHERE order_id = OLD.order_id AND status IN ('PAYOUT_PENDING','CONFIRMED'))
  AND (NEW.order_id IS NOT OLD.order_id OR (NEW.status IS NOT OLD.status AND (EXISTS (SELECT 1 FROM luggage_flying_pass_refunds WHERE order_id = OLD.order_id AND status = 'PAYOUT_PENDING')
    OR NOT ((OLD.status = 'PAID' AND NEW.status = 'PICKED_UP') OR (OLD.status = 'PICKED_UP' AND NEW.status = 'PAID'))
    OR EXISTS (SELECT 1 FROM luggage_billing_balances b WHERE b.root_id = OLD.order_id AND (b.invalid_amount != 0 OR b.review_pickup_blocked != 0 OR b.outstanding_amount != 0 OR b.pending_refund_count != 0)))) OR NEW.parent_order_id IS NOT OLD.parent_order_id
    OR NEW.prepaid_amount IS NOT OLD.prepaid_amount OR NEW.final_amount IS NOT OLD.final_amount OR NEW.extra_amount IS NOT OLD.extra_amount
    OR NEW.flying_pass_tier IS NOT OLD.flying_pass_tier OR NEW.flying_pass_discount_amount IS NOT OLD.flying_pass_discount_amount
    OR NEW.staff_prepaid_override_amount IS NOT OLD.staff_prepaid_override_amount OR NEW.price_per_day IS NOT OLD.price_per_day
    OR NEW.expected_storage_days IS NOT OLD.expected_storage_days OR NEW.expected_pickup_at IS NOT OLD.expected_pickup_at
    OR NEW.created_at IS NOT OLD.created_at OR NEW.suitcase_qty IS NOT OLD.suitcase_qty OR NEW.backpack_qty IS NOT OLD.backpack_qty OR NEW.set_qty IS NOT OLD.set_qty
    OR NEW.extension_date IS NOT OLD.extension_date)
BEGIN SELECT RAISE(ABORT, 'REFUND_PRESERVE_ORIGINAL_ORDER'); END;

DROP TRIGGER IF EXISTS luggage_pickup_balance_guard;
CREATE TRIGGER IF NOT EXISTS luggage_pickup_balance_guard BEFORE UPDATE OF status ON luggage_orders
WHEN NEW.status = 'PICKED_UP' AND OLD.status != 'PICKED_UP'
BEGIN
  SELECT CASE WHEN OLD.parent_order_id IS NOT NULL
    AND EXISTS (SELECT 1 FROM luggage_orders r WHERE r.order_id = OLD.parent_order_id AND r.status != 'PICKED_UP')
    THEN RAISE(ABORT, 'Pick up the root order') END;
  SELECT CASE WHEN EXISTS (SELECT 1 FROM luggage_billing_balances b
    WHERE b.root_id = COALESCE(OLD.parent_order_id, OLD.order_id)
      AND (b.pending_refund_count > 0 OR b.outstanding_amount > 0 OR b.invalid_amount != 0 OR b.review_pickup_blocked != 0))
    THEN RAISE(ABORT, 'Outstanding collection prevents pickup') END;
END;

DROP TRIGGER IF EXISTS luggage_refund_phase1_closing_insert;

DROP TRIGGER IF EXISTS luggage_refund_phase1_closing_update;

-- A sidecar keeps the immutable refund/receipt basis separate from a recount of physical cash.
CREATE TABLE IF NOT EXISTS luggage_cash_closing_refund_snapshots (
  closing_id INTEGER NOT NULL PRIMARY KEY REFERENCES luggage_cash_closings(closing_id),
  business_date TEXT NOT NULL,
  gross_cash INTEGER NOT NULL CHECK (gross_cash >= 0),
  gross_qr INTEGER NOT NULL CHECK (gross_qr >= 0),
  cash_refund_amount INTEGER NOT NULL CHECK (cash_refund_amount > 0),
  refund_count INTEGER NOT NULL CHECK (refund_count > 0),
  refund_ids TEXT NOT NULL CHECK (json_valid(refund_ids) AND json_array_length(refund_ids) = refund_count),
  net_cash INTEGER NOT NULL CHECK (net_cash = gross_cash - cash_refund_amount),
  net_total INTEGER NOT NULL CHECK (net_total = net_cash + gross_qr),
  audit_id INTEGER NOT NULL UNIQUE REFERENCES luggage_cash_closing_audits(audit_id)
);
CREATE TRIGGER IF NOT EXISTS luggage_refund_closing_insert_guard BEFORE INSERT ON luggage_cash_closings
WHEN NEW.closing_type = 'FINAL_CLOSE'
BEGIN
  SELECT CASE WHEN EXISTS (SELECT 1 FROM luggage_flying_pass_refunds WHERE business_date = NEW.business_date AND status = 'PAYOUT_PENDING')
    THEN RAISE(ABORT, 'REFUND_PAYOUT_PENDING') END;
  SELECT CASE WHEN EXISTS (SELECT 1 FROM luggage_sales_daily WHERE business_date = NEW.business_date AND refund_count > 0
    AND (NEW.expected_amount IS NOT total_amount OR NEW.check_auto_amount IS NOT total_amount
      OR NEW.qr_difference_amount IS NOT ((CASE WHEN NEW.actual_qr_amount != 0 THEN NEW.actual_qr_amount ELSE NEW.paypay_amount END) - qr)))
    THEN RAISE(ABORT, 'REFUND_CLOSING_STALE') END;
END;
CREATE TRIGGER IF NOT EXISTS luggage_refund_closing_snapshot AFTER INSERT ON luggage_cash_closings
WHEN NEW.closing_type = 'FINAL_CLOSE' AND EXISTS (SELECT 1 FROM luggage_sales_daily WHERE business_date = NEW.business_date AND refund_count > 0)
BEGIN
  INSERT INTO luggage_cash_closing_audits(closing_id,action,payload,staff_id)
    SELECT NEW.closing_id, 'REFUND_SNAPSHOT', json_object('businessDate',NEW.business_date,'grossCash',gross_cash,'grossQr',gross_qr,
      'cashRefundAmount',cash_refund_amount,'refundCount',refund_count,'netCash',cash,'netTotal',total_amount,
      'refundIds',json((SELECT json_group_array(refund_id) FROM (SELECT refund_id FROM luggage_flying_pass_refunds WHERE status = 'CONFIRMED' AND date(paid_at, '+9 hours') = NEW.business_date ORDER BY refund_id)))), NEW.staff_id
    FROM luggage_sales_daily WHERE business_date = NEW.business_date;
  INSERT INTO luggage_cash_closing_refund_snapshots(closing_id,business_date,gross_cash,gross_qr,cash_refund_amount,refund_count,refund_ids,net_cash,net_total,audit_id)
    SELECT NEW.closing_id,NEW.business_date,gross_cash,gross_qr,cash_refund_amount,refund_count,
      (SELECT json_group_array(refund_id) FROM (SELECT refund_id FROM luggage_flying_pass_refunds WHERE status = 'CONFIRMED' AND date(paid_at, '+9 hours') = NEW.business_date ORDER BY refund_id)),cash,total_amount,last_insert_rowid()
    FROM luggage_sales_daily WHERE business_date = NEW.business_date;
  SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM luggage_cash_closing_refund_snapshots s JOIN luggage_cash_closing_audits a ON a.audit_id = s.audit_id
    WHERE s.closing_id = NEW.closing_id AND a.closing_id = NEW.closing_id AND a.staff_id IS NEW.staff_id AND a.action = 'REFUND_SNAPSHOT' AND json_extract(a.payload,'$.netTotal') = s.net_total)
    THEN RAISE(ABORT, 'REFUND_CLOSING_ATOMICITY') END;
END;
CREATE TRIGGER IF NOT EXISTS luggage_refund_snapshot_insert_guard BEFORE INSERT ON luggage_cash_closing_refund_snapshots
BEGIN
  SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM luggage_cash_closings c JOIN luggage_cash_closing_audits a ON a.closing_id = c.closing_id
    WHERE c.closing_id = NEW.closing_id AND c.business_date = NEW.business_date AND c.closing_type = 'FINAL_CLOSE'
      AND a.audit_id = NEW.audit_id AND a.action = 'REFUND_SNAPSHOT' AND a.staff_id IS c.staff_id AND json_valid(a.payload)
      AND json_extract(a.payload,'$.grossCash') = NEW.gross_cash AND json_extract(a.payload,'$.grossQr') = NEW.gross_qr
      AND json_extract(a.payload,'$.cashRefundAmount') = NEW.cash_refund_amount AND json_extract(a.payload,'$.refundCount') = NEW.refund_count
      AND json_extract(a.payload,'$.refundIds') = NEW.refund_ids AND json_extract(a.payload,'$.netTotal') = NEW.net_total)
    THEN RAISE(ABORT,'REFUND_CLOSING_ATOMICITY') END;
END;
CREATE TRIGGER IF NOT EXISTS luggage_refund_closing_update_guard BEFORE UPDATE ON luggage_cash_closings
BEGIN
  SELECT CASE WHEN NEW.closing_type = 'FINAL_CLOSE' AND EXISTS (SELECT 1 FROM luggage_flying_pass_refunds WHERE business_date = NEW.business_date AND status = 'PAYOUT_PENDING')
    THEN RAISE(ABORT, 'REFUND_PAYOUT_PENDING') END;
  SELECT CASE WHEN NEW.closing_type = 'FINAL_CLOSE' AND EXISTS (SELECT 1 FROM luggage_flying_pass_refunds WHERE status = 'CONFIRMED' AND date(paid_at, '+9 hours') = NEW.business_date)
    AND NOT EXISTS (SELECT 1 FROM luggage_cash_closing_refund_snapshots WHERE closing_id = OLD.closing_id)
    THEN RAISE(ABORT, 'REFUND_PRESERVE_CLOSING_SNAPSHOT') END;
  SELECT CASE WHEN EXISTS (SELECT 1 FROM luggage_cash_closing_refund_snapshots s WHERE s.closing_id = OLD.closing_id
    AND (NEW.closing_id IS NOT OLD.closing_id OR NEW.business_date IS NOT s.business_date OR NEW.closing_type != 'FINAL_CLOSE'
      OR NEW.expected_amount IS NOT s.net_total OR NEW.check_auto_amount IS NOT s.net_total
      OR NEW.qr_difference_amount IS NOT ((CASE WHEN NEW.actual_qr_amount != 0 THEN NEW.actual_qr_amount ELSE NEW.paypay_amount END) - s.gross_qr)))
    THEN RAISE(ABORT, 'REFUND_PRESERVE_CLOSING_SNAPSHOT') END;
END;
CREATE TRIGGER IF NOT EXISTS luggage_refund_closing_no_delete BEFORE DELETE ON luggage_cash_closings
WHEN EXISTS (SELECT 1 FROM luggage_cash_closing_refund_snapshots WHERE closing_id = OLD.closing_id)
BEGIN SELECT RAISE(ABORT,'REFUND_PRESERVE_CLOSING_SNAPSHOT'); END;
CREATE TRIGGER IF NOT EXISTS luggage_refund_closing_no_replace BEFORE INSERT ON luggage_cash_closings
WHEN EXISTS (SELECT 1 FROM luggage_cash_closing_refund_snapshots WHERE closing_id = NEW.closing_id)
BEGIN SELECT RAISE(ABORT,'REFUND_PRESERVE_CLOSING_SNAPSHOT'); END;
CREATE TRIGGER IF NOT EXISTS luggage_refund_snapshot_no_update BEFORE UPDATE ON luggage_cash_closing_refund_snapshots
BEGIN SELECT RAISE(ABORT,'REFUND_PRESERVE_CLOSING_SNAPSHOT'); END;
CREATE TRIGGER IF NOT EXISTS luggage_refund_snapshot_no_delete BEFORE DELETE ON luggage_cash_closing_refund_snapshots
BEGIN SELECT RAISE(ABORT,'REFUND_PRESERVE_CLOSING_SNAPSHOT'); END;
CREATE TRIGGER IF NOT EXISTS luggage_refund_snapshot_no_replace BEFORE INSERT ON luggage_cash_closing_refund_snapshots
WHEN EXISTS (SELECT 1 FROM luggage_cash_closing_refund_snapshots WHERE closing_id = NEW.closing_id)
BEGIN SELECT RAISE(ABORT,'REFUND_PRESERVE_CLOSING_SNAPSHOT'); END;
CREATE TRIGGER IF NOT EXISTS luggage_refund_closing_audit_no_update BEFORE UPDATE ON luggage_cash_closing_audits
WHEN EXISTS (SELECT 1 FROM luggage_cash_closing_refund_snapshots WHERE audit_id = OLD.audit_id)
BEGIN SELECT RAISE(ABORT,'REFUND_PRESERVE_CLOSING_AUDIT'); END;
CREATE TRIGGER IF NOT EXISTS luggage_refund_closing_audit_no_delete BEFORE DELETE ON luggage_cash_closing_audits
WHEN EXISTS (SELECT 1 FROM luggage_cash_closing_refund_snapshots WHERE audit_id = OLD.audit_id)
BEGIN SELECT RAISE(ABORT,'REFUND_PRESERVE_CLOSING_AUDIT'); END;
CREATE TRIGGER IF NOT EXISTS luggage_refund_closing_audit_no_replace BEFORE INSERT ON luggage_cash_closing_audits
WHEN EXISTS (SELECT 1 FROM luggage_cash_closing_refund_snapshots WHERE audit_id = NEW.audit_id)
BEGIN SELECT RAISE(ABORT,'REFUND_PRESERVE_CLOSING_AUDIT'); END;

-- Operator-only correction policy. No HTTP endpoint or staff/refund permission is added.
-- The approved scope is exactly 20261023-087: restore its verified long-stay price,
-- preserve the real receipt, and append an immutable correction event and audit atomically.
CREATE TABLE luggage_order_price_corrections (
  correction_id TEXT PRIMARY KEY CHECK (correction_id = '087-long-stay-discount-20261029'),
  order_id TEXT NOT NULL UNIQUE REFERENCES luggage_orders(order_id) CHECK (order_id = '20261023-087'),
  approval_reference TEXT NOT NULL CHECK (approval_reference = 'user-approved:087-normal-discount:2026-10-29'),
  operator_reference TEXT NOT NULL CHECK (length(trim(operator_reference)) BETWEEN 1 AND 120),
  evidence_sha256 TEXT NOT NULL CHECK (length(evidence_sha256) = 64 AND evidence_sha256 NOT GLOB '*[^0-9a-f]*'),
  created_at TEXT NOT NULL DEFAULT (datetime('now')) CHECK (julianday(created_at) IS NOT NULL)
);

CREATE TRIGGER luggage_price_correction_insert_guard BEFORE INSERT ON luggage_order_price_corrections
BEGIN
  SELECT CASE WHEN NEW.created_at IS NOT datetime('now') OR EXISTS (SELECT 1 FROM luggage_order_price_corrections)
    OR NEW.order_id IS NOT '20261023-087'
    THEN RAISE(ABORT, 'APPROVED_PRICE_CORRECTION_PRECONDITION_FAILED') END;
  SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM luggage_orders o
      WHERE o.order_id = NEW.order_id AND o.status = 'PAID' AND o.parent_order_id IS NULL AND o.extension_date IS NULL
        AND o.created_at = '2026-10-23 08:19:18' AND o.updated_at = '2026-10-27 10:44:46'
        AND o.actual_pickup_at IS NULL AND o.expected_pickup_at = '2026-10-31T08:30:00.000Z'
        AND o.suitcase_qty = 0 AND o.backpack_qty = 2 AND o.set_qty = 0 AND o.price_per_day = 1000
        AND o.expected_storage_days = 9 AND o.actual_storage_days = 0 AND o.extra_days = 0
        AND CAST(julianday(date(o.expected_pickup_at, '+9 hours')) - julianday(date(o.created_at, '+9 hours')) AS INTEGER) + 1 = 9
        AND o.discount_rate = 0.05 AND ROUND(o.price_per_day * o.expected_storage_days * (1 - o.discount_rate)) = 8550
        AND o.prepaid_amount = 9000 AND o.final_amount = 9000 AND o.staff_prepaid_override_amount = 9000
        AND o.extra_amount = 0 AND o.flying_pass_tier = 'NONE' AND o.flying_pass_discount_amount = 0 AND o.payment_method = 'CASH'
        AND julianday('now') < julianday(o.expected_pickup_at))
    THEN RAISE(ABORT, 'APPROVED_PRICE_CORRECTION_PRECONDITION_FAILED') END;
  -- Group predicates to stay below D1's expression-depth limit when it expands financial Views.
  SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM luggage_billing_balances b WHERE b.root_id = NEW.order_id
        AND (b.refund_settlement_version = 2 AND b.recorded_amount = 8550 AND b.net_received_amount = 8550)
        AND (b.total_billed_amount = 9000 AND b.root_review_required = 1 AND b.root_review_difference = 450)
        AND (b.root_review_amount = 450 AND b.review_pickup_blocked = 1 AND b.invalid_amount = 0)
        AND (b.outstanding_amount = 0 AND b.extension_outstanding_amount = 0 AND b.extension_count = 0)
        AND (b.unbilled_amount = 0 AND b.unbilled_days = 0 AND b.refund_count = 0 AND b.pending_refund_count = 0)
        AND (b.legacy_paid_estimate = 0 AND b.discount_credit_amount = 0 AND b.cash_refunded_amount = 0))
    THEN RAISE(ABORT, 'APPROVED_PRICE_CORRECTION_PRECONDITION_FAILED') END;
  SELECT CASE WHEN EXISTS (SELECT 1 FROM luggage_orders WHERE parent_order_id = NEW.order_id)
    OR EXISTS (SELECT 1 FROM luggage_flying_pass_refunds WHERE order_id = NEW.order_id)
    OR (SELECT COUNT(*) FROM luggage_order_payments WHERE order_id = NEW.order_id) != 1
    OR NOT EXISTS (SELECT 1 FROM luggage_order_payments WHERE order_id = NEW.order_id AND payment_id = 12067
      AND amount = 8550 AND tender_type = 'CASH' AND business_date = '2026-10-23'
      AND recorded_at = '2026-10-23 08:22:42' AND receipt_request_id IS NULL)
    OR NOT EXISTS (SELECT 1 FROM luggage_audit_logs WHERE order_id = NEW.order_id AND log_id = 53907
      AND action = 'TOGGLE_PAYMENT' AND timestamp = '2026-10-23 08:22:42')
    OR NOT EXISTS (SELECT 1 FROM luggage_audit_logs WHERE order_id = NEW.order_id AND log_id = 54341
      AND action = 'UPDATE_PRICE' AND timestamp = '2026-10-24 11:47:11'
      AND instr(details, '금액: ¥') > 0 AND CAST(substr(details, instr(details, '금액: ¥') + length('금액: ¥')) AS INTEGER) = 9000)
    OR EXISTS (SELECT 1 FROM luggage_audit_logs WHERE order_id = NEW.order_id AND action = 'UPDATE_PRICE' AND log_id > 54341)
    THEN RAISE(ABORT, 'APPROVED_PRICE_CORRECTION_PRECONDITION_FAILED') END;
END;

-- Preserve the collected-price guard for every other transition. Only the immutable
-- event's AFTER INSERT command can encounter this exact before/after state.
DROP TRIGGER luggage_preserve_collected_price;
CREATE TRIGGER luggage_preserve_collected_price BEFORE UPDATE OF prepaid_amount, final_amount, extra_amount, parent_order_id, extension_date ON luggage_orders
WHEN (NEW.prepaid_amount IS NOT OLD.prepaid_amount OR NEW.final_amount IS NOT OLD.final_amount
  OR NEW.extra_amount IS NOT OLD.extra_amount OR NEW.parent_order_id IS NOT OLD.parent_order_id
  OR NEW.extension_date IS NOT OLD.extension_date)
  AND EXISTS (SELECT 1 FROM luggage_order_payments p WHERE p.order_id = OLD.order_id)
  AND NOT EXISTS (SELECT 1 FROM luggage_order_price_corrections c JOIN luggage_audit_logs a
    ON a.device_id = c.correction_id AND a.order_id = c.order_id AND a.action = 'CORRECT_COLLECTED_PRICE'
    WHERE c.order_id = OLD.order_id AND OLD.prepaid_amount = 9000 AND OLD.final_amount = 9000
      AND OLD.staff_prepaid_override_amount = 9000 AND OLD.updated_at = '2026-10-27 10:44:46'
      AND NEW.prepaid_amount = 8550 AND NEW.final_amount = 8550 AND NEW.staff_prepaid_override_amount IS NULL
      AND NEW.extra_amount IS OLD.extra_amount AND NEW.parent_order_id IS OLD.parent_order_id
      AND NEW.extension_date IS OLD.extension_date AND NEW.updated_at = c.created_at)
BEGIN SELECT RAISE(ABORT, 'Collected amounts require a separate correction policy'); END;

CREATE TRIGGER luggage_price_correction_apply AFTER INSERT ON luggage_order_price_corrections
BEGIN
  INSERT INTO luggage_audit_logs(order_id, staff_id, device_id, action, details, timestamp)
  VALUES (NEW.order_id, NULL, NEW.correction_id, 'CORRECT_COLLECTED_PRICE', json_object(
    'policy', 'APPROVED_087_LONG_STAY_DISCOUNT_V1', 'approvalReference', NEW.approval_reference,
    'operatorReference', NEW.operator_reference, 'evidenceSha256', NEW.evidence_sha256,
    'releaseSource', '36a722eff52c465062f7f984aa1fe3b74fcfccda',
    'reason', '정상 9일 장기보관 5% 할인을 결제 후 잘못 지정된 청구액에 복원. 수납·환급·마감 변경 없음.',
    'before', json_object('prepaidAmount', 9000, 'finalAmount', 9000, 'staffPrepaidOverrideAmount', 9000,
      'discountRate', 0.05, 'extraAmount', 0, 'recordedAmount', 8550, 'rootReviewAmount', 450, 'updatedAt', '2026-10-27 10:44:46'),
    'after', json_object('prepaidAmount', 8550, 'finalAmount', 8550, 'staffPrepaidOverrideAmount', NULL,
      'discountRate', 0.05, 'extraAmount', 0, 'recordedAmount', 8550, 'rootReviewAmount', 0),
    'grossAmount', 9000, 'longStayDiscountAmount', 450, 'paymentId', 12067,
    'collectionAuditId', 53907, 'postPaymentPriceAuditId', 54341), NEW.created_at);
  UPDATE luggage_orders SET prepaid_amount = 8550, final_amount = 8550,
    staff_prepaid_override_amount = NULL, updated_at = NEW.created_at WHERE order_id = NEW.order_id;
  SELECT CASE WHEN changes() != 1 OR NOT EXISTS (SELECT 1 FROM luggage_billing_balances b
    WHERE b.root_id = NEW.order_id AND (b.total_billed_amount = 8550 AND b.recorded_amount = 8550 AND b.net_received_amount = 8550)
      AND (b.root_review_required = 0 AND b.root_review_amount = 0 AND b.review_pickup_blocked = 0)
      AND (b.outstanding_amount = 0 AND b.unbilled_amount = 0 AND b.unbilled_days = 0)
      AND (b.invalid_amount = 0 AND b.refund_count = 0 AND b.pending_refund_count = 0))
    THEN RAISE(ABORT, 'APPROVED_PRICE_CORRECTION_POSTCONDITION_FAILED') END;
END;

CREATE TRIGGER luggage_price_correction_no_update BEFORE UPDATE ON luggage_order_price_corrections
BEGIN SELECT RAISE(ABORT, 'Preserve approved price correction'); END;
CREATE TRIGGER luggage_price_correction_no_delete BEFORE DELETE ON luggage_order_price_corrections
BEGIN SELECT RAISE(ABORT, 'Preserve approved price correction'); END;

CREATE TRIGGER luggage_price_correction_receipt_update BEFORE UPDATE ON luggage_order_payments
WHEN OLD.payment_id = 12067 AND EXISTS (SELECT 1 FROM luggage_order_price_corrections)
BEGIN SELECT RAISE(ABORT, 'Preserve corrected order receipt'); END;
CREATE TRIGGER luggage_price_correction_receipt_delete BEFORE DELETE ON luggage_order_payments
WHEN OLD.payment_id = 12067 AND EXISTS (SELECT 1 FROM luggage_order_price_corrections)
BEGIN SELECT RAISE(ABORT, 'Preserve corrected order receipt'); END;
CREATE TRIGGER luggage_price_correction_receipt_replace BEFORE INSERT ON luggage_order_payments
WHEN NEW.payment_id = 12067 AND EXISTS (SELECT 1 FROM luggage_order_payments WHERE payment_id = NEW.payment_id)
  AND EXISTS (SELECT 1 FROM luggage_order_price_corrections)
BEGIN SELECT RAISE(ABORT, 'Preserve corrected order receipt'); END;

CREATE TRIGGER luggage_price_correction_audit_update BEFORE UPDATE ON luggage_audit_logs
WHEN OLD.order_id = '20261023-087' AND EXISTS (SELECT 1 FROM luggage_order_price_corrections)
BEGIN SELECT RAISE(ABORT, 'Preserve corrected order audits'); END;
CREATE TRIGGER luggage_price_correction_audit_delete BEFORE DELETE ON luggage_audit_logs
WHEN OLD.order_id = '20261023-087' AND EXISTS (SELECT 1 FROM luggage_order_price_corrections)
BEGIN SELECT RAISE(ABORT, 'Preserve corrected order audits'); END;
CREATE TRIGGER luggage_price_correction_audit_replace BEFORE INSERT ON luggage_audit_logs
WHEN EXISTS (SELECT 1 FROM luggage_audit_logs WHERE log_id = NEW.log_id AND order_id = '20261023-087')
  AND EXISTS (SELECT 1 FROM luggage_order_price_corrections)
BEGIN SELECT RAISE(ABORT, 'Preserve corrected order audits'); END;

-- Additional bags after payment; original claims and receipts remain immutable.
-- Independent remaining-period batches; original prepaid period and discount remain unchanged.
CREATE TABLE luggage_bag_additions (
  addition_id TEXT PRIMARY KEY CHECK(length(addition_id)=36),
  order_id TEXT NOT NULL REFERENCES luggage_orders(order_id),
  request_hash TEXT NOT NULL CHECK(length(request_hash)=64),
  suitcase_added INTEGER NOT NULL CHECK(typeof(suitcase_added)='integer' AND suitcase_added BETWEEN 0 AND 99),
  backpack_added INTEGER NOT NULL CHECK(typeof(backpack_added)='integer' AND backpack_added BETWEEN 0 AND 99),
  set_added INTEGER NOT NULL CHECK(set_added=min(suitcase_added,backpack_added)),
  before_suitcase INTEGER NOT NULL, before_backpack INTEGER NOT NULL, before_set_qty INTEGER NOT NULL,
  before_price_per_day INTEGER NOT NULL,
  after_suitcase INTEGER NOT NULL CHECK(after_suitcase=before_suitcase+suitcase_added AND after_suitcase BETWEEN 0 AND 99),
  after_backpack INTEGER NOT NULL CHECK(after_backpack=before_backpack+backpack_added AND after_backpack BETWEEN 0 AND 99),
  after_set_qty INTEGER NOT NULL CHECK(after_set_qty=before_set_qty+set_added),
  batch_price_per_day INTEGER NOT NULL CHECK(batch_price_per_day=set_added*1200+(suitcase_added-set_added)*800+(backpack_added-set_added)*500),
  after_price_per_day INTEGER NOT NULL CHECK(after_price_per_day=before_price_per_day+batch_price_per_day AND after_price_per_day<=500000),
  coverage_start_date TEXT NOT NULL, coverage_end_date TEXT NOT NULL, original_pickup_at TEXT NOT NULL,
  storage_days INTEGER NOT NULL CHECK(storage_days=CAST(julianday(coverage_end_date)-julianday(coverage_start_date) AS INTEGER)+1 AND storage_days BETWEEN 1 AND 3660),
  discount_rate REAL NOT NULL CHECK(discount_rate=CASE WHEN storage_days>=60 THEN 0.20 WHEN storage_days>=30 THEN 0.15 WHEN storage_days>=14 THEN 0.10 WHEN storage_days>=7 THEN 0.05 ELSE 0 END),
  base_amount INTEGER NOT NULL CHECK(base_amount=batch_price_per_day*storage_days),
  discounted_amount INTEGER NOT NULL CHECK(discounted_amount=CAST(round(base_amount*(1-discount_rate)) AS INTEGER) AND discounted_amount<=500000),
  flying_pass_tier TEXT NOT NULL CHECK(flying_pass_tier IN ('NONE','BLUE','SILVER','GOLD','PLATINUM','BLACK')),
  flying_pass_discount_amount INTEGER NOT NULL CHECK(flying_pass_discount_amount=CASE WHEN flying_pass_tier='BLACK' THEN discounted_amount ELSE 0 END),
  amount INTEGER NOT NULL CHECK(typeof(amount)='integer' AND amount=discounted_amount-flying_pass_discount_amount AND amount BETWEEN 0 AND 500000),
  policy_version TEXT NOT NULL CHECK(policy_version='SEPARATE_REMAINING_PERIOD_V1'),
  before_updated_at TEXT NOT NULL, revision TEXT NOT NULL,
  business_date TEXT NOT NULL, created_at TEXT NOT NULL,
  staff_id TEXT NOT NULL CHECK(length(trim(staff_id))>0),
  reason TEXT NOT NULL CHECK(length(trim(reason)) BETWEEN 1 AND 200),
  audit_id INTEGER NOT NULL UNIQUE REFERENCES luggage_audit_logs(log_id),
  CHECK(suitcase_added+backpack_added>0),
  CHECK(coverage_start_date=business_date AND coverage_end_date=date(original_pickup_at,'+9 hours')),
  CHECK(business_date=date(created_at,'+9 hours') AND julianday(revision)>julianday(before_updated_at))
);
CREATE INDEX idx_luggage_bag_additions_order ON luggage_bag_additions(order_id);

CREATE UNIQUE INDEX idx_luggage_bag_addition_audit ON luggage_audit_logs(device_id) WHERE action='BAG_ADDITION_REGISTER';

DROP VIEW luggage_billing_lines;
CREATE VIEW IF NOT EXISTS luggage_billing_lines AS
WITH ledger AS (
  SELECT order_id, COUNT(*) AS payment_count, SUM(amount) AS recorded_amount,
    MAX(julianday(recorded_at)) AS last_receipt_at,
    SUM(CASE WHEN julianday(recorded_at) IS NULL THEN 1 ELSE 0 END) AS invalid_receipt_dates,
    SUM(receipt_request_id IS NOT NULL) AS modern_receipt_count,
    SUM(CASE WHEN typeof(amount) != 'integer' OR amount < 0 THEN 1 ELSE 0 END) AS invalid_receipt_amounts
  FROM luggage_order_payments GROUP BY order_id
), refunds AS (
  SELECT order_id, SUM(CASE WHEN status = 'CONFIRMED' THEN amount ELSE 0 END) AS refunded,
    SUM(status = 'PAYOUT_PENDING') AS pending, SUM(status = 'CONFIRMED') AS refund_count
  FROM luggage_flying_pass_refunds GROUP BY order_id
), price_events AS (
  SELECT log_id, order_id, staff_id, timestamp,
    CASE WHEN json_valid(details) THEN details ELSE '{}' END AS payload
  FROM luggage_audit_logs WHERE action = 'UPDATE_PRICE'
), bag_additions AS (
  SELECT order_id, SUM(amount) AS amount, COUNT(*) AS count, SUM(batch_price_per_day) AS daily_rate, SUM(discounted_amount) AS discounted_amount, SUM(flying_pass_discount_amount) AS pass_discount FROM luggage_bag_additions GROUP BY order_id
), amounts AS (
  SELECT o.*, COALESCE(o.parent_order_id, o.order_id) AS root_id,
    COALESCE(o.final_amount, o.prepaid_amount, 0) + COALESCE(o.extra_amount, 0) + COALESCE(b.amount, 0) AS billed_amount,
    COALESCE(b.amount, 0) AS bag_addition_amount, COALESCE(b.count,0) AS bag_addition_count, COALESCE(b.daily_rate,0) AS bag_addition_daily_rate, COALESCE(b.discounted_amount,0) AS bag_addition_discounted_amount, COALESCE(b.pass_discount,0) AS bag_addition_pass_discount, o.price_per_day-COALESCE(b.daily_rate,0) AS bag_original_price_per_day,
    COALESCE(p.recorded_amount, 0) AS recorded_amount, COALESCE(p.payment_count, 0) AS payment_count,
    COALESCE(f.refunded, 0) AS discount_credit_amount, COALESCE(f.refunded, 0) AS cash_refunded_amount,
    COALESCE(f.pending, 0) AS pending_refund_count, COALESCE(f.refund_count, 0) AS refund_count,
    COALESCE(o.final_amount, o.prepaid_amount, 0) + COALESCE(o.extra_amount, 0) + COALESCE(b.amount, 0) - COALESCE(f.refunded, 0) AS effective_billed_amount,
    COALESCE(p.recorded_amount, 0) - COALESCE(f.refunded, 0) AS net_received_amount,
    (SELECT refund_id FROM luggage_flying_pass_refunds f3 WHERE f3.order_id = o.order_id AND f3.status = 'CONFIRMED' ORDER BY sequence DESC LIMIT 1) AS latest_confirmed_refund_id,
    (SELECT refund_id FROM luggage_flying_pass_refunds f4 WHERE f4.order_id = o.order_id AND f4.status = 'PAYOUT_PENDING') AS pending_refund_id,
    COALESCE((SELECT after_tier FROM luggage_flying_pass_refunds f2 WHERE f2.order_id = o.order_id AND f2.status = 'CONFIRMED' ORDER BY sequence DESC LIMIT 1), o.flying_pass_tier) AS effective_flying_pass_tier,
    p.last_receipt_at, p.invalid_receipt_dates, COALESCE(p.modern_receipt_count, 0) AS modern_receipt_count,
    COALESCE(p.invalid_receipt_amounts, 0) AS invalid_receipt_amounts,
    CASE WHEN o.status IN ('PAID', 'PICKED_UP') AND COALESCE(p.payment_count, 0) = 0
      THEN COALESCE(o.final_amount, o.prepaid_amount, 0) + COALESCE(o.extra_amount, 0) ELSE 0 END AS legacy_paid_estimate,
    CASE WHEN o.parent_order_id IS NOT NULL THEN COALESCE(o.extension_date,
      CASE WHEN o.expected_storage_days > 1 THEN date(o.expected_pickup_at, '+9 hours') END,
      MAX(date(o.created_at, '+9 hours'), date(r.expected_pickup_at, '+9 hours', '+1 day')))
    END AS coverage_end
  FROM luggage_orders o LEFT JOIN luggage_orders r ON r.order_id = o.parent_order_id
  LEFT JOIN bag_additions b ON b.order_id = o.order_id
  LEFT JOIN ledger p ON p.order_id = o.order_id LEFT JOIN refunds f ON f.order_id = o.order_id WHERE o.status != 'CANCELLED'
), evidence AS (
  SELECT m.*, m.effective_billed_amount - m.net_received_amount - m.legacy_paid_estimate AS raw_balance,
    CASE WHEN m.parent_order_id IS NULL AND m.status IN ('PAID', 'PICKED_UP')
      AND m.payment_count > 0 AND m.effective_billed_amount != m.net_received_amount
      AND NOT (m.bag_addition_amount > 0 AND m.effective_billed_amount - m.net_received_amount BETWEEN 0 AND m.bag_addition_amount)
      THEN 1 ELSE 0 END AS root_review_required,
    (SELECT a.log_id FROM price_events a WHERE a.order_id = m.order_id
      AND m.parent_order_id IS NULL AND m.status IN ('PAID', 'PICKED_UP')
      AND m.payment_count > 0 AND m.effective_billed_amount != m.net_received_amount
      AND m.bag_addition_amount = 0 AND m.modern_receipt_count = 0 AND m.invalid_receipt_dates = 0 AND m.invalid_receipt_amounts = 0
      AND a.staff_id IS NOT NULL AND trim(a.staff_id) != '' AND a.staff_id != 'SYSTEM'
      -- Same-second events cannot prove ordering. Legacy text-only events lack a before image.
      AND julianday(a.timestamp) > m.last_receipt_at
      AND json_type(a.payload, '$.before.prepaid_amount') = 'integer'
      AND json_type(a.payload, '$.after.finalAmount') = 'integer'
      AND COALESCE(json_extract(a.payload, '$.before.final_amount'), json_extract(a.payload, '$.before.prepaid_amount'))
        + COALESCE(json_extract(a.payload, '$.before.extra_amount'), 0) = m.recorded_amount
      AND COALESCE(json_extract(a.payload, '$.before.extra_amount'), 0) = m.extra_amount
      AND json_extract(a.payload, '$.after.finalAmount') = m.final_amount
      AND json_extract(a.payload, '$.after.finalAmount') = m.prepaid_amount
      ORDER BY julianday(a.timestamp) DESC, a.log_id DESC LIMIT 1) AS reprice_audit_log_id
  FROM amounts m
)
SELECT e.*,
  CASE WHEN root_review_required = 1 THEN ABS(raw_balance) ELSE 0 END AS root_review_amount,
  CASE WHEN root_review_required = 1 THEN raw_balance ELSE 0 END AS root_review_difference,
  CASE WHEN root_review_required = 1 AND reprice_audit_log_id IS NOT NULL
    THEN 'AUDITED_POST_PAYMENT_REPRICE'
    WHEN root_review_required = 1 THEN 'UNVERIFIED_ROOT_DIFFERENCE' END AS root_review_reason,
  CASE WHEN root_review_required = 1 AND (reprice_audit_log_id IS NULL OR raw_balance < 0) THEN 1 ELSE 0 END AS review_pickup_blocked,
  CASE WHEN root_review_required = 1 THEN 0 ELSE MAX(0, raw_balance) END AS collectible_amount
FROM evidence e;
DROP VIEW luggage_billing_balances;
CREATE VIEW IF NOT EXISTS luggage_billing_balances AS
WITH totals AS (
  SELECT root_id, SUM(parent_order_id IS NOT NULL) AS extension_count, SUM(billed_amount) AS billed_amount, SUM(bag_addition_amount) AS bag_addition_amount, SUM(bag_addition_count) AS bag_addition_count, SUM(bag_addition_daily_rate) AS bag_addition_daily_rate, SUM(bag_addition_discounted_amount) AS bag_addition_discounted_amount, SUM(bag_addition_pass_discount) AS bag_addition_pass_discount, MAX(CASE WHEN parent_order_id IS NULL THEN bag_original_price_per_day ELSE 0 END) AS bag_original_price_per_day,
    SUM(recorded_amount) AS recorded_amount, SUM(discount_credit_amount) AS discount_credit_amount,
    SUM(cash_refunded_amount) AS cash_refunded_amount, SUM(net_received_amount) AS net_received_amount,
    SUM(effective_billed_amount) AS effective_billed_amount, SUM(pending_refund_count) AS pending_refund_count, SUM(refund_count) AS refund_count,
    MAX(latest_confirmed_refund_id) AS latest_confirmed_refund_id, MAX(pending_refund_id) AS pending_refund_id,
    MAX(CASE WHEN parent_order_id IS NULL THEN effective_flying_pass_tier END) AS effective_flying_pass_tier, SUM(legacy_paid_estimate) AS legacy_paid_estimate,
    SUM(MAX(0, -raw_balance)) AS overpaid_amount,
    SUM(collectible_amount) AS line_outstanding,
    SUM(CASE WHEN parent_order_id IS NOT NULL THEN collectible_amount ELSE 0 END) AS extension_line_outstanding,
    SUM(root_review_required) AS root_review_required, SUM(root_review_amount) AS root_review_amount,
    SUM(root_review_difference) AS root_review_difference, MAX(root_review_reason) AS root_review_reason,
    MAX(reprice_audit_log_id) AS reprice_audit_log_id, MAX(review_pickup_blocked) AS review_pickup_blocked,
    MAX(CASE WHEN invalid_receipt_amounts > 0 OR typeof(prepaid_amount) != 'integer' OR prepaid_amount < 0
      OR (final_amount IS NOT NULL AND (typeof(final_amount) != 'integer' OR final_amount < 0))
      OR typeof(extra_amount) != 'integer' OR extra_amount < 0
      OR typeof(price_per_day) != 'integer' OR recorded_amount < 0
      OR discount_credit_amount > COALESCE(final_amount, prepaid_amount) + bag_addition_amount OR effective_billed_amount < 0 OR net_received_amount < 0
      OR raw_balance < 0 OR billed_amount < 0 OR billed_amount != CAST(billed_amount AS INTEGER)
      OR price_per_day < 0 OR price_per_day != CAST(price_per_day AS INTEGER)
      OR billed_amount > 500000 OR price_per_day > 500000 THEN 1 ELSE 0 END) AS invalid_amount
  FROM luggage_billing_lines GROUP BY root_id
), projected AS (
  SELECT root_id, SUM(amount) AS amount, COUNT(*) AS days FROM luggage_unbilled_extension_days GROUP BY root_id
)
SELECT t.*, 2 AS refund_settlement_version, t.effective_billed_amount + COALESCE(p.amount, 0) AS total_effective_billed_amount, COALESCE(p.amount, 0) AS unbilled_amount, COALESCE(p.days, 0) AS unbilled_days,
  t.billed_amount + COALESCE(p.amount, 0) AS total_billed_amount,
  t.extension_line_outstanding + COALESCE(p.amount, 0) AS extension_outstanding_amount,
  t.line_outstanding + COALESCE(p.amount, 0) AS outstanding_amount
FROM totals t LEFT JOIN projected p ON p.root_id = t.root_id;
CREATE TRIGGER luggage_bag_addition_insert_guard BEFORE INSERT ON luggage_bag_additions
BEGIN
  SELECT CASE WHEN NEW.business_date!=date('now','+9 hours')
    OR (NEW.coverage_end_date=NEW.business_date AND time('now','+9 hours')>='21:00:00')
    OR NOT EXISTS(SELECT 1 FROM luggage_orders o JOIN luggage_billing_balances b ON b.root_id=o.order_id
      WHERE o.order_id=NEW.order_id AND o.parent_order_id IS NULL AND o.status='PAID'
        AND date(o.created_at,'+9 hours')<=NEW.business_date
        AND o.expected_pickup_at=NEW.original_pickup_at AND date(o.expected_pickup_at,'+9 hours')>=NEW.business_date
        AND o.actual_pickup_at IS NULL AND o.staff_prepaid_override_amount IS NULL
        AND o.suitcase_qty=NEW.before_suitcase AND o.backpack_qty=NEW.before_backpack
        AND o.price_per_day=NEW.before_price_per_day AND o.updated_at=NEW.before_updated_at
        AND o.set_qty=NEW.before_set_qty AND b.effective_flying_pass_tier=NEW.flying_pass_tier
        AND b.outstanding_amount=0 AND b.root_review_required=0 AND b.invalid_amount=0
        AND b.legacy_paid_estimate=0 AND b.pending_refund_count=0
        AND b.recorded_amount=b.total_billed_amount
        AND b.total_billed_amount+NEW.amount<=500000)
    OR EXISTS(SELECT 1 FROM luggage_orders WHERE parent_order_id=NEW.order_id)
    OR EXISTS(SELECT 1 FROM luggage_flying_pass_refunds WHERE order_id=NEW.order_id AND status='PAYOUT_PENDING')
    OR EXISTS(SELECT 1 FROM luggage_cash_closings WHERE business_date=NEW.business_date AND closing_type='FINAL_CLOSE')
    OR NOT EXISTS(SELECT 1 FROM luggage_audit_logs a WHERE a.log_id=NEW.audit_id AND a.order_id=NEW.order_id
      AND a.staff_id=NEW.staff_id AND a.action='BAG_ADDITION_REGISTER' AND a.device_id=NEW.addition_id
      AND json_valid(a.details) AND json_extract(a.details,'$.requestHash')=NEW.request_hash
      AND json_extract(a.details,'$.amount')=NEW.amount AND json_extract(a.details,'$.revision')=NEW.revision)
    THEN RAISE(ABORT,'BAG_ADDITION_CONFLICT') END;
END;
CREATE TRIGGER luggage_bag_addition_apply AFTER INSERT ON luggage_bag_additions
BEGIN
  UPDATE luggage_orders SET suitcase_qty=NEW.after_suitcase,backpack_qty=NEW.after_backpack,
    set_qty=NEW.after_set_qty,price_per_day=NEW.after_price_per_day,updated_at=NEW.revision
    WHERE order_id=NEW.order_id AND updated_at=NEW.before_updated_at;
  SELECT CASE WHEN changes()!=1 THEN RAISE(ABORT,'BAG_ADDITION_STALE') END;
END;
CREATE TRIGGER luggage_bag_addition_no_update BEFORE UPDATE ON luggage_bag_additions
BEGIN SELECT RAISE(ABORT,'Preserve bag addition history'); END;
CREATE TRIGGER luggage_bag_addition_no_delete BEFORE DELETE ON luggage_bag_additions
BEGIN SELECT RAISE(ABORT,'Preserve bag addition history'); END;
CREATE TRIGGER luggage_bag_addition_no_replace BEFORE INSERT ON luggage_bag_additions
WHEN EXISTS(SELECT 1 FROM luggage_bag_additions WHERE addition_id=NEW.addition_id)
BEGIN SELECT RAISE(ABORT,'Preserve bag addition history'); END;
CREATE TRIGGER luggage_bag_preserve_order BEFORE UPDATE ON luggage_orders
WHEN EXISTS(SELECT 1 FROM luggage_bag_additions WHERE order_id=OLD.order_id)
BEGIN
  SELECT CASE WHEN NEW.prepaid_amount IS NOT OLD.prepaid_amount OR NEW.final_amount IS NOT OLD.final_amount
    OR NEW.extra_amount IS NOT OLD.extra_amount OR NEW.parent_order_id IS NOT OLD.parent_order_id
    OR NEW.created_at IS NOT OLD.created_at OR NEW.expected_storage_days IS NOT OLD.expected_storage_days
    OR date(NEW.expected_pickup_at,'+9 hours') IS NOT date(OLD.expected_pickup_at,'+9 hours') OR NEW.flying_pass_tier IS NOT OLD.flying_pass_tier
    OR NEW.flying_pass_discount_amount IS NOT OLD.flying_pass_discount_amount
    OR NEW.staff_prepaid_override_amount IS NOT OLD.staff_prepaid_override_amount
    OR NEW.status NOT IN ('PAID','PICKED_UP') OR NEW.order_id IS NOT OLD.order_id
    THEN RAISE(ABORT,'Preserve bag addition original claim') END;
  SELECT CASE WHEN (NEW.suitcase_qty IS NOT OLD.suitcase_qty OR NEW.backpack_qty IS NOT OLD.backpack_qty
      OR NEW.set_qty IS NOT OLD.set_qty OR NEW.price_per_day IS NOT OLD.price_per_day)
    AND NOT EXISTS(SELECT 1 FROM luggage_bag_additions a WHERE a.order_id=OLD.order_id
      AND a.before_updated_at=OLD.updated_at AND a.revision=NEW.updated_at
      AND a.before_suitcase=OLD.suitcase_qty AND a.before_backpack=OLD.backpack_qty AND a.before_price_per_day=OLD.price_per_day
      AND a.after_suitcase=NEW.suitcase_qty AND a.after_backpack=NEW.backpack_qty AND a.after_set_qty=NEW.set_qty AND a.after_price_per_day=NEW.price_per_day)
    THEN RAISE(ABORT,'Use audited bag addition') END;
END;
CREATE TRIGGER luggage_bag_preserve_receipt_update BEFORE UPDATE ON luggage_order_payments
WHEN EXISTS(SELECT 1 FROM luggage_bag_additions WHERE order_id=OLD.order_id OR order_id=NEW.order_id)
BEGIN SELECT RAISE(ABORT,'Preserve bag addition receipts'); END;
CREATE TRIGGER luggage_bag_preserve_receipt_delete BEFORE DELETE ON luggage_order_payments
WHEN EXISTS(SELECT 1 FROM luggage_bag_additions WHERE order_id=OLD.order_id)
BEGIN SELECT RAISE(ABORT,'Preserve bag addition receipts'); END;
CREATE TRIGGER luggage_bag_receipt_insert_guard BEFORE INSERT ON luggage_order_payments
WHEN EXISTS(SELECT 1 FROM luggage_bag_additions WHERE order_id=NEW.order_id)
BEGIN
  SELECT CASE WHEN NEW.receipt_request_id IS NULL
    OR EXISTS(SELECT 1 FROM luggage_cash_closings WHERE business_date=NEW.business_date AND closing_type='FINAL_CLOSE')
    THEN RAISE(ABORT,'Use open-day collection confirmation for bag additions') END;
END;
CREATE TRIGGER luggage_bag_order_no_delete BEFORE DELETE ON luggage_orders
WHEN EXISTS(SELECT 1 FROM luggage_bag_additions WHERE order_id=OLD.order_id)
BEGIN SELECT RAISE(ABORT,'Preserve bag addition order'); END;
CREATE TRIGGER luggage_bag_order_no_replace BEFORE INSERT ON luggage_orders
WHEN EXISTS(SELECT 1 FROM luggage_orders o JOIN luggage_bag_additions a ON a.order_id=o.order_id WHERE o.order_id=NEW.order_id)
BEGIN SELECT RAISE(ABORT,'Preserve bag addition order'); END;
CREATE TRIGGER luggage_bag_receipt_no_replace BEFORE INSERT ON luggage_order_payments
WHEN EXISTS(SELECT 1 FROM luggage_order_payments p JOIN luggage_bag_additions a ON a.order_id=p.order_id WHERE p.payment_id=NEW.payment_id)
BEGIN SELECT RAISE(ABORT,'Preserve bag addition receipts'); END;
CREATE TRIGGER luggage_bag_audit_no_update BEFORE UPDATE ON luggage_audit_logs
WHEN EXISTS(SELECT 1 FROM luggage_bag_additions WHERE order_id=OLD.order_id)
BEGIN SELECT RAISE(ABORT,'Preserve bag addition audit'); END;
CREATE TRIGGER luggage_bag_audit_no_delete BEFORE DELETE ON luggage_audit_logs
WHEN EXISTS(SELECT 1 FROM luggage_bag_additions WHERE order_id=OLD.order_id)
BEGIN SELECT RAISE(ABORT,'Preserve bag addition audit'); END;
CREATE TRIGGER luggage_bag_audit_no_replace BEFORE INSERT ON luggage_audit_logs
WHEN EXISTS(SELECT 1 FROM luggage_audit_logs log JOIN luggage_bag_additions a ON a.order_id=log.order_id WHERE log.log_id=NEW.log_id)
BEGIN SELECT RAISE(ABORT,'Preserve bag addition audit'); END;

DROP TRIGGER luggage_refund_insert_guard;
CREATE TRIGGER luggage_refund_insert_guard BEFORE INSERT ON luggage_flying_pass_refunds
BEGIN
  SELECT CASE WHEN EXISTS (SELECT 1 FROM luggage_flying_pass_refunds WHERE refund_id = NEW.refund_id)
    OR NEW.status != 'PAYOUT_PENDING' OR NEW.business_date != date('now', '+9 hours')
    OR NOT EXISTS (SELECT 1 FROM luggage_orders o JOIN luggage_billing_balances b ON b.root_id = o.order_id
      WHERE o.order_id = NEW.order_id AND o.parent_order_id IS NULL AND o.status = 'PAID'
        AND o.staff_prepaid_override_amount IS NULL AND o.final_amount + COALESCE((SELECT SUM(amount) FROM luggage_bag_additions ba WHERE ba.order_id=o.order_id),0) = NEW.original_amount AND o.prepaid_amount = o.final_amount
        AND b.invalid_amount = 0 AND b.root_review_required = 0 AND b.review_pickup_blocked = 0
        AND b.outstanding_amount = 0 AND b.unbilled_days = 0 AND b.legacy_paid_estimate = 0
        AND EXISTS (SELECT 1 FROM luggage_order_payments p WHERE p.order_id = o.order_id)
        AND (SELECT SUM(amount) FROM luggage_order_payments p WHERE p.order_id = o.order_id) = o.final_amount + o.extra_amount + COALESCE((SELECT SUM(amount) FROM luggage_bag_additions ba WHERE ba.order_id=o.order_id),0))

    OR NEW.root_snapshot IS NOT (SELECT json_object('order_id',order_id,'parent_order_id',parent_order_id,'status',status,'created_at',created_at,'prepaid_amount',prepaid_amount,'final_amount',final_amount,'extra_amount',extra_amount,'price_per_day',price_per_day,'expected_storage_days',expected_storage_days,'flying_pass_tier',flying_pass_tier,'flying_pass_discount_amount',flying_pass_discount_amount,'staff_prepaid_override_amount',staff_prepaid_override_amount,'suitcase_qty',suitcase_qty,'backpack_qty',backpack_qty,'set_qty',set_qty,'expected_pickup_at',expected_pickup_at,'extension_date',extension_date) FROM luggage_orders WHERE order_id = NEW.order_id)
    OR NEW.receipt_snapshot IS NOT (SELECT json_group_array(json_object('payment_id',payment_id,'tender_type',tender_type,'amount',amount,'business_date',business_date,'recorded_at',recorded_at,'staff_id',staff_id,'receipt_request_id',receipt_request_id)) FROM (SELECT * FROM luggage_order_payments WHERE order_id = NEW.order_id ORDER BY payment_id))
    OR EXISTS (SELECT 1 FROM luggage_cash_closings WHERE business_date = NEW.business_date AND closing_type = 'FINAL_CLOSE')
    OR EXISTS (SELECT 1 FROM luggage_flying_pass_refunds WHERE order_id = NEW.order_id AND status = 'PAYOUT_PENDING')
    OR NEW.sequence != COALESCE((SELECT MAX(sequence) FROM luggage_flying_pass_refunds WHERE order_id = NEW.order_id), 0) + 1
    OR NEW.previous_refund_id IS NOT (SELECT refund_id FROM luggage_flying_pass_refunds WHERE order_id = NEW.order_id AND status = 'CONFIRMED' ORDER BY sequence DESC LIMIT 1)
    OR NEW.before_amount != NEW.original_amount - COALESCE((SELECT SUM(amount) FROM luggage_flying_pass_refunds WHERE order_id = NEW.order_id AND status = 'CONFIRMED'), 0)
    OR NEW.before_tier != COALESCE((SELECT after_tier FROM luggage_flying_pass_refunds WHERE order_id = NEW.order_id AND status = 'CONFIRMED' ORDER BY sequence DESC LIMIT 1),
      (SELECT flying_pass_tier FROM luggage_orders WHERE order_id = NEW.order_id))
    OR NOT EXISTS (SELECT 1 FROM luggage_audit_logs a WHERE a.log_id = NEW.register_audit_id AND a.order_id = NEW.order_id
      AND a.device_id = NEW.refund_id AND a.action = 'FLYING_PASS_REFUND_REGISTER' AND a.staff_id = NEW.registered_by_staff_id
      AND json_valid(a.details) AND json_extract(a.details, '$.requestHash') = NEW.request_hash
      AND json_extract(a.details, '$.amount') = NEW.amount
      AND json_extract(a.details, '$.beforeTier') = NEW.before_tier AND json_extract(a.details, '$.afterTier') = NEW.after_tier
      AND json_extract(a.details, '$.beforeAmount') = NEW.before_amount AND json_extract(a.details, '$.afterAmount') = NEW.after_amount AND json_extract(a.details, '$.actor.userId') = NEW.actor_user_id)
    THEN RAISE(ABORT, 'REFUND_REGISTRATION_CONFLICT') END;
END;
DROP TRIGGER luggage_refund_transition_guard;
CREATE TRIGGER luggage_refund_transition_guard BEFORE UPDATE ON luggage_flying_pass_refunds
BEGIN
  SELECT CASE WHEN OLD.status != 'PAYOUT_PENDING' OR NEW.status NOT IN ('CONFIRMED','CANCELLED')
    OR NEW.refund_id IS NOT OLD.refund_id OR NEW.order_id IS NOT OLD.order_id OR NEW.sequence IS NOT OLD.sequence
    OR NEW.previous_refund_id IS NOT OLD.previous_refund_id OR NEW.currency IS NOT OLD.currency OR NEW.refund_method IS NOT OLD.refund_method
    OR NEW.before_tier IS NOT OLD.before_tier OR NEW.after_tier IS NOT OLD.after_tier
    OR NEW.original_amount IS NOT OLD.original_amount OR NEW.before_amount IS NOT OLD.before_amount OR NEW.after_amount IS NOT OLD.after_amount OR NEW.amount IS NOT OLD.amount
    OR NEW.reason IS NOT OLD.reason OR NEW.request_hash IS NOT OLD.request_hash OR NEW.root_snapshot IS NOT OLD.root_snapshot OR NEW.receipt_snapshot IS NOT OLD.receipt_snapshot
    OR NEW.registered_by_staff_id IS NOT OLD.registered_by_staff_id OR NEW.actor_user_id IS NOT OLD.actor_user_id
    OR NEW.business_date IS NOT OLD.business_date OR NEW.created_at IS NOT OLD.created_at OR NEW.register_audit_id IS NOT OLD.register_audit_id
    OR NOT EXISTS (SELECT 1 FROM luggage_audit_logs a WHERE a.log_id = NEW.terminal_audit_id AND a.order_id = NEW.order_id AND a.device_id = NEW.refund_id
      AND a.staff_id = NEW.terminal_by_staff_id AND a.action = CASE NEW.status WHEN 'CONFIRMED' THEN 'FLYING_PASS_REFUND_CONFIRM' ELSE 'FLYING_PASS_REFUND_CANCEL' END
      AND json_valid(a.details) AND json_extract(a.details, '$.terminalHash') = NEW.terminal_hash
      AND length(trim(COALESCE(json_extract(a.details, '$.actor.userId'), ''))) > 0 AND json_extract(a.details, '$.legacyStaff.id') = NEW.terminal_by_staff_id
      AND CASE NEW.status WHEN 'CONFIRMED' THEN json_extract(a.details, '$.cashPaid') = 1 ELSE json_extract(a.details, '$.confirmNotPaid') = 1 END)
    THEN RAISE(ABORT, 'REFUND_IMMUTABLE_OR_INVALID_TRANSITION') END;
  SELECT CASE WHEN NEW.status = 'CONFIRMED' AND (
    CASE WHEN json_extract((SELECT details FROM luggage_audit_logs WHERE log_id = NEW.terminal_audit_id), '$.lateConfirm') IS NULL
      THEN NEW.business_date != date('now', '+9 hours') OR NEW.paid_at IS NOT NEW.terminal_at
      ELSE NEW.business_date >= date('now', '+9 hours') OR julianday(NEW.paid_at) IS NULL
        OR julianday(NEW.paid_at) < julianday(NEW.created_at) OR julianday(NEW.paid_at) > julianday('now')
        OR NEW.paid_at IS NOT json_extract((SELECT details FROM luggage_audit_logs WHERE log_id = NEW.terminal_audit_id), '$.lateConfirm.paidAt')
        OR length(trim(COALESCE(json_extract((SELECT details FROM luggage_audit_logs WHERE log_id = NEW.terminal_audit_id), '$.lateConfirm.reason'), ''))) NOT BETWEEN 1 AND 200
        OR COALESCE(json_extract((SELECT details FROM luggage_audit_logs WHERE log_id = NEW.terminal_audit_id), '$.actor.role'), '') NOT IN ('manager', 'super_admin')
    END
    OR NEW.root_snapshot IS NOT (SELECT json_object('order_id',order_id,'parent_order_id',parent_order_id,'status',status,'created_at',created_at,'prepaid_amount',prepaid_amount,'final_amount',final_amount,'extra_amount',extra_amount,'price_per_day',price_per_day,'expected_storage_days',expected_storage_days,'flying_pass_tier',flying_pass_tier,'flying_pass_discount_amount',flying_pass_discount_amount,'staff_prepaid_override_amount',staff_prepaid_override_amount,'suitcase_qty',suitcase_qty,'backpack_qty',backpack_qty,'set_qty',set_qty,'expected_pickup_at',expected_pickup_at,'extension_date',extension_date) FROM luggage_orders WHERE order_id = NEW.order_id)
    OR NEW.receipt_snapshot IS NOT (SELECT json_group_array(json_object('payment_id',payment_id,'tender_type',tender_type,'amount',amount,'business_date',business_date,'recorded_at',recorded_at,'staff_id',staff_id,'receipt_request_id',receipt_request_id)) FROM (SELECT * FROM luggage_order_payments WHERE order_id = NEW.order_id ORDER BY payment_id))
    OR EXISTS (SELECT 1 FROM luggage_cash_closings WHERE business_date = date(NEW.paid_at, '+9 hours') AND closing_type = 'FINAL_CLOSE')
    OR NOT EXISTS (SELECT 1 FROM luggage_orders o JOIN luggage_billing_balances b ON b.root_id = o.order_id
      WHERE o.order_id = NEW.order_id AND o.status = 'PAID' AND o.parent_order_id IS NULL AND o.staff_prepaid_override_amount IS NULL
        AND o.final_amount + COALESCE((SELECT SUM(amount) FROM luggage_bag_additions ba WHERE ba.order_id=o.order_id),0) = NEW.original_amount AND o.prepaid_amount = o.final_amount
        AND b.invalid_amount = 0 AND b.root_review_required = 0 AND b.review_pickup_blocked = 0 AND b.outstanding_amount = 0 AND b.unbilled_days = 0 AND b.legacy_paid_estimate = 0
        AND (SELECT SUM(amount) FROM luggage_order_payments p WHERE p.order_id = o.order_id) = o.final_amount + o.extra_amount + COALESCE((SELECT SUM(amount) FROM luggage_bag_additions ba WHERE ba.order_id=o.order_id),0))
    OR NEW.before_amount != NEW.original_amount - COALESCE((SELECT SUM(amount) FROM luggage_flying_pass_refunds WHERE order_id = NEW.order_id AND status = 'CONFIRMED'), 0)
    OR NEW.previous_refund_id IS NOT (SELECT refund_id FROM luggage_flying_pass_refunds WHERE order_id = NEW.order_id AND status = 'CONFIRMED' ORDER BY sequence DESC LIMIT 1))
    THEN RAISE(ABORT, 'REFUND_CONFIRMATION_CONFLICT') END;
END;
DROP TRIGGER luggage_refund_preserve_order;
CREATE TRIGGER luggage_refund_preserve_order BEFORE UPDATE ON luggage_orders
WHEN EXISTS (SELECT 1 FROM luggage_flying_pass_refunds WHERE order_id = OLD.order_id AND status IN ('PAYOUT_PENDING','CONFIRMED'))
  AND (NEW.order_id IS NOT OLD.order_id OR (NEW.status IS NOT OLD.status AND (EXISTS (SELECT 1 FROM luggage_flying_pass_refunds WHERE order_id = OLD.order_id AND status = 'PAYOUT_PENDING')
    OR NOT ((OLD.status = 'PAID' AND NEW.status = 'PICKED_UP') OR (OLD.status = 'PICKED_UP' AND NEW.status = 'PAID'))
    OR EXISTS (SELECT 1 FROM luggage_billing_balances b WHERE b.root_id = OLD.order_id AND (b.invalid_amount != 0 OR b.review_pickup_blocked != 0 OR b.outstanding_amount != 0 OR b.pending_refund_count != 0)))) OR NEW.parent_order_id IS NOT OLD.parent_order_id
    OR NEW.prepaid_amount IS NOT OLD.prepaid_amount OR NEW.final_amount IS NOT OLD.final_amount OR NEW.extra_amount IS NOT OLD.extra_amount
    OR NEW.flying_pass_tier IS NOT OLD.flying_pass_tier OR NEW.flying_pass_discount_amount IS NOT OLD.flying_pass_discount_amount
    OR NEW.staff_prepaid_override_amount IS NOT OLD.staff_prepaid_override_amount OR (NEW.price_per_day IS NOT OLD.price_per_day AND NOT EXISTS(SELECT 1 FROM luggage_bag_additions ba WHERE ba.order_id=OLD.order_id AND ba.before_updated_at=OLD.updated_at AND ba.revision=NEW.updated_at AND ba.before_suitcase=OLD.suitcase_qty AND ba.before_backpack=OLD.backpack_qty AND ba.before_price_per_day=OLD.price_per_day AND ba.after_suitcase=NEW.suitcase_qty AND ba.after_backpack=NEW.backpack_qty AND ba.after_set_qty=NEW.set_qty AND ba.after_price_per_day=NEW.price_per_day))
    OR NEW.expected_storage_days IS NOT OLD.expected_storage_days OR NEW.expected_pickup_at IS NOT OLD.expected_pickup_at
    OR NEW.created_at IS NOT OLD.created_at OR (NEW.suitcase_qty IS NOT OLD.suitcase_qty AND NOT EXISTS(SELECT 1 FROM luggage_bag_additions ba WHERE ba.order_id=OLD.order_id AND ba.before_updated_at=OLD.updated_at AND ba.revision=NEW.updated_at AND ba.before_suitcase=OLD.suitcase_qty AND ba.before_backpack=OLD.backpack_qty AND ba.before_price_per_day=OLD.price_per_day AND ba.after_suitcase=NEW.suitcase_qty AND ba.after_backpack=NEW.backpack_qty AND ba.after_set_qty=NEW.set_qty AND ba.after_price_per_day=NEW.price_per_day)) OR (NEW.backpack_qty IS NOT OLD.backpack_qty AND NOT EXISTS(SELECT 1 FROM luggage_bag_additions ba WHERE ba.order_id=OLD.order_id AND ba.before_updated_at=OLD.updated_at AND ba.revision=NEW.updated_at AND ba.before_suitcase=OLD.suitcase_qty AND ba.before_backpack=OLD.backpack_qty AND ba.before_price_per_day=OLD.price_per_day AND ba.after_suitcase=NEW.suitcase_qty AND ba.after_backpack=NEW.backpack_qty AND ba.after_set_qty=NEW.set_qty AND ba.after_price_per_day=NEW.price_per_day)) OR (NEW.set_qty IS NOT OLD.set_qty AND NOT EXISTS(SELECT 1 FROM luggage_bag_additions ba WHERE ba.order_id=OLD.order_id AND ba.before_updated_at=OLD.updated_at AND ba.revision=NEW.updated_at AND ba.before_suitcase=OLD.suitcase_qty AND ba.before_backpack=OLD.backpack_qty AND ba.before_price_per_day=OLD.price_per_day AND ba.after_suitcase=NEW.suitcase_qty AND ba.after_backpack=NEW.backpack_qty AND ba.after_set_qty=NEW.set_qty AND ba.after_price_per_day=NEW.price_per_day))
    OR NEW.extension_date IS NOT OLD.extension_date)
BEGIN SELECT RAISE(ABORT, 'REFUND_PRESERVE_ORIGINAL_ORDER'); END;
DROP TRIGGER luggage_refund_preserve_receipt_insert;
CREATE TRIGGER luggage_refund_preserve_receipt_insert BEFORE INSERT ON luggage_order_payments
WHEN EXISTS (SELECT 1 FROM luggage_flying_pass_refunds f WHERE f.status IN ('PAYOUT_PENDING','CONFIRMED') AND (f.order_id = NEW.order_id
  OR EXISTS (SELECT 1 FROM luggage_order_payments p WHERE p.payment_id = NEW.payment_id AND p.order_id = f.order_id)))
AND NOT (NEW.receipt_request_id IS NOT NULL
 AND NOT EXISTS(SELECT 1 FROM luggage_order_payments WHERE payment_id=NEW.payment_id)
 AND EXISTS(SELECT 1 FROM luggage_bag_additions WHERE order_id=NEW.order_id)
 AND NOT EXISTS(SELECT 1 FROM luggage_flying_pass_refunds WHERE order_id=NEW.order_id AND status='PAYOUT_PENDING')
 AND EXISTS(SELECT 1 FROM luggage_audit_logs a WHERE a.device_id=NEW.receipt_request_id AND a.action='CONFIRM_COLLECTION' AND a.staff_id=NEW.staff_id)
 AND EXISTS(SELECT 1 FROM luggage_billing_lines l WHERE l.order_id=NEW.order_id AND l.root_review_required=0 AND l.collectible_amount>=NEW.amount))
BEGIN SELECT RAISE(ABORT, 'REFUND_PRESERVE_ORIGINAL_RECEIPT'); END;