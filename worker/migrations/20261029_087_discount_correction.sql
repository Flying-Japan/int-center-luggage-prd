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
