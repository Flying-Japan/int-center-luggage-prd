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
  consent_checked INTEGER NOT NULL DEFAULT 0,
  manual_entry INTEGER NOT NULL DEFAULT 0,
  staff_id TEXT,
  parent_order_id TEXT,
  in_warehouse INTEGER NOT NULL DEFAULT 0
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

-- Analytics: Rental daily sales (synced from Supabase product_orders via cron)
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

-- Indexes
CREATE INDEX IF NOT EXISTS idx_luggage_orders_status ON luggage_orders(status);
CREATE INDEX IF NOT EXISTS idx_luggage_orders_created_at ON luggage_orders(created_at);
CREATE INDEX IF NOT EXISTS idx_luggage_orders_in_warehouse ON luggage_orders(in_warehouse) WHERE in_warehouse = 1;
CREATE INDEX IF NOT EXISTS idx_luggage_orders_parent_order_id ON luggage_orders(parent_order_id) WHERE parent_order_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_luggage_audit_logs_order_id ON luggage_audit_logs(order_id);
CREATE INDEX IF NOT EXISTS idx_luggage_handover_notes_created ON luggage_handover_notes(created_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_cash_closings_date_type ON luggage_cash_closings(business_date, closing_type);
CREATE INDEX IF NOT EXISTS idx_luggage_cash_closings_date ON luggage_cash_closings(business_date);
