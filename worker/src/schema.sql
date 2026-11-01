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
DROP VIEW luggage_sales_daily;
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
    SUM(CASE WHEN status IN ('PAID', 'PICKED_UP') THEN suitcase_qty-COALESCE((SELECT SUM(suitcase_added) FROM luggage_bag_additions b WHERE b.order_id=luggage_orders.order_id),0) ELSE 0 END) AS suitcase_total,
    SUM(CASE WHEN status IN ('PAID', 'PICKED_UP') THEN backpack_qty-COALESCE((SELECT SUM(backpack_added) FROM luggage_bag_additions b WHERE b.order_id=luggage_orders.order_id),0) ELSE 0 END) AS backpack_total
  FROM luggage_orders WHERE parent_order_id IS NULL AND status != 'CANCELLED' GROUP BY business_date
), added_bags AS (SELECT business_date,SUM(suitcase_added) AS suitcase_total,SUM(backpack_added) AS backpack_total FROM luggage_bag_additions GROUP BY business_date), dates AS (SELECT business_date FROM added_bags UNION SELECT business_date FROM receipts UNION SELECT business_date FROM orders UNION SELECT business_date FROM refunds)
SELECT d.business_date, COALESCE(r.cash, 0) - COALESCE(f.amount, 0) AS cash, COALESCE(r.qr, 0) AS qr,
  COALESCE(r.total_amount, 0) - COALESCE(f.amount, 0) AS total_amount,
  COALESCE(r.cash, 0) AS gross_cash, COALESCE(r.qr, 0) AS gross_qr, COALESCE(f.amount, 0) AS cash_refund_amount, COALESCE(f.refund_count, 0) AS refund_count, COALESCE(o.order_count, 0) AS order_count,
  COALESCE(r.legacy_estimated_amount, 0) AS legacy_estimated_amount, COALESCE(r.recorded_amount, 0) AS recorded_amount,
  COALESCE(o.paid_count, 0) AS paid_count, COALESCE(o.pending_count, 0) AS pending_count,
  COALESCE(o.people, 0) AS people, COALESCE(o.suitcase_total, 0)+COALESCE(a.suitcase_total,0) AS suitcase_total,
  COALESCE(o.backpack_total, 0)+COALESCE(a.backpack_total,0) AS backpack_total
FROM dates d LEFT JOIN added_bags a ON a.business_date=d.business_date LEFT JOIN receipts r ON r.business_date = d.business_date LEFT JOIN orders o ON o.business_date = d.business_date LEFT JOIN refunds f ON f.business_date = d.business_date;


-- Additive only: apply before the matching Worker. Creates the display-name table for ERP Part-time Auth workers.
-- actor_id is "pt:" + lowercase ERP Auth UID (also stored in staff_id columns); it never collides with user_profiles UUIDs or "SYSTEM".
-- Does not touch, update or delete any existing table or row.
CREATE TABLE IF NOT EXISTS luggage_part_time_actors (
  actor_id TEXT PRIMARY KEY CHECK (actor_id LIKE 'pt:%' AND length(actor_id) = 39),
  display_name TEXT NOT NULL,
  last_seen_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Staff corrections. Local draft: no production apply or flag enablement.
-- Source receipts remain gross and unchanged. General returns are NOT discount credits.
ALTER TABLE luggage_cash_closings ADD COLUMN qr_gross_amount INTEGER;
ALTER TABLE luggage_cash_closings ADD COLUMN qr_return_amount INTEGER NOT NULL DEFAULT 0;
CREATE TABLE luggage_staff_corrections (
 correction_id TEXT NOT NULL PRIMARY KEY CHECK(length(correction_id)=36),
 order_id TEXT NOT NULL REFERENCES luggage_orders(order_id),
 applied INTEGER NOT NULL DEFAULT 0 CHECK(applied IN (0,1)),
 family_delta INTEGER NOT NULL DEFAULT 0 CHECK(typeof(family_delta)='integer' AND family_delta BETWEEN -500000 AND 500000),
 scope_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(scope_json)),
 before_billed_amount INTEGER NOT NULL DEFAULT 0,
 after_billed_amount INTEGER NOT NULL DEFAULT 0 CHECK(typeof(after_billed_amount)='integer' AND after_billed_amount BETWEEN 0 AND 500000),
 sequence INTEGER NOT NULL CHECK(typeof(sequence)='integer' AND sequence>0),
 request_hash TEXT NOT NULL CHECK(length(request_hash)=64),
 before_json TEXT NOT NULL CHECK(json_valid(before_json)),
 after_json TEXT NOT NULL CHECK(json_valid(after_json)),
 receipts_json TEXT NOT NULL CHECK(json_valid(receipts_json) AND json_type(receipts_json)='array'),
 tender_changes_json TEXT NOT NULL CHECK(json_valid(tender_changes_json) AND json_type(tender_changes_json)='array'),
 return_allocations_json TEXT NOT NULL CHECK(json_valid(return_allocations_json) AND json_type(return_allocations_json)='array'),
 returned_amount INTEGER NOT NULL CHECK(typeof(returned_amount)='integer' AND returned_amount BETWEEN 0 AND 500000),
 return_method TEXT CHECK(return_method IN ('CASH','PAY_QR','UNKNOWN')),
 return_business_date TEXT, return_occurred_at TEXT,
 reason TEXT NOT NULL CHECK(length(trim(reason)) BETWEEN 1 AND 200),
 staff_id TEXT NOT NULL CHECK(length(trim(staff_id)) BETWEEN 1 AND 200),
 actor_json TEXT NOT NULL CHECK(json_valid(actor_json)),
 is_manager INTEGER NOT NULL CHECK(is_manager IN (0,1)),
 recorded_at TEXT NOT NULL CHECK(julianday(recorded_at) IS NOT NULL),
 audit_id INTEGER NOT NULL UNIQUE REFERENCES luggage_audit_logs(log_id),
 UNIQUE(order_id,sequence),
 CHECK((returned_amount=0 AND return_method IS NULL AND return_business_date IS NULL AND return_occurred_at IS NULL)
 OR (returned_amount>0 AND return_method IS NOT NULL AND return_business_date=date(return_business_date)
 AND (return_occurred_at IS NULL OR date(return_occurred_at,'+9 hours')=return_business_date)))
);
CREATE INDEX idx_staff_corrections_order ON luggage_staff_corrections(order_id,sequence);
CREATE UNIQUE INDEX idx_staff_correction_audit ON luggage_audit_logs(device_id) WHERE action='STAFF_ORDER_CORRECTION';
CREATE VIEW luggage_staff_correction_scopes AS SELECT r.order_id AS root_id,json_object('orders',json((SELECT json_group_array(json_object('order_id',order_id,'parent_order_id',parent_order_id,'status',status,'created_at',created_at,'updated_at',updated_at,'expected_pickup_at',expected_pickup_at,'expected_storage_days',expected_storage_days,'suitcase_qty',suitcase_qty,'backpack_qty',backpack_qty,'set_qty',set_qty,'price_per_day',price_per_day,'prepaid_amount',prepaid_amount,'final_amount',final_amount,'extra_amount',extra_amount,'flying_pass_tier',flying_pass_tier,'flying_pass_discount_amount',flying_pass_discount_amount,'staff_prepaid_override_amount',staff_prepaid_override_amount,'payment_method',payment_method)) FROM (SELECT order_id,parent_order_id,status,created_at,updated_at,expected_pickup_at,expected_storage_days,suitcase_qty,backpack_qty,set_qty,price_per_day,prepaid_amount,final_amount,extra_amount,flying_pass_tier,flying_pass_discount_amount,staff_prepaid_override_amount,payment_method FROM luggage_orders WHERE order_id=r.order_id OR parent_order_id=r.order_id ORDER BY order_id))),'payments',json((SELECT json_group_array(json_object('payment_id',payment_id,'order_id',order_id,'business_date',business_date,'tender_type',tender_type,'amount',amount,'recorded_at',recorded_at,'receipt_request_id',receipt_request_id)) FROM (SELECT payment_id,order_id,business_date,tender_type,amount,recorded_at,receipt_request_id FROM luggage_order_payments WHERE order_id IN (SELECT order_id FROM luggage_orders WHERE order_id=r.order_id OR parent_order_id=r.order_id) ORDER BY payment_id))),'additions',json((SELECT json_group_array(json_object('addition_id',addition_id,'order_id',order_id,'amount',amount,'revision',revision)) FROM (SELECT addition_id,order_id,amount,revision FROM luggage_bag_additions WHERE order_id IN (SELECT order_id FROM luggage_orders WHERE order_id=r.order_id OR parent_order_id=r.order_id) ORDER BY addition_id))),'refunds',json((SELECT json_group_array(json_object('refund_id',refund_id,'order_id',order_id,'status',status,'amount',amount)) FROM (SELECT refund_id,order_id,status,amount FROM luggage_flying_pass_refunds WHERE order_id IN (SELECT order_id FROM luggage_orders WHERE order_id=r.order_id OR parent_order_id=r.order_id) ORDER BY refund_id))),'corrections',json((SELECT json_group_array(json_object('correction_id',correction_id,'order_id',order_id,'sequence',sequence,'applied',applied)) FROM (SELECT correction_id,order_id,sequence,applied FROM luggage_staff_corrections WHERE order_id IN (SELECT order_id FROM luggage_orders WHERE order_id=r.order_id OR parent_order_id=r.order_id) ORDER BY sequence)))) AS snapshot_json FROM luggage_orders r WHERE r.parent_order_id IS NULL;
CREATE VIEW luggage_effective_payments AS
SELECT p.payment_id,p.order_id,p.business_date,
 COALESCE((SELECT json_extract(t.value,'$.after') FROM luggage_staff_corrections c,json_each(c.tender_changes_json) t
 WHERE c.order_id=(SELECT COALESCE(o.parent_order_id,o.order_id) FROM luggage_orders o WHERE o.order_id=p.order_id) AND json_extract(t.value,'$.paymentId')=p.payment_id ORDER BY c.sequence DESC LIMIT 1),p.tender_type) AS tender_type,
 p.amount,p.staff_id,p.recorded_at,p.receipt_request_id,p.tender_type AS original_tender_type
FROM luggage_order_payments p;
CREATE VIEW luggage_correction_returns AS
SELECT c.correction_id,c.order_id,c.returned_amount AS amount,c.return_business_date AS business_date,c.return_occurred_at AS occurred_at,
 COALESCE((SELECT json_extract(a.value,'$.method') FROM luggage_staff_corrections r,json_each(r.return_allocations_json) a
 WHERE r.order_id=c.order_id AND json_extract(a.value,'$.correctionId')=c.correction_id ORDER BY r.sequence DESC LIMIT 1),c.return_method) AS method,
 c.staff_id,c.recorded_at
FROM luggage_staff_corrections c WHERE c.returned_amount>0;

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
  AND NOT EXISTS(SELECT 1 FROM luggage_staff_corrections c WHERE c.order_id=OLD.order_id AND c.applied=0 AND OLD.status IS json_extract(c.before_json,'$.status') AND OLD.parent_order_id IS json_extract(c.before_json,'$.parent_order_id') AND OLD.created_at IS json_extract(c.before_json,'$.created_at') AND OLD.expected_pickup_at IS json_extract(c.before_json,'$.expected_pickup_at') AND OLD.expected_storage_days IS json_extract(c.before_json,'$.expected_storage_days') AND OLD.suitcase_qty IS json_extract(c.before_json,'$.suitcase_qty') AND OLD.backpack_qty IS json_extract(c.before_json,'$.backpack_qty') AND OLD.set_qty IS json_extract(c.before_json,'$.set_qty') AND OLD.price_per_day IS json_extract(c.before_json,'$.price_per_day') AND OLD.prepaid_amount IS json_extract(c.before_json,'$.prepaid_amount') AND OLD.final_amount IS json_extract(c.before_json,'$.final_amount') AND OLD.extra_amount IS json_extract(c.before_json,'$.extra_amount') AND OLD.flying_pass_tier IS json_extract(c.before_json,'$.flying_pass_tier') AND OLD.flying_pass_discount_amount IS json_extract(c.before_json,'$.flying_pass_discount_amount') AND OLD.staff_prepaid_override_amount IS json_extract(c.before_json,'$.staff_prepaid_override_amount') AND OLD.payment_method IS json_extract(c.before_json,'$.payment_method') AND OLD.updated_at IS json_extract(c.before_json,'$.updated_at') AND NEW.suitcase_qty IS json_extract(c.after_json,'$.suitcase_qty') AND NEW.backpack_qty IS json_extract(c.after_json,'$.backpack_qty') AND NEW.set_qty IS json_extract(c.after_json,'$.set_qty') AND NEW.price_per_day IS json_extract(c.after_json,'$.price_per_day') AND NEW.prepaid_amount IS json_extract(c.after_json,'$.prepaid_amount') AND NEW.final_amount IS json_extract(c.after_json,'$.final_amount') AND NEW.staff_prepaid_override_amount IS json_extract(c.after_json,'$.staff_prepaid_override_amount') AND NEW.payment_method IS json_extract(c.after_json,'$.payment_method') AND NEW.updated_at IS json_extract(c.after_json,'$.updated_at') AND NEW.extra_amount IS OLD.extra_amount AND NEW.parent_order_id IS OLD.parent_order_id AND NEW.extension_date IS OLD.extension_date)
