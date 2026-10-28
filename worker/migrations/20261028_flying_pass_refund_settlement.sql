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
  SELECT business_date, SUM(amount) AS amount, COUNT(*) AS refund_count FROM luggage_flying_pass_refunds
  WHERE status = 'CONFIRMED' GROUP BY business_date
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
      'refundIds',json((SELECT json_group_array(refund_id) FROM (SELECT refund_id FROM luggage_flying_pass_refunds WHERE business_date = NEW.business_date AND status = 'CONFIRMED' ORDER BY refund_id)))), NEW.staff_id
    FROM luggage_sales_daily WHERE business_date = NEW.business_date;
  INSERT INTO luggage_cash_closing_refund_snapshots(closing_id,business_date,gross_cash,gross_qr,cash_refund_amount,refund_count,refund_ids,net_cash,net_total,audit_id)
    SELECT NEW.closing_id,NEW.business_date,gross_cash,gross_qr,cash_refund_amount,refund_count,
      (SELECT json_group_array(refund_id) FROM (SELECT refund_id FROM luggage_flying_pass_refunds WHERE business_date = NEW.business_date AND status = 'CONFIRMED' ORDER BY refund_id)),cash,total_amount,last_insert_rowid()
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
  SELECT CASE WHEN NEW.closing_type = 'FINAL_CLOSE' AND EXISTS (SELECT 1 FROM luggage_flying_pass_refunds WHERE business_date = NEW.business_date AND status = 'CONFIRMED')
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
