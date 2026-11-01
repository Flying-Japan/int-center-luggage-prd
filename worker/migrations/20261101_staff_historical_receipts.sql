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