BEGIN SELECT RAISE(ABORT, 'Collected amounts require a separate correction policy'); END;
CREATE TRIGGER staff_correction_insert_guard BEFORE INSERT ON luggage_staff_corrections BEGIN

 SELECT CASE WHEN NEW.applied!=0 OR EXISTS(SELECT 1 FROM luggage_staff_corrections WHERE correction_id=NEW.correction_id OR rowid=NEW.rowid)
 OR NEW.sequence!=COALESCE((SELECT MAX(sequence) FROM luggage_staff_corrections WHERE order_id=NEW.order_id),0)+1
 OR NOT EXISTS(SELECT 1 FROM luggage_orders o WHERE o.order_id=NEW.order_id AND o.parent_order_id IS NULL
 AND o.status IN ('PAID','PICKED_UP') AND o.status IS json_extract(NEW.before_json,'$.status') AND o.parent_order_id IS json_extract(NEW.before_json,'$.parent_order_id') AND o.created_at IS json_extract(NEW.before_json,'$.created_at') AND o.expected_pickup_at IS json_extract(NEW.before_json,'$.expected_pickup_at') AND o.expected_storage_days IS json_extract(NEW.before_json,'$.expected_storage_days') AND o.suitcase_qty IS json_extract(NEW.before_json,'$.suitcase_qty') AND o.backpack_qty IS json_extract(NEW.before_json,'$.backpack_qty') AND o.set_qty IS json_extract(NEW.before_json,'$.set_qty') AND o.price_per_day IS json_extract(NEW.before_json,'$.price_per_day') AND o.prepaid_amount IS json_extract(NEW.before_json,'$.prepaid_amount') AND o.final_amount IS json_extract(NEW.before_json,'$.final_amount') AND o.extra_amount IS json_extract(NEW.before_json,'$.extra_amount') AND o.flying_pass_tier IS json_extract(NEW.before_json,'$.flying_pass_tier') AND o.flying_pass_discount_amount IS json_extract(NEW.before_json,'$.flying_pass_discount_amount') AND o.staff_prepaid_override_amount IS json_extract(NEW.before_json,'$.staff_prepaid_override_amount') AND o.payment_method IS json_extract(NEW.before_json,'$.payment_method') AND o.updated_at IS json_extract(NEW.before_json,'$.updated_at'))
 THEN RAISE(ABORT,'CORRECTION_STALE') END;
 SELECT CASE WHEN (EXISTS(SELECT 1 FROM luggage_orders WHERE parent_order_id=NEW.order_id)
 OR EXISTS(SELECT 1 FROM luggage_bag_additions WHERE order_id=NEW.order_id)
 OR EXISTS(SELECT 1 FROM luggage_flying_pass_refunds WHERE order_id=NEW.order_id)
 OR EXISTS(SELECT 1 FROM luggage_staff_corrections WHERE order_id=NEW.order_id AND json_extract(after_json,'$.familyAmountOnly')=1)) IS NOT COALESCE(json_extract(NEW.after_json,'$.familyAmountOnly'),0)
 OR (json_extract(NEW.after_json,'$.familyAmountOnly')=1 AND (json_extract(NEW.after_json,'$.prepaid_amount') IS NOT json_extract(NEW.before_json,'$.prepaid_amount') OR json_extract(NEW.after_json,'$.final_amount') IS NOT json_extract(NEW.before_json,'$.final_amount') OR json_extract(NEW.after_json,'$.suitcase_qty') IS NOT json_extract(NEW.before_json,'$.suitcase_qty') OR json_extract(NEW.after_json,'$.backpack_qty') IS NOT json_extract(NEW.before_json,'$.backpack_qty') OR json_extract(NEW.after_json,'$.set_qty') IS NOT json_extract(NEW.before_json,'$.set_qty') OR json_extract(NEW.after_json,'$.price_per_day') IS NOT json_extract(NEW.before_json,'$.price_per_day') OR json_extract(NEW.after_json,'$.staff_prepaid_override_amount') IS NOT json_extract(NEW.before_json,'$.staff_prepaid_override_amount')))
 OR NEW.before_billed_amount IS NOT json_extract(NEW.before_json,'$.billing_total') OR NEW.after_billed_amount IS NOT json_extract(NEW.after_json,'$.billing_total')
 OR (SELECT COUNT(DISTINCT json_extract(value,'$.payment_id')) FROM json_each(NEW.receipts_json))!=json_array_length(NEW.receipts_json)
 THEN RAISE(ABORT,'CORRECTION_SCOPE_INVALID') END;

 SELECT CASE WHEN NEW.scope_json IS NOT (SELECT snapshot_json FROM luggage_staff_correction_scopes WHERE root_id=NEW.order_id)
 OR NEW.before_billed_amount IS NOT (SELECT total_effective_billed_amount FROM luggage_billing_balances WHERE root_id=NEW.order_id)
 OR NOT EXISTS(SELECT 1 FROM luggage_order_payments p JOIN luggage_orders o ON o.order_id=p.order_id WHERE COALESCE(o.parent_order_id,o.order_id)=NEW.order_id)
 OR (SELECT COUNT(*) FROM luggage_order_payments p JOIN luggage_orders o ON o.order_id=p.order_id WHERE COALESCE(o.parent_order_id,o.order_id)=NEW.order_id)!=json_array_length(NEW.receipts_json)
 OR EXISTS(SELECT 1 FROM json_each(NEW.receipts_json) s LEFT JOIN luggage_order_payments p ON p.payment_id=json_extract(s.value,'$.payment_id') LEFT JOIN luggage_orders o ON o.order_id=p.order_id
 WHERE COALESCE(o.parent_order_id,o.order_id) IS NOT NEW.order_id OR p.amount IS NOT json_extract(s.value,'$.amount') OR p.tender_type IS NOT json_extract(s.value,'$.tender_type')
 OR p.business_date IS NOT json_extract(s.value,'$.business_date') OR p.recorded_at IS NOT json_extract(s.value,'$.recorded_at') OR p.receipt_request_id IS NOT json_extract(s.value,'$.receipt_request_id')) THEN RAISE(ABORT,'CORRECTION_UNSUPPORTED_OR_RECEIPT_CHANGED') END;
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM luggage_audit_logs a WHERE a.log_id=NEW.audit_id AND a.order_id=NEW.order_id
 AND a.device_id=NEW.correction_id AND a.staff_id=NEW.staff_id AND a.action='STAFF_ORDER_CORRECTION'
 AND a.timestamp=NEW.recorded_at AND json_extract(a.details,'$.requestHash')=NEW.request_hash
 AND json_extract(a.details,'$.reason')=NEW.reason AND json_extract(a.details,'$.before')=NEW.before_json AND json_extract(a.details,'$.after')=NEW.after_json)
 THEN RAISE(ABORT,'CORRECTION_AUDIT_REQUIRED') END;
 SELECT CASE WHEN json_type(NEW.after_json,'$.final_amount') IS NOT 'integer' OR json_extract(NEW.after_json,'$.final_amount') NOT BETWEEN 0 AND 500000
 OR (json_extract(NEW.after_json,'$.familyAmountOnly') IS NOT 1 AND json_extract(NEW.after_json,'$.prepaid_amount') IS NOT json_extract(NEW.after_json,'$.final_amount'))
 OR (json_extract(NEW.after_json,'$.familyAmountOnly') IS NOT 1 AND json_extract(NEW.after_json,'$.staff_prepaid_override_amount') IS NOT NULL AND json_extract(NEW.after_json,'$.staff_prepaid_override_amount') IS NOT json_extract(NEW.after_json,'$.final_amount'))
 OR json_type(NEW.after_json,'$.suitcase_qty') IS NOT 'integer' OR json_extract(NEW.after_json,'$.suitcase_qty') NOT BETWEEN 0 AND 99
 OR json_type(NEW.after_json,'$.backpack_qty') IS NOT 'integer' OR json_extract(NEW.after_json,'$.backpack_qty') NOT BETWEEN 0 AND 99
 OR json_extract(NEW.after_json,'$.suitcase_qty')+json_extract(NEW.after_json,'$.backpack_qty')<1
 OR json_type(NEW.after_json,'$.price_per_day') IS NOT 'integer' OR json_extract(NEW.after_json,'$.price_per_day') NOT BETWEEN 0 AND 500000
 OR ((json_extract(NEW.after_json,'$.suitcase_qty') IS NOT json_extract(NEW.before_json,'$.suitcase_qty') OR json_extract(NEW.after_json,'$.backpack_qty') IS NOT json_extract(NEW.before_json,'$.backpack_qty'))
 AND json_extract(NEW.after_json,'$.set_qty') IS NOT min(json_extract(NEW.after_json,'$.suitcase_qty'),json_extract(NEW.after_json,'$.backpack_qty')))
 OR ((json_extract(NEW.after_json,'$.suitcase_qty') IS json_extract(NEW.before_json,'$.suitcase_qty') AND json_extract(NEW.after_json,'$.backpack_qty') IS json_extract(NEW.before_json,'$.backpack_qty'))
 AND (json_extract(NEW.after_json,'$.set_qty') IS NOT json_extract(NEW.before_json,'$.set_qty') OR json_extract(NEW.after_json,'$.price_per_day') IS NOT json_extract(NEW.before_json,'$.price_per_day')))
 OR julianday(json_extract(NEW.after_json,'$.updated_at'))<=julianday(json_extract(NEW.before_json,'$.updated_at'))
 OR NEW.return_business_date>date(NEW.recorded_at,'+9 hours')
 OR julianday(NEW.return_occurred_at)>julianday(NEW.recorded_at)
 OR NEW.returned_amount>MAX(0,(SELECT net_received_amount FROM luggage_billing_balances WHERE root_id=NEW.order_id)-NEW.after_billed_amount)
 OR NEW.family_delta IS NOT CASE WHEN json_extract(NEW.after_json,'$.familyAmountOnly')=1 THEN NEW.after_billed_amount-NEW.before_billed_amount ELSE 0 END
 OR (json_extract(NEW.after_json,'$.familyAmountOnly')=1 AND (json_extract(NEW.after_json,'$.final_amount') IS NOT json_extract(NEW.before_json,'$.final_amount')
 OR json_extract(NEW.after_json,'$.suitcase_qty') IS NOT json_extract(NEW.before_json,'$.suitcase_qty') OR json_extract(NEW.after_json,'$.backpack_qty') IS NOT json_extract(NEW.before_json,'$.backpack_qty')))
 THEN RAISE(ABORT,'CORRECTION_INVALID_AMOUNTS') END;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM json_each(NEW.tender_changes_json) t LEFT JOIN luggage_effective_payments p ON p.payment_id=json_extract(t.value,'$.paymentId')
 WHERE (SELECT COALESCE(o.parent_order_id,o.order_id) FROM luggage_orders o WHERE o.order_id=p.order_id) IS NOT NEW.order_id OR p.tender_type IS NOT json_extract(t.value,'$.before')
 OR json_extract(t.value,'$.after') NOT IN ('CASH','PAY_QR') OR json_extract(t.value,'$.after')=json_extract(t.value,'$.before'))
 OR (SELECT COUNT(*) FROM json_each(NEW.tender_changes_json))!=(SELECT COUNT(DISTINCT json_extract(value,'$.paymentId')) FROM json_each(NEW.tender_changes_json))
 OR EXISTS(SELECT 1 FROM json_each(NEW.return_allocations_json) a LEFT JOIN luggage_correction_returns r ON r.correction_id=json_extract(a.value,'$.correctionId')
 WHERE r.order_id IS NOT NEW.order_id OR r.method IS NOT 'UNKNOWN' OR json_extract(a.value,'$.method') NOT IN ('CASH','PAY_QR'))
 THEN RAISE(ABORT,'CORRECTION_INVALID_TENDER') END;

