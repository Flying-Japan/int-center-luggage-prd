-- Luggage app tables for Flying Japan luggage storage
-- All tables prefixed with luggage_ to avoid conflicts with center-dashboard tables

CREATE TABLE IF NOT EXISTS luggage_orders (
  order_id TEXT PRIMARY KEY,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  name TEXT,
  phone TEXT,
  companion_count INTEGER DEFAULT 0,
  suitcase_qty INTEGER DEFAULT 0,
  backpack_qty INTEGER DEFAULT 0,
  set_qty INTEGER DEFAULT 0,
  expected_pickup_at TIMESTAMPTZ,
  actual_pickup_at TIMESTAMPTZ,
  expected_storage_days INTEGER DEFAULT 0,
  actual_storage_days INTEGER DEFAULT 0,
  extra_days INTEGER DEFAULT 0,
  price_per_day INTEGER DEFAULT 0,
  discount_rate NUMERIC DEFAULT 0,
  prepaid_amount INTEGER DEFAULT 0,
  flying_pass_tier TEXT DEFAULT 'NONE',
  flying_pass_discount_amount INTEGER DEFAULT 0,
  staff_prepaid_override_amount INTEGER,
  extra_amount INTEGER DEFAULT 0,
  final_amount INTEGER DEFAULT 0,
  payment_method TEXT,
  status TEXT DEFAULT 'PAYMENT_PENDING',
  tag_no TEXT,
  note TEXT,
  id_image_url TEXT,
  luggage_image_url TEXT,
  consent_checked BOOLEAN DEFAULT false,
  manual_entry BOOLEAN DEFAULT false,
  staff_id TEXT
);

CREATE TABLE IF NOT EXISTS luggage_audit_logs (
  log_id BIGSERIAL PRIMARY KEY,
  order_id TEXT,
  staff_id TEXT,
  device_id TEXT,
  action TEXT,
  timestamp TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS luggage_daily_counters (
  business_date TEXT PRIMARY KEY,
  last_seq INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS luggage_daily_tag_counters (
  business_date TEXT PRIMARY KEY,
  last_seq INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS luggage_lost_found_entries (
  entry_id BIGSERIAL PRIMARY KEY,
  found_at TIMESTAMPTZ,
  item_name TEXT,
  quantity INTEGER DEFAULT 1,
  found_location TEXT,
  status TEXT DEFAULT 'UNCLAIMED',
  claimed_by TEXT,
  note TEXT,
  staff_id TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS luggage_handover_notes (
  note_id BIGSERIAL PRIMARY KEY,
  category TEXT,
  title TEXT,
  content TEXT,
  is_pinned BOOLEAN DEFAULT false,
  staff_id TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS luggage_handover_reads (
  read_id BIGSERIAL PRIMARY KEY,
  note_id BIGINT,
  staff_id TEXT,
  read_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS luggage_handover_comments (
  comment_id BIGSERIAL PRIMARY KEY,
  note_id BIGINT,
  staff_id TEXT,
  content TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS luggage_cash_closings (
  closing_id BIGSERIAL PRIMARY KEY,
  business_date TEXT,
  closing_type TEXT DEFAULT 'EVENING',
  workflow_status TEXT DEFAULT 'DRAFT',
  count_10000 INTEGER DEFAULT 0,
  count_5000 INTEGER DEFAULT 0,
  count_2000 INTEGER DEFAULT 0,
  count_1000 INTEGER DEFAULT 0,
  count_500 INTEGER DEFAULT 0,
  count_100 INTEGER DEFAULT 0,
  count_50 INTEGER DEFAULT 0,
  count_10 INTEGER DEFAULT 0,
  count_5 INTEGER DEFAULT 0,
  count_1 INTEGER DEFAULT 0,
  total_amount INTEGER DEFAULT 0,
  paypay_amount INTEGER DEFAULT 0,
  actual_qr_amount INTEGER DEFAULT 0,
  qr_difference_amount INTEGER DEFAULT 0,
  check_auto_amount INTEGER DEFAULT 0,
  expected_amount INTEGER DEFAULT 0,
  actual_amount INTEGER DEFAULT 0,
  difference_amount INTEGER DEFAULT 0,
  submitted_by_staff_id TEXT,
  submitted_at TIMESTAMPTZ,
  verified_by_staff_id TEXT,
  verified_at TIMESTAMPTZ,
  check_cash_match BOOLEAN DEFAULT false,
  check_qr_match BOOLEAN DEFAULT false,
  check_pending_items BOOLEAN DEFAULT false,
  check_handover_note BOOLEAN DEFAULT false,
  owner_name TEXT,
  note TEXT,
  staff_id TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS luggage_cash_closing_audits (
  audit_id BIGSERIAL PRIMARY KEY,
  closing_id BIGINT,
  action TEXT,
  reason TEXT,
  payload TEXT,
  staff_id TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS luggage_rental_daily_sales (
  rental_id BIGSERIAL PRIMARY KEY,
  business_date TEXT,
  revenue_amount INTEGER DEFAULT 0,
  customer_count INTEGER DEFAULT 0,
  note TEXT,
  staff_id TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS luggage_app_settings (
  setting_id BIGSERIAL PRIMARY KEY,
  setting_key TEXT UNIQUE NOT NULL,
  setting_value TEXT,
  staff_id TEXT,
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS luggage_work_schedules (
  schedule_id BIGSERIAL PRIMARY KEY,
  work_date DATE,
  staff_name TEXT,
  start_time TEXT,
  end_time TEXT,
  role TEXT,
  note TEXT,
  created_by_staff_id TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_luggage_orders_status ON luggage_orders(status);
CREATE INDEX IF NOT EXISTS idx_luggage_orders_created_at ON luggage_orders(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_luggage_audit_logs_order_id ON luggage_audit_logs(order_id);
CREATE INDEX IF NOT EXISTS idx_luggage_handover_notes_created ON luggage_handover_notes(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_luggage_cash_closings_date ON luggage_cash_closings(business_date);

-- RLS: disable for service role access (Python app uses service role key)
ALTER TABLE luggage_orders DISABLE ROW LEVEL SECURITY;
ALTER TABLE luggage_audit_logs DISABLE ROW LEVEL SECURITY;
ALTER TABLE luggage_daily_counters DISABLE ROW LEVEL SECURITY;
ALTER TABLE luggage_daily_tag_counters DISABLE ROW LEVEL SECURITY;
ALTER TABLE luggage_lost_found_entries DISABLE ROW LEVEL SECURITY;
ALTER TABLE luggage_handover_notes DISABLE ROW LEVEL SECURITY;
ALTER TABLE luggage_handover_reads DISABLE ROW LEVEL SECURITY;
ALTER TABLE luggage_handover_comments DISABLE ROW LEVEL SECURITY;
ALTER TABLE luggage_cash_closings DISABLE ROW LEVEL SECURITY;
ALTER TABLE luggage_cash_closing_audits DISABLE ROW LEVEL SECURITY;
ALTER TABLE luggage_rental_daily_sales DISABLE ROW LEVEL SECURITY;
ALTER TABLE luggage_app_settings DISABLE ROW LEVEL SECURITY;
ALTER TABLE luggage_work_schedules DISABLE ROW LEVEL SECURITY;
