-- Customer history and points prep.
--
-- This migration is additive, but SQLite/D1 does not support
-- ALTER TABLE ADD COLUMN IF NOT EXISTS. Before applying, verify it has not
-- already run:
--
--   SELECT version FROM schema_migrations
--   WHERE version = '20260521_customer_history_points_prep';
--
-- If that returns a row, do not run this migration again.

CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS luggage_customer_profiles (
  account_person_id TEXT PRIMARY KEY,
  display_name TEXT,
  phone TEXT,
  email TEXT,
  locale TEXT,
  identity_verified_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS luggage_customer_point_accounts (
  account_person_id TEXT PRIMARY KEY,
  balance_points INTEGER NOT NULL DEFAULT 0,
  lifetime_earned_points INTEGER NOT NULL DEFAULT 0,
  lifetime_used_points INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS luggage_customer_point_transactions (
  transaction_id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_person_id TEXT NOT NULL,
  order_id TEXT,
  transaction_type TEXT NOT NULL,
  points_delta INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'POSTED',
  balance_after INTEGER NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  reason TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

ALTER TABLE luggage_orders ADD COLUMN account_person_id TEXT;
ALTER TABLE luggage_orders ADD COLUMN gross_amount INTEGER NOT NULL DEFAULT 0;
ALTER TABLE luggage_orders ADD COLUMN point_discount_amount INTEGER NOT NULL DEFAULT 0;
ALTER TABLE luggage_orders ADD COLUMN points_used INTEGER NOT NULL DEFAULT 0;
ALTER TABLE luggage_orders ADD COLUMN points_earned INTEGER NOT NULL DEFAULT 0;
ALTER TABLE luggage_orders ADD COLUMN point_usage_status TEXT NOT NULL DEFAULT 'NONE';
ALTER TABLE luggage_orders ADD COLUMN source_preset_order_id TEXT;

UPDATE luggage_orders
SET gross_amount = prepaid_amount
WHERE gross_amount = 0
  AND prepaid_amount > 0;

CREATE INDEX IF NOT EXISTS idx_luggage_orders_account_recent
  ON luggage_orders(account_person_id, created_at)
  WHERE account_person_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_luggage_orders_source_preset
  ON luggage_orders(source_preset_order_id)
  WHERE source_preset_order_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_luggage_customer_profiles_email
  ON luggage_customer_profiles(email)
  WHERE email IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_luggage_point_transactions_person_created
  ON luggage_customer_point_transactions(account_person_id, created_at);

CREATE INDEX IF NOT EXISTS idx_luggage_point_transactions_order
  ON luggage_customer_point_transactions(order_id)
  WHERE order_id IS NOT NULL;

INSERT OR IGNORE INTO schema_migrations (version)
  VALUES ('20260521_customer_history_points_prep');