END;
CREATE TRIGGER staff_correction_apply AFTER INSERT ON luggage_staff_corrections BEGIN
 UPDATE luggage_orders SET suitcase_qty=json_extract(NEW.after_json,'$.suitcase_qty'), backpack_qty=json_extract(NEW.after_json,'$.backpack_qty'), set_qty=json_extract(NEW.after_json,'$.set_qty'), price_per_day=json_extract(NEW.after_json,'$.price_per_day'), prepaid_amount=json_extract(NEW.after_json,'$.prepaid_amount'), final_amount=json_extract(NEW.after_json,'$.final_amount'), staff_prepaid_override_amount=json_extract(NEW.after_json,'$.staff_prepaid_override_amount'), payment_method=json_extract(NEW.after_json,'$.payment_method'), updated_at=json_extract(NEW.after_json,'$.updated_at') WHERE order_id=NEW.order_id;
 SELECT CASE WHEN changes()!=1 OR NOT EXISTS(SELECT 1 FROM luggage_orders o WHERE o.order_id=NEW.order_id AND o.suitcase_qty IS json_extract(NEW.after_json,'$.suitcase_qty') AND o.backpack_qty IS json_extract(NEW.after_json,'$.backpack_qty') AND o.set_qty IS json_extract(NEW.after_json,'$.set_qty') AND o.price_per_day IS json_extract(NEW.after_json,'$.price_per_day') AND o.prepaid_amount IS json_extract(NEW.after_json,'$.prepaid_amount') AND o.final_amount IS json_extract(NEW.after_json,'$.final_amount') AND o.staff_prepaid_override_amount IS json_extract(NEW.after_json,'$.staff_prepaid_override_amount') AND o.payment_method IS json_extract(NEW.after_json,'$.payment_method') AND o.updated_at IS json_extract(NEW.after_json,'$.updated_at')) THEN RAISE(ABORT,'CORRECTION_APPLY_FAILED') END;
 UPDATE luggage_staff_corrections SET applied=1 WHERE correction_id=NEW.correction_id;
 SELECT CASE WHEN changes()!=1 THEN RAISE(ABORT,'CORRECTION_SEAL_FAILED') END;
 UPDATE luggage_orders SET status='PAID',updated_at=json_extract(NEW.after_json,'$.updated_at') WHERE parent_order_id=NEW.order_id AND status='PAYMENT_PENDING'
 AND json_extract(NEW.after_json,'$.familyAmountOnly')=1 AND EXISTS(SELECT 1 FROM luggage_billing_balances b WHERE b.root_id=NEW.order_id AND b.outstanding_amount=0 AND b.overpaid_amount=0 AND b.invalid_amount=0);
 SELECT CASE WHEN json_extract(NEW.after_json,'$.familyAmountOnly')=1 AND EXISTS(SELECT 1 FROM luggage_billing_balances b WHERE b.root_id=NEW.order_id AND b.outstanding_amount=0 AND b.overpaid_amount=0 AND b.invalid_amount=0)
 AND EXISTS(SELECT 1 FROM luggage_orders WHERE parent_order_id=NEW.order_id AND status='PAYMENT_PENDING') THEN RAISE(ABORT,'CORRECTION_FAMILY_SETTLEMENT_FAILED') END;
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM luggage_billing_balances b WHERE b.root_id=NEW.order_id AND b.total_effective_billed_amount=NEW.after_billed_amount AND b.invalid_amount=0 AND b.net_received_amount>=0) THEN RAISE(ABORT,'CORRECTION_BILLING_POSTCONDITION') END;
END;
CREATE TRIGGER staff_correction_no_update BEFORE UPDATE ON luggage_staff_corrections WHEN NOT (OLD.applied=0 AND NEW.applied=1 AND NEW.correction_id IS OLD.correction_id AND NEW.order_id IS OLD.order_id AND NEW.family_delta IS OLD.family_delta AND NEW.scope_json IS OLD.scope_json AND NEW.before_billed_amount IS OLD.before_billed_amount AND NEW.after_billed_amount IS OLD.after_billed_amount AND NEW.sequence IS OLD.sequence AND NEW.request_hash IS OLD.request_hash AND NEW.before_json IS OLD.before_json AND NEW.after_json IS OLD.after_json AND NEW.receipts_json IS OLD.receipts_json AND NEW.tender_changes_json IS OLD.tender_changes_json AND NEW.return_allocations_json IS OLD.return_allocations_json AND NEW.returned_amount IS OLD.returned_amount AND NEW.return_method IS OLD.return_method AND NEW.return_business_date IS OLD.return_business_date AND NEW.return_occurred_at IS OLD.return_occurred_at AND NEW.reason IS OLD.reason AND NEW.staff_id IS OLD.staff_id AND NEW.actor_json IS OLD.actor_json AND NEW.is_manager IS OLD.is_manager AND NEW.recorded_at IS OLD.recorded_at AND NEW.audit_id IS OLD.audit_id) BEGIN SELECT RAISE(ABORT,'Preserve correction events'); END;
CREATE TRIGGER staff_correction_no_delete BEFORE DELETE ON luggage_staff_corrections BEGIN SELECT RAISE(ABORT,'Preserve correction events'); END;
CREATE TRIGGER staff_correction_receipt_delete BEFORE DELETE ON luggage_order_payments WHEN EXISTS(SELECT 1 FROM luggage_staff_corrections WHERE order_id=(SELECT COALESCE(so.parent_order_id,so.order_id) FROM luggage_orders so WHERE so.order_id=OLD.order_id))
BEGIN SELECT RAISE(ABORT,'Preserve correction receipt'); END;
CREATE TRIGGER staff_correction_receipt_insert BEFORE INSERT ON luggage_order_payments WHEN EXISTS(SELECT 1 FROM luggage_order_payments p JOIN luggage_staff_corrections c ON c.order_id=(SELECT COALESCE(so.parent_order_id,so.order_id) FROM luggage_orders so WHERE so.order_id=p.order_id) WHERE p.payment_id=NEW.payment_id)
BEGIN SELECT RAISE(ABORT,'Preserve correction receipt'); END;
CREATE TRIGGER staff_correction_receipt_update BEFORE UPDATE ON luggage_order_payments WHEN EXISTS(SELECT 1 FROM luggage_staff_corrections WHERE order_id=(SELECT COALESCE(so.parent_order_id,so.order_id) FROM luggage_orders so WHERE so.order_id=OLD.order_id)) OR EXISTS(SELECT 1 FROM luggage_order_payments p JOIN luggage_staff_corrections c ON c.order_id=(SELECT COALESCE(so.parent_order_id,so.order_id) FROM luggage_orders so WHERE so.order_id=p.order_id) WHERE p.payment_id=NEW.payment_id)
BEGIN SELECT RAISE(ABORT,'Preserve correction receipt'); END;
CREATE TRIGGER staff_correction_audit_delete BEFORE DELETE ON luggage_audit_logs WHEN EXISTS(SELECT 1 FROM luggage_staff_corrections WHERE order_id=(SELECT COALESCE(so.parent_order_id,so.order_id) FROM luggage_orders so WHERE so.order_id=OLD.order_id))
BEGIN SELECT RAISE(ABORT,'Preserve correction audit'); END;
CREATE TRIGGER staff_correction_audit_insert BEFORE INSERT ON luggage_audit_logs WHEN EXISTS(SELECT 1 FROM luggage_audit_logs p JOIN luggage_staff_corrections c ON c.order_id=(SELECT COALESCE(so.parent_order_id,so.order_id) FROM luggage_orders so WHERE so.order_id=p.order_id) WHERE p.log_id=NEW.log_id)
BEGIN SELECT RAISE(ABORT,'Preserve correction audit'); END;
CREATE TRIGGER staff_correction_audit_update BEFORE UPDATE ON luggage_audit_logs WHEN EXISTS(SELECT 1 FROM luggage_staff_corrections WHERE order_id=(SELECT COALESCE(so.parent_order_id,so.order_id) FROM luggage_orders so WHERE so.order_id=OLD.order_id)) OR EXISTS(SELECT 1 FROM luggage_audit_logs p JOIN luggage_staff_corrections c ON c.order_id=(SELECT COALESCE(so.parent_order_id,so.order_id) FROM luggage_orders so WHERE so.order_id=p.order_id) WHERE p.log_id=NEW.log_id)
BEGIN SELECT RAISE(ABORT,'Preserve correction audit'); END;
CREATE TRIGGER staff_correction_order_delete BEFORE DELETE ON luggage_orders WHEN EXISTS(SELECT 1 FROM luggage_staff_corrections WHERE order_id=(SELECT COALESCE(so.parent_order_id,so.order_id) FROM luggage_orders so WHERE so.order_id=OLD.order_id))
BEGIN SELECT RAISE(ABORT,'Preserve correction order'); END;
CREATE TRIGGER staff_correction_order_insert BEFORE INSERT ON luggage_orders WHEN EXISTS(SELECT 1 FROM luggage_orders p JOIN luggage_staff_corrections c ON c.order_id=(SELECT COALESCE(so.parent_order_id,so.order_id) FROM luggage_orders so WHERE so.order_id=p.order_id) WHERE p.order_id=NEW.order_id)
BEGIN SELECT RAISE(ABORT,'Preserve correction order'); END;
CREATE TRIGGER staff_correction_order_update BEFORE UPDATE ON luggage_orders WHEN (NEW.order_id IS NOT OLD.order_id AND (EXISTS(SELECT 1 FROM luggage_staff_corrections WHERE order_id=(SELECT COALESCE(so.parent_order_id,so.order_id) FROM luggage_orders so WHERE so.order_id=OLD.order_id)) OR EXISTS(SELECT 1 FROM luggage_orders p JOIN luggage_staff_corrections c ON c.order_id=(SELECT COALESCE(so.parent_order_id,so.order_id) FROM luggage_orders so WHERE so.order_id=p.order_id) WHERE p.order_id=NEW.order_id)))
BEGIN SELECT RAISE(ABORT,'Preserve correction order'); END;
DROP VIEW luggage_receipt_sales;
CREATE VIEW IF NOT EXISTS luggage_receipt_sales AS
SELECT p.order_id, p.business_date, p.tender_type, p.amount, 0 AS estimated
FROM luggage_effective_payments p
UNION ALL
SELECT o.order_id, date(o.created_at, '+9 hours'),
       CASE WHEN o.payment_method = 'PAY_QR' THEN 'PAY_QR' ELSE 'CASH' END,
       COALESCE(o.final_amount, o.prepaid_amount, 0) + COALESCE(o.extra_amount, 0), 1
