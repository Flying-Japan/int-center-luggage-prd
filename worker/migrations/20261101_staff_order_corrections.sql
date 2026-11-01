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
