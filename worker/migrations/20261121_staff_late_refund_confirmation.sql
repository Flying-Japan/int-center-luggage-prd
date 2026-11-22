-- Staff daily correction: change only the terminal audit role guard; preserve all money, time, snapshot, closing and immutable-ledger checks.
-- Requires the already-deployed additional-bag / staff-correction schema.
SELECT CASE WHEN EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='luggage_bag_additions')
  AND EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='luggage_staff_corrections') THEN 1 ELSE json_extract('{}','STAFF_CORRECTION_SCHEMA_REQUIRED') END;
DROP TRIGGER IF EXISTS luggage_refund_transition_guard;
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
        OR COALESCE(json_extract((SELECT details FROM luggage_audit_logs WHERE log_id = NEW.terminal_audit_id), '$.actor.role'), '') NOT IN ('center_staff', 'part_time', 'manager', 'super_admin')
        OR (json_extract((SELECT details FROM luggage_audit_logs WHERE log_id = NEW.terminal_audit_id), '$.actor.role') = 'part_time'
          AND NEW.terminal_by_staff_id IS NOT 'pt:' || json_extract((SELECT details FROM luggage_audit_logs WHERE log_id = NEW.terminal_audit_id), '$.actor.userId'))
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