FROM luggage_orders o WHERE o.status IN ('PAID', 'PICKED_UP')
  AND NOT (o.parent_order_id IS NOT NULL AND EXISTS(SELECT 1 FROM luggage_staff_corrections c WHERE c.order_id=o.parent_order_id AND json_extract(c.after_json,'$.familyAmountOnly')=1))
  AND NOT EXISTS (SELECT 1 FROM luggage_order_payments p WHERE p.order_id = o.order_id);
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
) , general_returns AS (
 SELECT order_id,SUM(amount) AS returned,SUM(method='CASH') AS cash_count,COUNT(*) AS return_count,
 SUM(CASE WHEN method='CASH' THEN amount ELSE 0 END) AS cash_amount,
 SUM(CASE WHEN method='PAY_QR' THEN amount ELSE 0 END) AS qr_amount,
 SUM(CASE WHEN method='UNKNOWN' THEN amount ELSE 0 END) AS unknown_amount
 FROM luggage_correction_returns GROUP BY order_id
), amounts AS (
  SELECT o.*, COALESCE(o.parent_order_id, o.order_id) AS root_id,
    COALESCE(o.final_amount, o.prepaid_amount, 0) + COALESCE(o.extra_amount, 0) + COALESCE(b.amount, 0) AS billed_amount,
    COALESCE(b.amount, 0) AS bag_addition_amount, COALESCE(b.count,0) AS bag_addition_count, COALESCE(b.daily_rate,0) AS bag_addition_daily_rate, COALESCE(b.discounted_amount,0) AS bag_addition_discounted_amount, COALESCE(b.pass_discount,0) AS bag_addition_pass_discount, o.price_per_day-COALESCE(b.daily_rate,0) AS bag_original_price_per_day,
    COALESCE(p.recorded_amount, 0) AS recorded_amount, COALESCE(p.payment_count, 0) AS payment_count,
    COALESCE(f.refunded, 0) AS discount_credit_amount, COALESCE(f.refunded, 0) AS cash_refunded_amount,
    COALESCE(f.pending, 0) AS pending_refund_count, COALESCE(f.refund_count, 0) AS refund_count,
    COALESCE(o.final_amount, o.prepaid_amount, 0) + COALESCE(o.extra_amount, 0) + COALESCE(b.amount, 0) - COALESCE(f.refunded, 0) AS effective_billed_amount,
    COALESCE(p.recorded_amount, 0) - COALESCE(f.refunded, 0) - COALESCE(g.returned,0) AS net_received_amount,
 (SELECT COUNT(*) FROM luggage_staff_corrections sc WHERE sc.order_id=o.order_id AND sc.applied=1) AS staff_correction_count,COALESCE(g.returned,0) AS general_returned_amount,COALESCE(g.return_count,0) AS general_return_count,COALESCE(g.cash_amount,0) AS general_cash_returned,COALESCE(g.qr_amount,0) AS general_qr_returned,COALESCE(g.unknown_amount,0) AS unallocated_returned_amount,
    (SELECT refund_id FROM luggage_flying_pass_refunds f3 WHERE f3.order_id = o.order_id AND f3.status = 'CONFIRMED' ORDER BY sequence DESC LIMIT 1) AS latest_confirmed_refund_id,
    (SELECT refund_id FROM luggage_flying_pass_refunds f4 WHERE f4.order_id = o.order_id AND f4.status = 'PAYOUT_PENDING') AS pending_refund_id,
    COALESCE((SELECT after_tier FROM luggage_flying_pass_refunds f2 WHERE f2.order_id = o.order_id AND f2.status = 'CONFIRMED' ORDER BY sequence DESC LIMIT 1), o.flying_pass_tier) AS effective_flying_pass_tier,
    p.last_receipt_at, p.invalid_receipt_dates, COALESCE(p.modern_receipt_count, 0) AS modern_receipt_count,
    COALESCE(p.invalid_receipt_amounts, 0) AS invalid_receipt_amounts,
    CASE WHEN o.status IN ('PAID', 'PICKED_UP') AND COALESCE(p.payment_count, 0) = 0 AND NOT (o.parent_order_id IS NOT NULL AND EXISTS(SELECT 1 FROM luggage_staff_corrections c WHERE c.order_id=o.parent_order_id AND json_extract(c.after_json,'$.familyAmountOnly')=1))
      THEN COALESCE(o.final_amount, o.prepaid_amount, 0) + COALESCE(o.extra_amount, 0) ELSE 0 END AS legacy_paid_estimate,
    CASE WHEN o.parent_order_id IS NOT NULL THEN COALESCE(o.extension_date,
      CASE WHEN o.expected_storage_days > 1 THEN date(o.expected_pickup_at, '+9 hours') END,
      MAX(date(o.created_at, '+9 hours'), date(r.expected_pickup_at, '+9 hours', '+1 day')))
    END AS coverage_end
  FROM luggage_orders o LEFT JOIN luggage_orders r ON r.order_id = o.parent_order_id
  LEFT JOIN bag_additions b ON b.order_id = o.order_id
  LEFT JOIN general_returns g ON g.order_id=o.order_id LEFT JOIN ledger p ON p.order_id = o.order_id LEFT JOIN refunds f ON f.order_id = o.order_id WHERE o.status != 'CANCELLED'
), evidence AS (
  SELECT m.*, m.effective_billed_amount - m.net_received_amount - m.legacy_paid_estimate AS raw_balance,
    CASE WHEN NOT EXISTS(SELECT 1 FROM luggage_staff_corrections sc WHERE sc.order_id=m.order_id AND sc.applied=1 AND json_extract(sc.after_json,'$.final_amount')=m.final_amount AND sc.sequence=(SELECT MAX(sequence) FROM luggage_staff_corrections WHERE order_id=m.order_id)) AND m.parent_order_id IS NULL AND m.status IN ('PAID', 'PICKED_UP')
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
CREATE VIEW luggage_staff_base_balances AS
WITH totals AS (
  SELECT root_id, SUM(parent_order_id IS NOT NULL) AS extension_count, SUM(billed_amount) AS billed_amount, SUM(bag_addition_amount) AS bag_addition_amount, SUM(bag_addition_count) AS bag_addition_count, SUM(bag_addition_daily_rate) AS bag_addition_daily_rate, SUM(bag_addition_discounted_amount) AS bag_addition_discounted_amount, SUM(bag_addition_pass_discount) AS bag_addition_pass_discount, MAX(CASE WHEN parent_order_id IS NULL THEN bag_original_price_per_day ELSE 0 END) AS bag_original_price_per_day,
    SUM(recorded_amount) AS recorded_amount, SUM(discount_credit_amount) AS discount_credit_amount,
    SUM(cash_refunded_amount) AS cash_refunded_amount, SUM(net_received_amount) AS net_received_amount, SUM(staff_correction_count) AS staff_correction_count,SUM(general_returned_amount) AS general_returned_amount,SUM(general_return_count) AS general_return_count,SUM(general_cash_returned) AS general_cash_returned,SUM(general_qr_returned) AS general_qr_returned,SUM(unallocated_returned_amount) AS unallocated_returned_amount,
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
      OR discount_credit_amount > COALESCE(final_amount, prepaid_amount) + bag_addition_amount OR effective_billed_amount < 0 OR (net_received_amount < 0 AND NOT EXISTS(SELECT 1 FROM luggage_staff_corrections c WHERE c.order_id=luggage_billing_lines.root_id AND json_extract(c.after_json,'$.familyAmountOnly')=1))
      OR (raw_balance < 0 AND NOT EXISTS(SELECT 1 FROM luggage_staff_corrections sc WHERE sc.order_id=luggage_billing_lines.order_id)) OR billed_amount < 0 OR billed_amount != CAST(billed_amount AS INTEGER)
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
CREATE VIEW luggage_billing_balances AS SELECT b.root_id AS root_id,
 b.extension_count AS extension_count,
 b.billed_amount+COALESCE(a.delta,0) AS billed_amount,
 b.bag_addition_amount AS bag_addition_amount,
 b.bag_addition_count AS bag_addition_count,
 b.bag_addition_daily_rate AS bag_addition_daily_rate,
 b.bag_addition_discounted_amount AS bag_addition_discounted_amount,
 b.bag_addition_pass_discount AS bag_addition_pass_discount,
 b.bag_original_price_per_day AS bag_original_price_per_day,
 b.recorded_amount AS recorded_amount,
 b.discount_credit_amount AS discount_credit_amount,
 b.cash_refunded_amount AS cash_refunded_amount,
 b.net_received_amount AS net_received_amount,
 b.staff_correction_count AS staff_correction_count,
 b.general_returned_amount AS general_returned_amount,
 b.general_return_count AS general_return_count,
 b.general_cash_returned AS general_cash_returned,
 b.general_qr_returned AS general_qr_returned,
 b.unallocated_returned_amount AS unallocated_returned_amount,
 b.effective_billed_amount+COALESCE(a.delta,0) AS effective_billed_amount,
 b.pending_refund_count AS pending_refund_count,
 b.refund_count AS refund_count,
 b.latest_confirmed_refund_id AS latest_confirmed_refund_id,
 b.pending_refund_id AS pending_refund_id,
 b.effective_flying_pass_tier AS effective_flying_pass_tier,
 b.legacy_paid_estimate AS legacy_paid_estimate,
 CASE WHEN COALESCE(a.active,0)>0 THEN MAX(0,b.net_received_amount-(b.total_effective_billed_amount+COALESCE(a.delta,0))) ELSE b.overpaid_amount END AS overpaid_amount,
 CASE WHEN COALESCE(a.active,0)>0 THEN MAX(0,(b.total_effective_billed_amount+COALESCE(a.delta,0))-b.net_received_amount-b.legacy_paid_estimate) ELSE b.line_outstanding END AS line_outstanding,
 b.extension_line_outstanding AS extension_line_outstanding,
 b.root_review_required AS root_review_required,
 b.root_review_amount AS root_review_amount,
 b.root_review_difference AS root_review_difference,
 b.root_review_reason AS root_review_reason,
 b.reprice_audit_log_id AS reprice_audit_log_id,
 b.review_pickup_blocked AS review_pickup_blocked,
 CASE WHEN (b.total_effective_billed_amount+COALESCE(a.delta,0))<0 OR (b.total_effective_billed_amount+COALESCE(a.delta,0))>500000 OR b.net_received_amount<0 THEN 1 ELSE b.invalid_amount END AS invalid_amount,
 b.refund_settlement_version AS refund_settlement_version,
 b.total_effective_billed_amount+COALESCE(a.delta,0) AS total_effective_billed_amount,
 b.unbilled_amount AS unbilled_amount,
 b.unbilled_days AS unbilled_days,
 b.total_billed_amount+COALESCE(a.delta,0) AS total_billed_amount,
 CASE WHEN COALESCE(a.active,0)>0 THEN MIN(MAX(0,(b.total_effective_billed_amount+COALESCE(a.delta,0))-b.net_received_amount-b.legacy_paid_estimate),b.extension_outstanding_amount) ELSE b.extension_outstanding_amount END AS extension_outstanding_amount,
 CASE WHEN COALESCE(a.active,0)>0 THEN MAX(0,(b.total_effective_billed_amount+COALESCE(a.delta,0))-b.net_received_amount-b.legacy_paid_estimate) ELSE b.outstanding_amount END AS outstanding_amount,COALESCE(a.delta,0) AS family_claim_adjustment,COALESCE(a.active,0) AS family_correction_count
FROM luggage_staff_base_balances b LEFT JOIN (SELECT order_id,SUM(family_delta) AS delta,SUM(json_extract(after_json,'$.familyAmountOnly')=1) AS active FROM luggage_staff_corrections GROUP BY order_id) a ON a.order_id=b.root_id;
DROP VIEW luggage_sales_daily;
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
), general_returns AS (
 SELECT business_date,SUM(amount) AS returned,COUNT(*) AS return_count,
 SUM(CASE WHEN method='CASH' THEN amount ELSE 0 END) AS cash_amount,
 SUM(CASE WHEN method='PAY_QR' THEN amount ELSE 0 END) AS qr_amount,
 SUM(CASE WHEN method='UNKNOWN' THEN amount ELSE 0 END) AS unknown_amount
 FROM luggage_correction_returns GROUP BY business_date
), orders AS (
  SELECT date(created_at, '+9 hours') AS business_date, COUNT(*) AS order_count,
    SUM(status IN ('PAID', 'PICKED_UP')) AS paid_count, SUM(status = 'PAYMENT_PENDING') AS pending_count,
    SUM(CASE WHEN status IN ('PAID', 'PICKED_UP') THEN 1 + companion_count ELSE 0 END) AS people,
    SUM(CASE WHEN status IN ('PAID', 'PICKED_UP') THEN suitcase_qty-COALESCE((SELECT SUM(suitcase_added) FROM luggage_bag_additions b WHERE b.order_id=luggage_orders.order_id),0) ELSE 0 END) AS suitcase_total,
    SUM(CASE WHEN status IN ('PAID', 'PICKED_UP') THEN backpack_qty-COALESCE((SELECT SUM(backpack_added) FROM luggage_bag_additions b WHERE b.order_id=luggage_orders.order_id),0) ELSE 0 END) AS backpack_total
  FROM luggage_orders WHERE parent_order_id IS NULL AND status != 'CANCELLED' GROUP BY business_date
), added_bags AS (SELECT business_date,SUM(suitcase_added) AS suitcase_total,SUM(backpack_added) AS backpack_total FROM luggage_bag_additions GROUP BY business_date), dates AS (SELECT business_date FROM added_bags UNION SELECT business_date FROM receipts UNION SELECT business_date FROM orders UNION SELECT business_date FROM refunds UNION SELECT business_date FROM general_returns)
SELECT d.business_date, (SELECT COUNT(*) FROM luggage_staff_corrections sc WHERE sc.return_business_date=d.business_date OR EXISTS(SELECT 1 FROM luggage_order_payments sp JOIN luggage_orders so ON so.order_id=sp.order_id WHERE COALESCE(so.parent_order_id,so.order_id)=sc.order_id AND sp.business_date=d.business_date)) AS staff_correction_count, COALESCE(r.cash, 0) - COALESCE(f.amount, 0) - COALESCE(g.cash_amount,0) AS cash, COALESCE(r.qr, 0) - COALESCE(g.qr_amount,0) AS qr,
  COALESCE(r.total_amount, 0) - COALESCE(f.amount, 0) - COALESCE(g.returned,0) AS total_amount,
  COALESCE(r.cash, 0) AS gross_cash, COALESCE(r.qr, 0) AS gross_qr, COALESCE(f.amount, 0)+COALESCE(g.cash_amount,0) AS cash_refund_amount,COALESCE(g.qr_amount,0) AS qr_refund_amount,COALESCE(g.unknown_amount,0) AS unallocated_refund_amount,COALESCE(g.returned,0) AS general_returned_amount, COALESCE(f.refund_count, 0)+COALESCE(g.return_count,0) AS refund_count, COALESCE(o.order_count, 0) AS order_count,
  COALESCE(r.legacy_estimated_amount, 0) AS legacy_estimated_amount, COALESCE(r.recorded_amount, 0) AS recorded_amount,
  COALESCE(o.paid_count, 0) AS paid_count, COALESCE(o.pending_count, 0) AS pending_count,
  COALESCE(o.people, 0) AS people, COALESCE(o.suitcase_total, 0)+COALESCE(a.suitcase_total,0) AS suitcase_total,
  COALESCE(o.backpack_total, 0)+COALESCE(a.backpack_total,0) AS backpack_total
FROM dates d LEFT JOIN general_returns g ON g.business_date=d.business_date LEFT JOIN added_bags a ON a.business_date=d.business_date LEFT JOIN receipts r ON r.business_date = d.business_date LEFT JOIN orders o ON o.business_date = d.business_date LEFT JOIN refunds f ON f.business_date = d.business_date;
CREATE TABLE luggage_general_closing_snapshots (
 closing_id INTEGER NOT NULL PRIMARY KEY REFERENCES luggage_cash_closings(closing_id),
 snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)),
 audit_id INTEGER NOT NULL UNIQUE REFERENCES luggage_cash_closing_audits(audit_id)
);
DROP TRIGGER luggage_refund_closing_snapshot;
CREATE TRIGGER IF NOT EXISTS luggage_refund_closing_snapshot AFTER INSERT ON luggage_cash_closings
WHEN NEW.closing_type = 'FINAL_CLOSE' AND NOT EXISTS(SELECT 1 FROM luggage_correction_returns WHERE business_date=NEW.business_date) AND EXISTS (SELECT 1 FROM luggage_sales_daily WHERE business_date = NEW.business_date AND refund_count > 0)
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
DROP TRIGGER luggage_refund_closing_update_guard;
CREATE TRIGGER IF NOT EXISTS luggage_refund_closing_update_guard BEFORE UPDATE ON luggage_cash_closings
BEGIN
  SELECT CASE WHEN NEW.closing_type = 'FINAL_CLOSE' AND EXISTS (SELECT 1 FROM luggage_flying_pass_refunds WHERE business_date = NEW.business_date AND status = 'PAYOUT_PENDING')
    THEN RAISE(ABORT, 'REFUND_PAYOUT_PENDING') END;
  SELECT CASE WHEN NEW.closing_type = 'FINAL_CLOSE' AND EXISTS (SELECT 1 FROM luggage_flying_pass_refunds WHERE status = 'CONFIRMED' AND date(paid_at, '+9 hours') = NEW.business_date)
    AND NOT EXISTS (SELECT 1 FROM luggage_cash_closing_refund_snapshots WHERE closing_id = OLD.closing_id) AND NOT EXISTS(SELECT 1 FROM luggage_general_closing_snapshots WHERE closing_id=OLD.closing_id)
    THEN RAISE(ABORT, 'REFUND_PRESERVE_CLOSING_SNAPSHOT') END;
  SELECT CASE WHEN EXISTS (SELECT 1 FROM luggage_cash_closing_refund_snapshots s WHERE s.closing_id = OLD.closing_id
    AND (NEW.closing_id IS NOT OLD.closing_id OR NEW.business_date IS NOT s.business_date OR NEW.closing_type != 'FINAL_CLOSE'
      OR NEW.expected_amount IS NOT s.net_total OR NEW.check_auto_amount IS NOT s.net_total
      OR NEW.qr_difference_amount IS NOT ((CASE WHEN NEW.qr_gross_amount IS NOT NULL THEN NEW.actual_qr_amount WHEN NEW.actual_qr_amount != 0 THEN NEW.actual_qr_amount ELSE NEW.paypay_amount END) - s.gross_qr)))
    THEN RAISE(ABORT, 'REFUND_PRESERVE_CLOSING_SNAPSHOT') END;
