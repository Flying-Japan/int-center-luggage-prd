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
    OR (status = 'CONFIRMED' AND terminal_hash IS NOT NULL AND length(terminal_hash) = 64 AND terminal_by_staff_id IS NOT NULL AND terminal_at IS NOT NULL AND terminal_audit_id IS NOT NULL AND paid_at = terminal_at AND julianday(paid_at) IS NOT NULL AND date(paid_at, '+9 hours') = business_date AND cancel_reason IS NULL)
    OR (status = 'CANCELLED' AND terminal_hash IS NOT NULL AND length(terminal_hash) = 64 AND terminal_by_staff_id IS NOT NULL AND terminal_at IS NOT NULL AND terminal_audit_id IS NOT NULL AND paid_at IS NULL AND cancel_reason IS NOT NULL AND length(trim(cancel_reason)) BETWEEN 1 AND 200)),
  CHECK (status = 'PAYOUT_PENDING' OR (terminal_by_staff_id = registered_by_staff_id AND julianday(terminal_at) IS NOT NULL AND julianday(terminal_at) >= julianday(created_at)))
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
      AND json_extract(a.details, '$.actor.userId') = NEW.actor_user_id
      AND CASE NEW.status WHEN 'CONFIRMED' THEN json_extract(a.details, '$.cashPaid') = 1 ELSE json_extract(a.details, '$.confirmNotPaid') = 1 END)
    THEN RAISE(ABORT, 'REFUND_IMMUTABLE_OR_INVALID_TRANSITION') END;
  SELECT CASE WHEN NEW.status = 'CONFIRMED' AND (
    NEW.business_date != date('now', '+9 hours')

    OR NEW.root_snapshot IS NOT (SELECT json_object('order_id',order_id,'parent_order_id',parent_order_id,'status',status,'created_at',created_at,'prepaid_amount',prepaid_amount,'final_amount',final_amount,'extra_amount',extra_amount,'price_per_day',price_per_day,'expected_storage_days',expected_storage_days,'flying_pass_tier',flying_pass_tier,'flying_pass_discount_amount',flying_pass_discount_amount,'staff_prepaid_override_amount',staff_prepaid_override_amount,'suitcase_qty',suitcase_qty,'backpack_qty',backpack_qty,'set_qty',set_qty,'expected_pickup_at',expected_pickup_at,'extension_date',extension_date) FROM luggage_orders WHERE order_id = NEW.order_id)
    OR NEW.receipt_snapshot IS NOT (SELECT json_group_array(json_object('payment_id',payment_id,'tender_type',tender_type,'amount',amount,'business_date',business_date,'recorded_at',recorded_at,'staff_id',staff_id,'receipt_request_id',receipt_request_id)) FROM (SELECT * FROM luggage_order_payments WHERE order_id = NEW.order_id ORDER BY payment_id))
    OR EXISTS (SELECT 1 FROM luggage_cash_closings WHERE business_date = NEW.business_date AND closing_type = 'FINAL_CLOSE')
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
