-- Flying Pass refund shift handover + manager late confirmation. NOT additive: rebuilds luggage_flying_pass_refunds under the same name
-- (SQLite cannot drop a CHECK) and replaces luggage_sales_daily and two closing triggers.
-- 1) Handover: the staff who confirms/cancels may differ from the registrant. terminal_by_staff_id and the linked terminal
--    audit (actor.userId, legacyStaff.id) record the real finisher; registered_by_staff_id/actor_user_id keep the registrant.
-- 2) Late confirmation: a PAYOUT_PENDING row from a past JST day may be CONFIRMED with paid_at = the real cash payout time (before
--    terminal_at). Only when the terminal audit carries $.lateConfirm {paidAt = paid_at, reason} and $.actor.role is manager/super_admin
--    (the DB binds the evidence; the HMAC-signed actor role itself is checked by the Worker). Same-day confirmation is unchanged
--    (paid_at = terminal_at, business_date = today) and must not carry $.lateConfirm.
-- 3) Settlement attribution: a CONFIRMED refund now belongs to the JST day of paid_at (sales view, FINAL_CLOSE refund snapshot, closing
--    update guard), not the registration day. For every existing CONFIRMED row date(paid_at,+9h) = business_date (old CHECK), so existing
--    totals/snapshots are unchanged. PAYOUT_PENDING rows (no paid_at) still block their registration day's FINAL_CLOSE.
--    A late confirmation is refused when its payout day already has a FINAL_CLOSE: past closings/snapshots are never rewritten.
-- Apply BEFORE the Worker that drops the registrant-only rule; the older Worker (same actor, same day only) keeps working on the new schema.
-- Rows are copied before the insert guard is recreated (the guard rejects non-pending or past-day inserts). Other views/triggers that
-- reference this table are not touched (DROP/CREATE does not re-validate them; RENAME would). Repeatable only after a COMPLETE run:
-- if an import stops between DROP TABLE luggage_flying_pass_refunds and the INSERT from the copy, do NOT re-run (the first statement drops
-- the copy); restore the refund rows from luggage_flying_pass_refunds_handover_copy / the pre-apply export first. D1 import atomicity is unverified.
DROP TABLE IF EXISTS luggage_flying_pass_refunds_handover_copy;
CREATE TABLE luggage_flying_pass_refunds_handover_copy AS SELECT * FROM luggage_flying_pass_refunds;
DROP TABLE luggage_flying_pass_refunds;
CREATE TABLE luggage_flying_pass_refunds (
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
INSERT INTO luggage_flying_pass_refunds SELECT * FROM luggage_flying_pass_refunds_handover_copy ORDER BY order_id, sequence;
DROP TABLE luggage_flying_pass_refunds_handover_copy;
CREATE UNIQUE INDEX IF NOT EXISTS idx_flying_pass_refund_pending ON luggage_flying_pass_refunds(order_id) WHERE status = 'PAYOUT_PENDING';
CREATE INDEX IF NOT EXISTS idx_flying_pass_refund_day ON luggage_flying_pass_refunds(business_date, status);

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

-- Settlement attribution by payout day (see 3 above). Only the refunds CTE differs from 20261028_flying_pass_refund_settlement.sql.
DROP VIEW IF EXISTS luggage_sales_daily;
CREATE VIEW luggage_sales_daily AS
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

DROP TRIGGER IF EXISTS luggage_refund_closing_snapshot;
CREATE TRIGGER luggage_refund_closing_snapshot AFTER INSERT ON luggage_cash_closings
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

DROP TRIGGER IF EXISTS luggage_refund_closing_update_guard;
CREATE TRIGGER luggage_refund_closing_update_guard BEFORE UPDATE ON luggage_cash_closings
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