END;
CREATE TRIGGER staff_correction_closing_snapshot AFTER INSERT ON luggage_cash_closings
WHEN NEW.closing_type='FINAL_CLOSE' AND EXISTS(SELECT 1 FROM luggage_correction_returns WHERE business_date=NEW.business_date)
BEGIN
 INSERT INTO luggage_cash_closing_audits(closing_id,action,payload,staff_id)
 SELECT NEW.closing_id,'GENERAL_RETURN_SNAPSHOT',json_object('businessDate',business_date,'grossCash',gross_cash,'grossQr',gross_qr,
 'cashReturned',cash_refund_amount,'qrReturned',qr_refund_amount,'unallocatedReturned',unallocated_refund_amount,
 'generalReturned',general_returned_amount,'returnCount',refund_count,'netCash',cash,'netQr',qr,'netTotal',total_amount,
 'generalReturns',json((SELECT json_group_array(json_object('id',correction_id,'amount',amount,'method',method)) FROM luggage_correction_returns WHERE business_date=NEW.business_date))),NEW.staff_id
 FROM luggage_sales_daily WHERE business_date=NEW.business_date;
 INSERT INTO luggage_general_closing_snapshots(closing_id,snapshot_json,audit_id)
 SELECT NEW.closing_id,payload,audit_id FROM luggage_cash_closing_audits WHERE closing_id=NEW.closing_id AND action='GENERAL_RETURN_SNAPSHOT';
 SELECT CASE WHEN changes()!=1 THEN RAISE(ABORT,'CORRECTION_CLOSING_SNAPSHOT_FAILED') END;
END;
CREATE TRIGGER staff_correction_closing_snapshot_guard BEFORE INSERT ON luggage_general_closing_snapshots BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM luggage_general_closing_snapshots WHERE closing_id=NEW.closing_id)
 OR NOT EXISTS(SELECT 1 FROM luggage_cash_closing_audits a JOIN luggage_cash_closings c ON c.closing_id=a.closing_id
 WHERE a.audit_id=NEW.audit_id AND a.closing_id=NEW.closing_id AND a.action='GENERAL_RETURN_SNAPSHOT'
 AND a.payload=NEW.snapshot_json AND a.staff_id IS c.staff_id AND c.closing_type='FINAL_CLOSE'
 AND c.expected_amount=json_extract(NEW.snapshot_json,'$.netTotal') AND c.check_auto_amount=c.expected_amount
)
 THEN RAISE(ABORT,'CORRECTION_CLOSING_SNAPSHOT_FAILED') END;
END;
CREATE TRIGGER staff_correction_closing_snapshot_no_update BEFORE UPDATE ON luggage_general_closing_snapshots BEGIN SELECT RAISE(ABORT,'Preserve correction closing snapshot'); END;
CREATE TRIGGER staff_correction_closing_snapshot_no_delete BEFORE DELETE ON luggage_general_closing_snapshots BEGIN SELECT RAISE(ABORT,'Preserve correction closing snapshot'); END;
CREATE TRIGGER staff_correction_closing_preserve BEFORE UPDATE ON luggage_cash_closings
WHEN EXISTS(SELECT 1 FROM luggage_general_closing_snapshots s WHERE s.closing_id=OLD.closing_id
 AND (NEW.closing_id IS NOT OLD.closing_id OR NEW.business_date IS NOT OLD.business_date OR NEW.closing_type IS NOT OLD.closing_type
 OR NEW.expected_amount IS NOT json_extract(s.snapshot_json,'$.netTotal') OR NEW.check_auto_amount IS NOT NEW.expected_amount
 OR NEW.qr_difference_amount IS NOT (NEW.actual_qr_amount-json_extract(s.snapshot_json,'$.netQr'))))
BEGIN SELECT RAISE(ABORT,'Preserve correction closing snapshot'); END;
CREATE TRIGGER staff_correction_closing_pk_ingress BEFORE UPDATE ON luggage_cash_closings WHEN NEW.closing_id IS NOT OLD.closing_id AND EXISTS(SELECT 1 FROM luggage_general_closing_snapshots WHERE closing_id=NEW.closing_id) BEGIN SELECT RAISE(ABORT,'Preserve correction closing snapshot'); END;
CREATE TRIGGER staff_correction_closing_delete BEFORE DELETE ON luggage_cash_closings
WHEN EXISTS(SELECT 1 FROM luggage_general_closing_snapshots WHERE closing_id=OLD.closing_id)
BEGIN SELECT RAISE(ABORT,'Preserve correction closing snapshot'); END;
CREATE TRIGGER staff_correction_closing_replace BEFORE INSERT ON luggage_cash_closings
WHEN EXISTS(SELECT 1 FROM luggage_general_closing_snapshots WHERE closing_id=NEW.closing_id)
BEGIN SELECT RAISE(ABORT,'Preserve correction closing snapshot'); END;
CREATE TRIGGER staff_correction_closing_audit_update BEFORE UPDATE ON luggage_cash_closing_audits WHEN EXISTS(SELECT 1 FROM luggage_general_closing_snapshots WHERE audit_id=OLD.audit_id) OR EXISTS(SELECT 1 FROM luggage_general_closing_snapshots WHERE audit_id=NEW.audit_id) BEGIN SELECT RAISE(ABORT,'Preserve correction closing audit'); END;
CREATE TRIGGER staff_correction_closing_audit_delete BEFORE DELETE ON luggage_cash_closing_audits WHEN EXISTS(SELECT 1 FROM luggage_general_closing_snapshots WHERE audit_id=OLD.audit_id) BEGIN SELECT RAISE(ABORT,'Preserve correction closing audit'); END;
CREATE TRIGGER staff_correction_closing_audit_insert BEFORE INSERT ON luggage_cash_closing_audits WHEN EXISTS(SELECT 1 FROM luggage_general_closing_snapshots WHERE audit_id=NEW.audit_id) BEGIN SELECT RAISE(ABORT,'Preserve correction closing audit'); END;

DROP TRIGGER luggage_bag_addition_insert_guard;
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
        AND b.net_received_amount=b.total_effective_billed_amount
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

DROP TRIGGER luggage_pickup_balance_guard;
CREATE TRIGGER IF NOT EXISTS luggage_pickup_balance_guard BEFORE UPDATE OF status ON luggage_orders
WHEN NEW.status = 'PICKED_UP' AND OLD.status != 'PICKED_UP'
BEGIN
  SELECT CASE WHEN OLD.parent_order_id IS NOT NULL
    AND EXISTS (SELECT 1 FROM luggage_orders r WHERE r.order_id = OLD.parent_order_id AND r.status != 'PICKED_UP')
    THEN RAISE(ABORT, 'Pick up the root order') END;
  SELECT CASE WHEN EXISTS (SELECT 1 FROM luggage_billing_balances b
    WHERE b.root_id = COALESCE(OLD.parent_order_id, OLD.order_id)
      AND (b.pending_refund_count > 0 OR b.overpaid_amount > 0 OR b.outstanding_amount > 0 OR b.invalid_amount != 0 OR b.review_pickup_blocked != 0))
    THEN RAISE(ABORT, 'Outstanding collection prevents pickup') END;
END;

CREATE TRIGGER staff_correction_order_status BEFORE UPDATE OF status ON luggage_orders
WHEN OLD.status IN ('PAID','PICKED_UP') AND NEW.status NOT IN ('PAID','PICKED_UP') AND EXISTS(SELECT 1 FROM luggage_staff_corrections WHERE order_id=OLD.order_id AND applied=1)
BEGIN SELECT RAISE(ABORT,'Preserve corrected paid status'); END;
CREATE TRIGGER staff_correction_quantity BEFORE UPDATE OF suitcase_qty,backpack_qty,set_qty,price_per_day ON luggage_orders
WHEN (NEW.suitcase_qty IS NOT OLD.suitcase_qty OR NEW.backpack_qty IS NOT OLD.backpack_qty OR NEW.set_qty IS NOT OLD.set_qty OR NEW.price_per_day IS NOT OLD.price_per_day)
 AND EXISTS(SELECT 1 FROM luggage_staff_corrections WHERE order_id=OLD.order_id AND applied=1)
 AND NOT EXISTS(SELECT 1 FROM luggage_staff_corrections c WHERE c.order_id=OLD.order_id AND c.applied=0 AND OLD.status IS json_extract(c.before_json,'$.status') AND OLD.parent_order_id IS json_extract(c.before_json,'$.parent_order_id') AND OLD.created_at IS json_extract(c.before_json,'$.created_at') AND OLD.expected_pickup_at IS json_extract(c.before_json,'$.expected_pickup_at') AND OLD.expected_storage_days IS json_extract(c.before_json,'$.expected_storage_days') AND OLD.suitcase_qty IS json_extract(c.before_json,'$.suitcase_qty') AND OLD.backpack_qty IS json_extract(c.before_json,'$.backpack_qty') AND OLD.set_qty IS json_extract(c.before_json,'$.set_qty') AND OLD.price_per_day IS json_extract(c.before_json,'$.price_per_day') AND OLD.prepaid_amount IS json_extract(c.before_json,'$.prepaid_amount') AND OLD.final_amount IS json_extract(c.before_json,'$.final_amount') AND OLD.extra_amount IS json_extract(c.before_json,'$.extra_amount') AND OLD.flying_pass_tier IS json_extract(c.before_json,'$.flying_pass_tier') AND OLD.flying_pass_discount_amount IS json_extract(c.before_json,'$.flying_pass_discount_amount') AND OLD.staff_prepaid_override_amount IS json_extract(c.before_json,'$.staff_prepaid_override_amount') AND OLD.payment_method IS json_extract(c.before_json,'$.payment_method') AND OLD.updated_at IS json_extract(c.before_json,'$.updated_at') AND NEW.suitcase_qty IS json_extract(c.after_json,'$.suitcase_qty') AND NEW.backpack_qty IS json_extract(c.after_json,'$.backpack_qty') AND NEW.set_qty IS json_extract(c.after_json,'$.set_qty') AND NEW.price_per_day IS json_extract(c.after_json,'$.price_per_day') AND NEW.prepaid_amount IS json_extract(c.after_json,'$.prepaid_amount') AND NEW.final_amount IS json_extract(c.after_json,'$.final_amount') AND NEW.staff_prepaid_override_amount IS json_extract(c.after_json,'$.staff_prepaid_override_amount') AND NEW.payment_method IS json_extract(c.after_json,'$.payment_method') AND NEW.updated_at IS json_extract(c.after_json,'$.updated_at'))
 AND NOT EXISTS(SELECT 1 FROM luggage_bag_additions b WHERE b.order_id=OLD.order_id AND b.before_updated_at=OLD.updated_at AND b.revision=NEW.updated_at
 AND b.before_suitcase=OLD.suitcase_qty AND b.before_backpack=OLD.backpack_qty AND b.before_price_per_day=OLD.price_per_day
 AND b.after_suitcase=NEW.suitcase_qty AND b.after_backpack=NEW.backpack_qty AND b.after_set_qty=NEW.set_qty AND b.after_price_per_day=NEW.price_per_day)
BEGIN SELECT RAISE(ABORT,'Use audited staff correction for quantities'); END;

DROP TRIGGER luggage_refund_closing_insert_guard;
CREATE TRIGGER IF NOT EXISTS luggage_refund_closing_insert_guard BEFORE INSERT ON luggage_cash_closings
WHEN NEW.closing_type = 'FINAL_CLOSE'
BEGIN
  SELECT CASE WHEN EXISTS (SELECT 1 FROM luggage_flying_pass_refunds WHERE business_date = NEW.business_date AND status = 'PAYOUT_PENDING')
    THEN RAISE(ABORT, 'REFUND_PAYOUT_PENDING') END;
  SELECT CASE WHEN EXISTS (SELECT 1 FROM luggage_sales_daily WHERE business_date = NEW.business_date AND refund_count > 0
    AND (NEW.expected_amount IS NOT total_amount OR NEW.check_auto_amount IS NOT total_amount
      OR NEW.qr_difference_amount IS NOT ((CASE WHEN NEW.qr_gross_amount IS NOT NULL THEN NEW.actual_qr_amount WHEN NEW.actual_qr_amount != 0 THEN NEW.actual_qr_amount ELSE NEW.paypay_amount END) - qr)))
    THEN RAISE(ABORT, 'REFUND_CLOSING_STALE') END;
END;

DROP TRIGGER luggage_receipt_insert_guard;
CREATE TRIGGER IF NOT EXISTS luggage_receipt_insert_guard BEFORE INSERT ON luggage_order_payments
WHEN NEW.receipt_request_id IS NOT NULL
BEGIN
  SELECT CASE WHEN NEW.amount <= 0 OR NEW.amount != CAST(NEW.amount AS INTEGER) OR NEW.amount > 500000
    OR NEW.staff_id IS NULL OR NEW.business_date != date(NEW.recorded_at, '+9 hours')
    OR NOT EXISTS (SELECT 1 FROM luggage_audit_logs a WHERE a.device_id = NEW.receipt_request_id
      AND a.action = 'CONFIRM_COLLECTION' AND a.staff_id = NEW.staff_id)
    OR NOT EXISTS (SELECT 1 FROM luggage_billing_lines l JOIN luggage_orders r ON r.order_id = l.root_id
      WHERE l.order_id = NEW.order_id AND r.status IN ('PAID', 'PAYMENT_PENDING')
        AND (l.collectible_amount >= NEW.amount OR (l.parent_order_id IS NULL AND EXISTS(SELECT 1 FROM luggage_billing_balances b WHERE b.root_id=l.root_id AND b.family_correction_count>0 AND b.outstanding_amount>=NEW.amount AND b.invalid_amount=0))))
    THEN RAISE(ABORT, 'Invalid or excess collection') END;
END;

DROP TRIGGER luggage_extension_paid_guard;
CREATE TRIGGER IF NOT EXISTS luggage_extension_paid_guard BEFORE UPDATE OF status ON luggage_orders
WHEN NEW.status = 'PAID' AND OLD.status = 'PAYMENT_PENDING'
  AND (OLD.parent_order_id IS NOT NULL OR EXISTS (SELECT 1 FROM luggage_orders e WHERE e.parent_order_id = OLD.order_id))
  AND COALESCE(NEW.final_amount, NEW.prepaid_amount, 0) + COALESCE(NEW.extra_amount, 0)
    > COALESCE((SELECT SUM(p.amount) FROM luggage_order_payments p WHERE p.order_id = OLD.order_id), 0)
 AND NOT EXISTS(SELECT 1 FROM luggage_billing_balances b WHERE b.root_id=OLD.parent_order_id AND b.family_correction_count>0 AND b.outstanding_amount=0 AND b.invalid_amount=0
 AND (EXISTS(SELECT 1 FROM luggage_staff_corrections c WHERE c.order_id=b.root_id AND c.applied=1 AND json_extract(c.after_json,'$.updated_at')=NEW.updated_at)
 OR EXISTS(SELECT 1 FROM luggage_audit_logs a WHERE a.order_id=b.root_id AND a.action='CONFIRM_COLLECTION' AND a.timestamp=NEW.updated_at)))
BEGIN SELECT RAISE(ABORT, 'Actual collection is required'); END;
CREATE TRIGGER staff_correction_family_link BEFORE UPDATE OF parent_order_id ON luggage_orders
WHEN NEW.parent_order_id IS NOT OLD.parent_order_id AND EXISTS(SELECT 1 FROM luggage_staff_corrections c WHERE c.order_id IN (OLD.order_id,OLD.parent_order_id,NEW.parent_order_id))
BEGIN SELECT RAISE(ABORT,'Preserve correction family identity'); END;
CREATE TRIGGER staff_correction_qr_basis_insert BEFORE INSERT ON luggage_cash_closings WHEN NEW.qr_gross_amount IS NOT NULL BEGIN
 SELECT CASE WHEN typeof(NEW.qr_gross_amount)!='integer' OR NEW.qr_gross_amount<0 OR NEW.qr_gross_amount>100000000
 OR typeof(NEW.qr_return_amount)!='integer' OR NEW.qr_return_amount<0
 OR NEW.actual_qr_amount IS NOT NEW.qr_gross_amount-NEW.qr_return_amount
 OR NEW.actual_amount IS NOT NEW.total_amount-40000+NEW.actual_qr_amount OR NEW.qr_return_amount IS NOT COALESCE((SELECT qr_refund_amount FROM luggage_sales_daily WHERE business_date=NEW.business_date),0)
 THEN RAISE(ABORT,'CLOSING_QR_BASIS_STALE') END;
END;
CREATE TRIGGER staff_correction_qr_basis_update BEFORE UPDATE ON luggage_cash_closings WHEN NEW.qr_gross_amount IS NOT NULL OR OLD.qr_gross_amount IS NOT NULL BEGIN
 SELECT CASE WHEN NEW.qr_gross_amount IS NULL OR typeof(NEW.qr_gross_amount)!='integer' OR NEW.qr_gross_amount<0 OR NEW.qr_gross_amount>100000000
 OR typeof(NEW.qr_return_amount)!='integer' OR NEW.qr_return_amount<0
 OR NEW.actual_qr_amount IS NOT NEW.qr_gross_amount-NEW.qr_return_amount
 OR NEW.actual_amount IS NOT NEW.total_amount-40000+NEW.actual_qr_amount OR NEW.qr_return_amount IS NOT OLD.qr_return_amount
 THEN RAISE(ABORT,'Preserve QR closing basis') END;
END;
CREATE TRIGGER staff_correction_refund_remaining BEFORE INSERT ON luggage_flying_pass_refunds
WHEN NEW.status='PAYOUT_PENDING' AND EXISTS(SELECT 1 FROM luggage_staff_corrections WHERE order_id=NEW.order_id)
BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM luggage_billing_balances b WHERE b.root_id=NEW.order_id AND (NEW.amount>b.total_effective_billed_amount OR NEW.amount>b.net_received_amount))
 THEN RAISE(ABORT,'Refund exceeds corrected remaining amount') END;
END;

-- Staff-confirmed historical receipts and already-paid discount facts; no payment execution.
-- Apply only after 20261101_staff_order_corrections.sql. Existing candidate is preserved unchanged.
ALTER TABLE luggage_staff_corrections ADD COLUMN historical_receipts_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(historical_receipts_json) AND json_type(historical_receipts_json)='array');
ALTER TABLE luggage_staff_corrections ADD COLUMN return_context_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(return_context_json) AND json_type(return_context_json)='object');
CREATE UNIQUE INDEX idx_historical_correction_receipt ON luggage_order_payments(receipt_request_id) WHERE receipt_request_id GLOB 'historical:*';
DROP VIEW luggage_staff_correction_scopes;
CREATE VIEW luggage_staff_correction_scopes AS SELECT r.order_id AS root_id,json_object('orders',json((SELECT json_group_array(json_object('order_id',order_id,'parent_order_id',parent_order_id,'status',status,'created_at',created_at,'updated_at',updated_at,'expected_pickup_at',expected_pickup_at,'expected_storage_days',expected_storage_days,'suitcase_qty',suitcase_qty,'backpack_qty',backpack_qty,'set_qty',set_qty,'price_per_day',price_per_day,'prepaid_amount',prepaid_amount,'final_amount',final_amount,'extra_amount',extra_amount,'flying_pass_tier',flying_pass_tier,'flying_pass_discount_amount',flying_pass_discount_amount,'staff_prepaid_override_amount',staff_prepaid_override_amount,'payment_method',payment_method,'tag_no',tag_no,'actual_pickup_at',actual_pickup_at)) FROM (SELECT order_id,parent_order_id,status,created_at,updated_at,expected_pickup_at,expected_storage_days,suitcase_qty,backpack_qty,set_qty,price_per_day,prepaid_amount,final_amount,extra_amount,flying_pass_tier,flying_pass_discount_amount,staff_prepaid_override_amount,payment_method,tag_no,actual_pickup_at FROM luggage_orders WHERE order_id=r.order_id OR parent_order_id=r.order_id ORDER BY order_id))),'payments',json((SELECT json_group_array(json_object('payment_id',payment_id,'order_id',order_id,'business_date',business_date,'tender_type',tender_type,'amount',amount,'recorded_at',recorded_at,'receipt_request_id',receipt_request_id)) FROM (SELECT payment_id,order_id,business_date,tender_type,amount,recorded_at,receipt_request_id FROM luggage_order_payments WHERE order_id IN (SELECT order_id FROM luggage_orders WHERE order_id=r.order_id OR parent_order_id=r.order_id) ORDER BY payment_id))),'additions',json((SELECT json_group_array(json_object('addition_id',addition_id,'order_id',order_id,'amount',amount,'revision',revision)) FROM (SELECT addition_id,order_id,amount,revision FROM luggage_bag_additions WHERE order_id IN (SELECT order_id FROM luggage_orders WHERE order_id=r.order_id OR parent_order_id=r.order_id) ORDER BY addition_id))),'refunds',json((SELECT json_group_array(json_object('refund_id',refund_id,'order_id',order_id,'status',status,'amount',amount)) FROM (SELECT refund_id,order_id,status,amount FROM luggage_flying_pass_refunds WHERE order_id IN (SELECT order_id FROM luggage_orders WHERE order_id=r.order_id OR parent_order_id=r.order_id) ORDER BY refund_id))),'corrections',json((SELECT json_group_array(json_object('correction_id',correction_id,'order_id',order_id,'sequence',sequence,'applied',applied)) FROM (SELECT correction_id,order_id,sequence,applied FROM luggage_staff_corrections WHERE order_id IN (SELECT order_id FROM luggage_orders WHERE order_id=r.order_id OR parent_order_id=r.order_id) ORDER BY sequence)))) AS snapshot_json FROM luggage_orders r WHERE r.parent_order_id IS NULL;
DROP VIEW luggage_correction_returns;
CREATE VIEW luggage_correction_returns AS
SELECT c.correction_id,c.order_id,c.returned_amount AS amount,c.return_business_date AS business_date,c.return_occurred_at AS occurred_at,
 COALESCE((SELECT json_extract(a.value,'$.method') FROM luggage_staff_corrections r,json_each(r.return_allocations_json) a
 WHERE r.order_id=c.order_id AND json_extract(a.value,'$.correctionId')=c.correction_id ORDER BY r.sequence DESC LIMIT 1),c.return_method) AS method,
 COALESCE(json_extract(c.return_context_json,'$.kind'),'GENERAL') AS kind,json_extract(c.return_context_json,'$.discountTier') AS discount_tier,json_extract(c.return_context_json,'$.timeNote') AS time_note,c.staff_id,c.recorded_at
FROM luggage_staff_corrections c WHERE c.returned_amount>0;
DROP TRIGGER staff_correction_insert_guard;
CREATE TRIGGER staff_correction_insert_guard BEFORE INSERT ON luggage_staff_corrections BEGIN

 SELECT CASE WHEN NEW.applied!=0 OR EXISTS(SELECT 1 FROM luggage_staff_corrections WHERE correction_id=NEW.correction_id OR rowid=NEW.rowid)
 OR NEW.sequence!=COALESCE((SELECT MAX(sequence) FROM luggage_staff_corrections WHERE order_id=NEW.order_id),0)+1
 OR NOT EXISTS(SELECT 1 FROM luggage_orders o WHERE o.order_id=NEW.order_id AND o.parent_order_id IS NULL
 AND o.status IN ('PAID','PICKED_UP') AND o.status IS json_extract(NEW.before_json,'$.status') AND o.parent_order_id IS json_extract(NEW.before_json,'$.parent_order_id') AND o.created_at IS json_extract(NEW.before_json,'$.created_at') AND o.expected_pickup_at IS json_extract(NEW.before_json,'$.expected_pickup_at') AND o.expected_storage_days IS json_extract(NEW.before_json,'$.expected_storage_days') AND o.suitcase_qty IS json_extract(NEW.before_json,'$.suitcase_qty') AND o.backpack_qty IS json_extract(NEW.before_json,'$.backpack_qty') AND o.set_qty IS json_extract(NEW.before_json,'$.set_qty') AND o.price_per_day IS json_extract(NEW.before_json,'$.price_per_day') AND o.prepaid_amount IS json_extract(NEW.before_json,'$.prepaid_amount') AND o.final_amount IS json_extract(NEW.before_json,'$.final_amount') AND o.extra_amount IS json_extract(NEW.before_json,'$.extra_amount') AND o.flying_pass_tier IS json_extract(NEW.before_json,'$.flying_pass_tier') AND o.flying_pass_discount_amount IS json_extract(NEW.before_json,'$.flying_pass_discount_amount') AND o.staff_prepaid_override_amount IS json_extract(NEW.before_json,'$.staff_prepaid_override_amount') AND o.payment_method IS json_extract(NEW.before_json,'$.payment_method') AND o.updated_at IS json_extract(NEW.before_json,'$.updated_at'))
 THEN RAISE(ABORT,'CORRECTION_STALE') END;
 SELECT CASE WHEN (EXISTS(SELECT 1 FROM luggage_orders WHERE parent_order_id=NEW.order_id)
 OR EXISTS(SELECT 1 FROM luggage_bag_additions WHERE order_id=NEW.order_id)
 OR EXISTS(SELECT 1 FROM luggage_flying_pass_refunds WHERE order_id=NEW.order_id)
 OR EXISTS(SELECT 1 FROM luggage_staff_corrections WHERE order_id=NEW.order_id AND json_extract(after_json,'$.familyAmountOnly')=1)) IS NOT COALESCE(json_extract(NEW.after_json,'$.familyAmountOnly'),0)
 OR (json_extract(NEW.after_json,'$.familyAmountOnly')=1 AND (json_extract(NEW.after_json,'$.prepaid_amount') IS NOT json_extract(NEW.before_json,'$.prepaid_amount') OR json_extract(NEW.after_json,'$.final_amount') IS NOT json_extract(NEW.before_json,'$.final_amount') OR json_extract(NEW.after_json,'$.suitcase_qty') IS NOT json_extract(NEW.before_json,'$.suitcase_qty') OR json_extract(NEW.after_json,'$.backpack_qty') IS NOT json_extract(NEW.before_json,'$.backpack_qty') OR json_extract(NEW.after_json,'$.set_qty') IS NOT json_extract(NEW.before_json,'$.set_qty') OR json_extract(NEW.after_json,'$.price_per_day') IS NOT json_extract(NEW.before_json,'$.price_per_day') OR json_extract(NEW.after_json,'$.staff_prepaid_override_amount') IS NOT json_extract(NEW.before_json,'$.staff_prepaid_override_amount')))
 OR NEW.before_billed_amount IS NOT json_extract(NEW.before_json,'$.billing_total') OR NEW.after_billed_amount IS NOT json_extract(NEW.after_json,'$.billing_total')
 OR (SELECT COUNT(DISTINCT json_extract(value,'$.payment_id')) FROM json_each(NEW.receipts_json))!=json_array_length(NEW.receipts_json)
 THEN RAISE(ABORT,'CORRECTION_SCOPE_INVALID') END;

 SELECT CASE WHEN NEW.scope_json IS NOT (SELECT snapshot_json FROM luggage_staff_correction_scopes WHERE root_id=NEW.order_id)
 OR NEW.before_billed_amount IS NOT (SELECT total_effective_billed_amount FROM luggage_billing_balances WHERE root_id=NEW.order_id)
 OR NOT EXISTS(SELECT 1 FROM luggage_order_payments p JOIN luggage_orders o ON o.order_id=p.order_id WHERE COALESCE(o.parent_order_id,o.order_id)=NEW.order_id)
 OR (SELECT COUNT(*) FROM luggage_order_payments p JOIN luggage_orders o ON o.order_id=p.order_id WHERE COALESCE(o.parent_order_id,o.order_id)=NEW.order_id)!=json_array_length(NEW.receipts_json)
 OR EXISTS(SELECT 1 FROM json_each(NEW.receipts_json) s LEFT JOIN luggage_order_payments p ON p.payment_id=json_extract(s.value,'$.payment_id') LEFT JOIN luggage_orders o ON o.order_id=p.order_id
 WHERE COALESCE(o.parent_order_id,o.order_id) IS NOT NEW.order_id OR p.amount IS NOT json_extract(s.value,'$.amount') OR p.tender_type IS NOT json_extract(s.value,'$.tender_type')
 OR p.business_date IS NOT json_extract(s.value,'$.business_date') OR p.recorded_at IS NOT json_extract(s.value,'$.recorded_at') OR p.receipt_request_id IS NOT json_extract(s.value,'$.receipt_request_id')) THEN RAISE(ABORT,'CORRECTION_UNSUPPORTED_OR_RECEIPT_CHANGED') END;
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM luggage_audit_logs a WHERE a.log_id=NEW.audit_id AND a.order_id=NEW.order_id
 AND a.device_id=NEW.correction_id AND a.staff_id=NEW.staff_id AND a.action='STAFF_ORDER_CORRECTION'
 AND a.timestamp=NEW.recorded_at AND json_extract(a.details,'$.requestHash')=NEW.request_hash
 AND json_extract(a.details,'$.reason')=NEW.reason AND json_extract(a.details,'$.before')=NEW.before_json AND json_extract(a.details,'$.after')=NEW.after_json)
 THEN RAISE(ABORT,'CORRECTION_AUDIT_REQUIRED') END;
 SELECT CASE WHEN json_type(NEW.after_json,'$.final_amount') IS NOT 'integer' OR json_extract(NEW.after_json,'$.final_amount') NOT BETWEEN 0 AND 500000
 OR (json_extract(NEW.after_json,'$.familyAmountOnly') IS NOT 1 AND json_extract(NEW.after_json,'$.prepaid_amount') IS NOT json_extract(NEW.after_json,'$.final_amount'))
 OR (json_extract(NEW.after_json,'$.familyAmountOnly') IS NOT 1 AND json_extract(NEW.after_json,'$.staff_prepaid_override_amount') IS NOT NULL AND json_extract(NEW.after_json,'$.staff_prepaid_override_amount') IS NOT json_extract(NEW.after_json,'$.final_amount'))
 OR json_type(NEW.after_json,'$.suitcase_qty') IS NOT 'integer' OR json_extract(NEW.after_json,'$.suitcase_qty') NOT BETWEEN 0 AND 99
 OR json_type(NEW.after_json,'$.backpack_qty') IS NOT 'integer' OR json_extract(NEW.after_json,'$.backpack_qty') NOT BETWEEN 0 AND 99
 OR json_extract(NEW.after_json,'$.suitcase_qty')+json_extract(NEW.after_json,'$.backpack_qty')<1
 OR json_type(NEW.after_json,'$.price_per_day') IS NOT 'integer' OR json_extract(NEW.after_json,'$.price_per_day') NOT BETWEEN 0 AND 500000
 OR ((json_extract(NEW.after_json,'$.suitcase_qty') IS NOT json_extract(NEW.before_json,'$.suitcase_qty') OR json_extract(NEW.after_json,'$.backpack_qty') IS NOT json_extract(NEW.before_json,'$.backpack_qty'))
 AND json_extract(NEW.after_json,'$.set_qty') IS NOT min(json_extract(NEW.after_json,'$.suitcase_qty'),json_extract(NEW.after_json,'$.backpack_qty')))
 OR ((json_extract(NEW.after_json,'$.suitcase_qty') IS json_extract(NEW.before_json,'$.suitcase_qty') AND json_extract(NEW.after_json,'$.backpack_qty') IS json_extract(NEW.before_json,'$.backpack_qty'))
 AND (json_extract(NEW.after_json,'$.set_qty') IS NOT json_extract(NEW.before_json,'$.set_qty') OR json_extract(NEW.after_json,'$.price_per_day') IS NOT json_extract(NEW.before_json,'$.price_per_day')))
 OR julianday(json_extract(NEW.after_json,'$.updated_at'))<=julianday(json_extract(NEW.before_json,'$.updated_at'))
 OR NEW.return_business_date>date(NEW.recorded_at,'+9 hours')
 OR julianday(NEW.return_occurred_at)>julianday(NEW.recorded_at)
 OR NEW.returned_amount>MAX(0,(SELECT net_received_amount FROM luggage_billing_balances WHERE root_id=NEW.order_id)+COALESCE((SELECT SUM(json_extract(value,'$.amount')) FROM json_each(NEW.historical_receipts_json)),0)-NEW.after_billed_amount)
 OR NEW.family_delta IS NOT CASE WHEN json_extract(NEW.after_json,'$.familyAmountOnly')=1 THEN NEW.after_billed_amount-NEW.before_billed_amount ELSE 0 END
 OR (json_extract(NEW.after_json,'$.familyAmountOnly')=1 AND (json_extract(NEW.after_json,'$.final_amount') IS NOT json_extract(NEW.before_json,'$.final_amount')
 OR json_extract(NEW.after_json,'$.suitcase_qty') IS NOT json_extract(NEW.before_json,'$.suitcase_qty') OR json_extract(NEW.after_json,'$.backpack_qty') IS NOT json_extract(NEW.before_json,'$.backpack_qty')))
 THEN RAISE(ABORT,'CORRECTION_INVALID_AMOUNTS') END;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM json_each(NEW.tender_changes_json) t LEFT JOIN luggage_effective_payments p ON p.payment_id=json_extract(t.value,'$.paymentId')
 WHERE (SELECT COALESCE(o.parent_order_id,o.order_id) FROM luggage_orders o WHERE o.order_id=p.order_id) IS NOT NEW.order_id OR p.tender_type IS NOT json_extract(t.value,'$.before')
 OR json_extract(t.value,'$.after') NOT IN ('CASH','PAY_QR') OR json_extract(t.value,'$.after')=json_extract(t.value,'$.before'))
 OR (SELECT COUNT(*) FROM json_each(NEW.tender_changes_json))!=(SELECT COUNT(DISTINCT json_extract(value,'$.paymentId')) FROM json_each(NEW.tender_changes_json))
 OR EXISTS(SELECT 1 FROM json_each(NEW.return_allocations_json) a LEFT JOIN luggage_correction_returns r ON r.correction_id=json_extract(a.value,'$.correctionId')
 WHERE r.order_id IS NOT NEW.order_id OR r.method IS NOT 'UNKNOWN' OR json_extract(a.value,'$.method') NOT IN ('CASH','PAY_QR'))
 THEN RAISE(ABORT,'CORRECTION_INVALID_TENDER') END;

END;
CREATE TRIGGER staff_historical_correction_guard BEFORE INSERT ON luggage_staff_corrections BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM luggage_staff_corrections WHERE correction_id=NEW.correction_id OR rowid=NEW.rowid) THEN RAISE(ABORT,'CORRECTION_STALE') END;
 SELECT CASE WHEN json_array_length(NEW.historical_receipts_json)>20
 OR (SELECT COUNT(DISTINCT json_extract(value,'$.receiptId')) FROM json_each(NEW.historical_receipts_json))!=json_array_length(NEW.historical_receipts_json)
 OR EXISTS(SELECT 1 FROM json_each(NEW.historical_receipts_json) h WHERE
 json_type(h.value) IS NOT 'object' OR json_type(h.value,'$.receiptId') IS NOT 'text'
 OR length(json_extract(h.value,'$.receiptId'))!=36 OR json_extract(h.value,'$.receiptId') GLOB '*[^0-9a-f-]*'
 OR substr(json_extract(h.value,'$.receiptId'),9,1)!='-' OR substr(json_extract(h.value,'$.receiptId'),14,1)!='-' OR substr(json_extract(h.value,'$.receiptId'),19,1)!='-' OR substr(json_extract(h.value,'$.receiptId'),24,1)!='-'
 OR json_type(h.value,'$.amount') IS NOT 'integer' OR json_extract(h.value,'$.amount') NOT BETWEEN 1 AND 500000
 OR json_extract(h.value,'$.tenderType') NOT IN ('CASH','PAY_QR') OR json_extract(h.value,'$.tenderType') IS NULL
 OR json_type(h.value,'$.businessDate') IS NOT 'text' OR date(json_extract(h.value,'$.businessDate')) IS NOT json_extract(h.value,'$.businessDate')
 OR json_extract(h.value,'$.businessDate')<date(json_extract(NEW.before_json,'$.created_at'),'+9 hours') OR json_extract(h.value,'$.businessDate')>date(NEW.recorded_at,'+9 hours')
 OR json_type(h.value,'$.confirmedAlreadyReceived') IS NOT 'true'
 OR json_type(h.value,'$.occurredAt') NOT IN ('null','text') OR json_type(h.value,'$.occurredAt') IS NULL
 OR (json_type(h.value,'$.occurredAt')='text' AND (julianday(json_extract(h.value,'$.occurredAt')) IS NULL OR julianday(json_extract(h.value,'$.occurredAt'))>julianday(NEW.recorded_at) OR date(json_extract(h.value,'$.occurredAt'),'+9 hours') IS NOT json_extract(h.value,'$.businessDate')))
 OR json_type(h.value,'$.timeNote') NOT IN ('null','text') OR json_type(h.value,'$.timeNote') IS NULL OR length(json_extract(h.value,'$.timeNote'))>100
 OR EXISTS(SELECT 1 FROM luggage_order_payments p WHERE p.receipt_request_id='historical:'||json_extract(h.value,'$.receiptId')))
 OR COALESCE((SELECT SUM(json_extract(value,'$.amount')) FROM json_each(NEW.historical_receipts_json)),0)>500000
 OR (json_array_length(NEW.historical_receipts_json)>0 AND COALESCE((SELECT SUM(json_extract(value,'$.amount')) FROM json_each(NEW.historical_receipts_json)),0)+(SELECT recorded_amount FROM luggage_billing_balances WHERE root_id=NEW.order_id)>500000)
 OR COALESCE((SELECT SUM(json_extract(value,'$.amount')) FROM json_each(NEW.historical_receipts_json)),0)>MAX(0,NEW.after_billed_amount+NEW.returned_amount-(SELECT net_received_amount FROM luggage_billing_balances WHERE root_id=NEW.order_id))
 OR (json_extract(NEW.before_json,'$.status')='PICKED_UP' AND NEW.after_billed_amount>(SELECT net_received_amount FROM luggage_billing_balances WHERE root_id=NEW.order_id)+COALESCE((SELECT SUM(json_extract(value,'$.amount')) FROM json_each(NEW.historical_receipts_json)),0)-NEW.returned_amount)
 THEN RAISE(ABORT,'CORRECTION_HISTORICAL_RECEIPT_INVALID') END;
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM luggage_orders o WHERE o.order_id=NEW.order_id AND o.tag_no IS json_extract(NEW.before_json,'$.tag_no') AND o.actual_pickup_at IS json_extract(NEW.before_json,'$.actual_pickup_at'))
 OR json_extract(NEW.before_json,'$.tag_no') IS NOT json_extract(NEW.after_json,'$.tag_no')
 OR json_extract(NEW.before_json,'$.actual_pickup_at') IS NOT json_extract(NEW.after_json,'$.actual_pickup_at')
 OR json_extract(NEW.before_json,'$.status') IS NOT json_extract(NEW.after_json,'$.status')
 THEN RAISE(ABORT,'CORRECTION_PICKUP_CHANGED') END;
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM luggage_audit_logs a WHERE a.log_id=NEW.audit_id AND a.staff_id=NEW.staff_id AND json_extract(a.details,'$.actor') IS NEW.actor_json
 AND COALESCE(json_extract(a.details,'$.changes.historicalReceipts'),'[]')=NEW.historical_receipts_json
 AND COALESCE(json_extract(a.details,'$.changes.returned.kind'),'GENERAL')=COALESCE(json_extract(NEW.return_context_json,'$.kind'),'GENERAL')
 AND json_extract(a.details,'$.changes.returned.discountTier') IS json_extract(NEW.return_context_json,'$.discountTier')
 AND json_extract(a.details,'$.changes.returned.timeNote') IS json_extract(NEW.return_context_json,'$.timeNote'))
 OR COALESCE(json_extract(NEW.return_context_json,'$.kind'),'GENERAL') NOT IN ('GENERAL','DISCOUNT_ALREADY_PAID')
 OR (COALESCE(json_extract(NEW.return_context_json,'$.kind'),'GENERAL')='GENERAL' AND json_extract(NEW.return_context_json,'$.discountTier') IS NOT NULL)
 OR (json_extract(NEW.return_context_json,'$.kind')='DISCOUNT_ALREADY_PAID' AND (NEW.returned_amount<=0 OR json_extract(NEW.return_context_json,'$.discountTier') NOT IN ('BLUE','SILVER','GOLD','PLATINUM','BLACK') OR json_extract(NEW.return_context_json,'$.discountTier') IS NULL
 OR EXISTS(SELECT 1 FROM luggage_flying_pass_refunds f WHERE f.order_id=NEW.order_id AND f.status IN ('CONFIRMED','PAYOUT_PENDING'))
 OR EXISTS(SELECT 1 FROM luggage_staff_corrections c WHERE c.order_id=NEW.order_id AND json_extract(c.return_context_json,'$.kind')='DISCOUNT_ALREADY_PAID')))
 THEN RAISE(ABORT,'CORRECTION_DISCOUNT_CONTEXT_INVALID') END;
END;
DROP TRIGGER staff_correction_apply;
CREATE TRIGGER staff_correction_apply AFTER INSERT ON luggage_staff_corrections BEGIN
 UPDATE luggage_orders SET suitcase_qty=json_extract(NEW.after_json,'$.suitcase_qty'), backpack_qty=json_extract(NEW.after_json,'$.backpack_qty'), set_qty=json_extract(NEW.after_json,'$.set_qty'), price_per_day=json_extract(NEW.after_json,'$.price_per_day'), prepaid_amount=json_extract(NEW.after_json,'$.prepaid_amount'), final_amount=json_extract(NEW.after_json,'$.final_amount'), staff_prepaid_override_amount=json_extract(NEW.after_json,'$.staff_prepaid_override_amount'), payment_method=json_extract(NEW.after_json,'$.payment_method'), updated_at=json_extract(NEW.after_json,'$.updated_at') WHERE order_id=NEW.order_id;
 SELECT CASE WHEN changes()!=1 OR NOT EXISTS(SELECT 1 FROM luggage_orders o WHERE o.order_id=NEW.order_id AND o.suitcase_qty IS json_extract(NEW.after_json,'$.suitcase_qty') AND o.backpack_qty IS json_extract(NEW.after_json,'$.backpack_qty') AND o.set_qty IS json_extract(NEW.after_json,'$.set_qty') AND o.price_per_day IS json_extract(NEW.after_json,'$.price_per_day') AND o.prepaid_amount IS json_extract(NEW.after_json,'$.prepaid_amount') AND o.final_amount IS json_extract(NEW.after_json,'$.final_amount') AND o.staff_prepaid_override_amount IS json_extract(NEW.after_json,'$.staff_prepaid_override_amount') AND o.payment_method IS json_extract(NEW.after_json,'$.payment_method') AND o.updated_at IS json_extract(NEW.after_json,'$.updated_at')) THEN RAISE(ABORT,'CORRECTION_APPLY_FAILED') END;
 INSERT INTO luggage_order_payments(order_id,business_date,tender_type,amount,staff_id,recorded_at,receipt_request_id)
 SELECT NEW.order_id,json_extract(h.value,'$.businessDate'),json_extract(h.value,'$.tenderType'),json_extract(h.value,'$.amount'),NEW.staff_id,NEW.recorded_at,'historical:'||json_extract(h.value,'$.receiptId') FROM json_each(NEW.historical_receipts_json) h;
 SELECT CASE WHEN (SELECT COUNT(*) FROM luggage_order_payments WHERE receipt_request_id IN (SELECT 'historical:'||json_extract(value,'$.receiptId') FROM json_each(NEW.historical_receipts_json)))!=json_array_length(NEW.historical_receipts_json) THEN RAISE(ABORT,'CORRECTION_HISTORICAL_RECEIPT_MISSING') END;
 UPDATE luggage_staff_corrections SET applied=1 WHERE correction_id=NEW.correction_id;
 SELECT CASE WHEN changes()!=1 THEN RAISE(ABORT,'CORRECTION_SEAL_FAILED') END;
 UPDATE luggage_orders SET status='PAID',updated_at=json_extract(NEW.after_json,'$.updated_at') WHERE parent_order_id=NEW.order_id AND status='PAYMENT_PENDING'
 AND json_extract(NEW.after_json,'$.familyAmountOnly')=1 AND EXISTS(SELECT 1 FROM luggage_billing_balances b WHERE b.root_id=NEW.order_id AND b.outstanding_amount=0 AND b.overpaid_amount=0 AND b.invalid_amount=0);
 SELECT CASE WHEN json_extract(NEW.after_json,'$.familyAmountOnly')=1 AND EXISTS(SELECT 1 FROM luggage_billing_balances b WHERE b.root_id=NEW.order_id AND b.outstanding_amount=0 AND b.overpaid_amount=0 AND b.invalid_amount=0)
 AND EXISTS(SELECT 1 FROM luggage_orders WHERE parent_order_id=NEW.order_id AND status='PAYMENT_PENDING') THEN RAISE(ABORT,'CORRECTION_FAMILY_SETTLEMENT_FAILED') END;
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM luggage_billing_balances b WHERE b.root_id=NEW.order_id AND b.total_effective_billed_amount=NEW.after_billed_amount AND b.invalid_amount=0 AND b.net_received_amount>=0) THEN RAISE(ABORT,'CORRECTION_BILLING_POSTCONDITION') END;
END;
DROP TRIGGER staff_correction_no_update;
CREATE TRIGGER staff_correction_no_update BEFORE UPDATE ON luggage_staff_corrections WHEN NOT (OLD.applied=0 AND NEW.applied=1 AND NEW.historical_receipts_json IS OLD.historical_receipts_json AND NEW.return_context_json IS OLD.return_context_json AND NEW.correction_id IS OLD.correction_id AND NEW.order_id IS OLD.order_id AND NEW.family_delta IS OLD.family_delta AND NEW.scope_json IS OLD.scope_json AND NEW.before_billed_amount IS OLD.before_billed_amount AND NEW.after_billed_amount IS OLD.after_billed_amount AND NEW.sequence IS OLD.sequence AND NEW.request_hash IS OLD.request_hash AND NEW.before_json IS OLD.before_json AND NEW.after_json IS OLD.after_json AND NEW.receipts_json IS OLD.receipts_json AND NEW.tender_changes_json IS OLD.tender_changes_json AND NEW.return_allocations_json IS OLD.return_allocations_json AND NEW.returned_amount IS OLD.returned_amount AND NEW.return_method IS OLD.return_method AND NEW.return_business_date IS OLD.return_business_date AND NEW.return_occurred_at IS OLD.return_occurred_at AND NEW.reason IS OLD.reason AND NEW.staff_id IS OLD.staff_id AND NEW.actor_json IS OLD.actor_json AND NEW.is_manager IS OLD.is_manager AND NEW.recorded_at IS OLD.recorded_at AND NEW.audit_id IS OLD.audit_id) BEGIN SELECT RAISE(ABORT,'Preserve correction events'); END;
DROP TRIGGER luggage_receipt_insert_guard;
CREATE TRIGGER IF NOT EXISTS luggage_receipt_insert_guard BEFORE INSERT ON luggage_order_payments
WHEN NEW.receipt_request_id IS NOT NULL AND NOT (EXISTS (
 SELECT 1 FROM luggage_staff_corrections c,json_each(c.historical_receipts_json) h
 JOIN luggage_audit_logs a ON a.log_id=c.audit_id AND a.order_id=c.order_id AND a.staff_id=c.staff_id
 AND a.device_id=c.correction_id AND a.action='STAFF_ORDER_CORRECTION' AND a.timestamp=c.recorded_at
 WHERE c.applied=0 AND c.order_id=NEW.order_id AND c.staff_id=NEW.staff_id AND c.recorded_at=NEW.recorded_at
 AND NEW.receipt_request_id='historical:'||json_extract(h.value,'$.receiptId') AND NEW.amount=json_extract(h.value,'$.amount')
 AND NEW.tender_type=json_extract(h.value,'$.tenderType') AND NEW.business_date=json_extract(h.value,'$.businessDate')
 AND NOT EXISTS(SELECT 1 FROM luggage_order_payments p WHERE p.payment_id=NEW.payment_id OR p.receipt_request_id=NEW.receipt_request_id)
 AND NOT EXISTS(SELECT 1 FROM luggage_flying_pass_refunds f WHERE f.status='PAYOUT_PENDING' AND
 (f.order_id=c.order_id OR f.order_id IN (SELECT order_id FROM luggage_orders WHERE parent_order_id=c.order_id)))))
BEGIN
  SELECT CASE WHEN NEW.amount <= 0 OR NEW.amount != CAST(NEW.amount AS INTEGER) OR NEW.amount > 500000
    OR NEW.staff_id IS NULL OR NEW.business_date != date(NEW.recorded_at, '+9 hours')
    OR NOT EXISTS (SELECT 1 FROM luggage_audit_logs a WHERE a.device_id = NEW.receipt_request_id
      AND a.action = 'CONFIRM_COLLECTION' AND a.staff_id = NEW.staff_id)
    OR NOT EXISTS (SELECT 1 FROM luggage_billing_lines l JOIN luggage_orders r ON r.order_id = l.root_id
      WHERE l.order_id = NEW.order_id AND r.status IN ('PAID', 'PAYMENT_PENDING')
        AND (l.collectible_amount >= NEW.amount OR (l.parent_order_id IS NULL AND EXISTS(SELECT 1 FROM luggage_billing_balances b WHERE b.root_id=l.root_id AND b.family_correction_count>0 AND b.outstanding_amount>=NEW.amount AND b.invalid_amount=0))))
    THEN RAISE(ABORT, 'Invalid or excess collection') END;
END;
DROP TRIGGER luggage_bag_receipt_insert_guard;
CREATE TRIGGER luggage_bag_receipt_insert_guard BEFORE INSERT ON luggage_order_payments
WHEN EXISTS(SELECT 1 FROM luggage_bag_additions WHERE order_id=NEW.order_id) AND NOT (EXISTS (
 SELECT 1 FROM luggage_staff_corrections c,json_each(c.historical_receipts_json) h
 JOIN luggage_audit_logs a ON a.log_id=c.audit_id AND a.order_id=c.order_id AND a.staff_id=c.staff_id
 AND a.device_id=c.correction_id AND a.action='STAFF_ORDER_CORRECTION' AND a.timestamp=c.recorded_at
 WHERE c.applied=0 AND c.order_id=NEW.order_id AND c.staff_id=NEW.staff_id AND c.recorded_at=NEW.recorded_at
 AND NEW.receipt_request_id='historical:'||json_extract(h.value,'$.receiptId') AND NEW.amount=json_extract(h.value,'$.amount')
 AND NEW.tender_type=json_extract(h.value,'$.tenderType') AND NEW.business_date=json_extract(h.value,'$.businessDate')
 AND NOT EXISTS(SELECT 1 FROM luggage_order_payments p WHERE p.payment_id=NEW.payment_id OR p.receipt_request_id=NEW.receipt_request_id)
 AND NOT EXISTS(SELECT 1 FROM luggage_flying_pass_refunds f WHERE f.status='PAYOUT_PENDING' AND
 (f.order_id=c.order_id OR f.order_id IN (SELECT order_id FROM luggage_orders WHERE parent_order_id=c.order_id)))))
BEGIN
  SELECT CASE WHEN NEW.receipt_request_id IS NULL
    OR EXISTS(SELECT 1 FROM luggage_cash_closings WHERE business_date=NEW.business_date AND closing_type='FINAL_CLOSE')
    THEN RAISE(ABORT,'Use open-day collection confirmation for bag additions') END;
END;
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
AND NOT (EXISTS (
 SELECT 1 FROM luggage_staff_corrections c,json_each(c.historical_receipts_json) h
 JOIN luggage_audit_logs a ON a.log_id=c.audit_id AND a.order_id=c.order_id AND a.staff_id=c.staff_id
 AND a.device_id=c.correction_id AND a.action='STAFF_ORDER_CORRECTION' AND a.timestamp=c.recorded_at
 WHERE c.applied=0 AND c.order_id=NEW.order_id AND c.staff_id=NEW.staff_id AND c.recorded_at=NEW.recorded_at
 AND NEW.receipt_request_id='historical:'||json_extract(h.value,'$.receiptId') AND NEW.amount=json_extract(h.value,'$.amount')
 AND NEW.tender_type=json_extract(h.value,'$.tenderType') AND NEW.business_date=json_extract(h.value,'$.businessDate')
 AND NOT EXISTS(SELECT 1 FROM luggage_order_payments p WHERE p.payment_id=NEW.payment_id OR p.receipt_request_id=NEW.receipt_request_id)
 AND NOT EXISTS(SELECT 1 FROM luggage_flying_pass_refunds f WHERE f.status='PAYOUT_PENDING' AND
 (f.order_id=c.order_id OR f.order_id IN (SELECT order_id FROM luggage_orders WHERE parent_order_id=c.order_id)))))
BEGIN SELECT RAISE(ABORT, 'REFUND_PRESERVE_ORIGINAL_RECEIPT'); END;
CREATE TRIGGER staff_historical_receipt_no_replace BEFORE INSERT ON luggage_order_payments
WHEN NEW.receipt_request_id GLOB 'historical:*' AND EXISTS(SELECT 1 FROM luggage_order_payments p WHERE p.receipt_request_id=NEW.receipt_request_id)
BEGIN SELECT RAISE(ABORT,'Preserve historical receipt'); END;
CREATE TRIGGER staff_historical_discount_no_double_refund BEFORE INSERT ON luggage_flying_pass_refunds
WHEN NEW.status='PAYOUT_PENDING' AND EXISTS(SELECT 1 FROM luggage_staff_corrections c WHERE c.order_id=NEW.order_id AND json_extract(c.return_context_json,'$.kind')='DISCOUNT_ALREADY_PAID')
BEGIN SELECT RAISE(ABORT,'Historical discount already paid'); END;

CREATE TRIGGER staff_historical_receipt_update_key BEFORE UPDATE ON luggage_order_payments
WHEN NEW.receipt_request_id GLOB 'historical:*' AND EXISTS(SELECT 1 FROM luggage_order_payments p WHERE p.receipt_request_id=NEW.receipt_request_id AND p.payment_id IS NOT OLD.payment_id)
BEGIN SELECT RAISE(ABORT,'Preserve historical receipt key'); END;
