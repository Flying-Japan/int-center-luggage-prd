-- Independent remaining-period batches; original prepaid period and discount remain unchanged.
CREATE TABLE luggage_bag_additions (
  addition_id TEXT PRIMARY KEY CHECK(length(addition_id)=36),
  order_id TEXT NOT NULL REFERENCES luggage_orders(order_id),
  request_hash TEXT NOT NULL CHECK(length(request_hash)=64),
  suitcase_added INTEGER NOT NULL CHECK(typeof(suitcase_added)='integer' AND suitcase_added BETWEEN 0 AND 99),
  backpack_added INTEGER NOT NULL CHECK(typeof(backpack_added)='integer' AND backpack_added BETWEEN 0 AND 99),
  set_added INTEGER NOT NULL CHECK(set_added=min(suitcase_added,backpack_added)),
  before_suitcase INTEGER NOT NULL, before_backpack INTEGER NOT NULL, before_set_qty INTEGER NOT NULL,
  before_price_per_day INTEGER NOT NULL,
  after_suitcase INTEGER NOT NULL CHECK(after_suitcase=before_suitcase+suitcase_added AND after_suitcase BETWEEN 0 AND 99),
  after_backpack INTEGER NOT NULL CHECK(after_backpack=before_backpack+backpack_added AND after_backpack BETWEEN 0 AND 99),
  after_set_qty INTEGER NOT NULL CHECK(after_set_qty=before_set_qty+set_added),
  batch_price_per_day INTEGER NOT NULL CHECK(batch_price_per_day=set_added*1200+(suitcase_added-set_added)*800+(backpack_added-set_added)*500),
  after_price_per_day INTEGER NOT NULL CHECK(after_price_per_day=before_price_per_day+batch_price_per_day AND after_price_per_day<=500000),
  coverage_start_date TEXT NOT NULL, coverage_end_date TEXT NOT NULL, original_pickup_at TEXT NOT NULL,
  storage_days INTEGER NOT NULL CHECK(storage_days=CAST(julianday(coverage_end_date)-julianday(coverage_start_date) AS INTEGER)+1 AND storage_days BETWEEN 1 AND 3660),
  discount_rate REAL NOT NULL CHECK(discount_rate=CASE WHEN storage_days>=60 THEN 0.20 WHEN storage_days>=30 THEN 0.15 WHEN storage_days>=14 THEN 0.10 WHEN storage_days>=7 THEN 0.05 ELSE 0 END),
  base_amount INTEGER NOT NULL CHECK(base_amount=batch_price_per_day*storage_days),
  discounted_amount INTEGER NOT NULL CHECK(discounted_amount=CAST(round(base_amount*(1-discount_rate)) AS INTEGER) AND discounted_amount<=500000),
  flying_pass_tier TEXT NOT NULL CHECK(flying_pass_tier IN ('NONE','BLUE','SILVER','GOLD','PLATINUM','BLACK')),
  flying_pass_discount_amount INTEGER NOT NULL CHECK(flying_pass_discount_amount=CASE WHEN flying_pass_tier='BLACK' THEN discounted_amount ELSE 0 END),
  amount INTEGER NOT NULL CHECK(typeof(amount)='integer' AND amount=discounted_amount-flying_pass_discount_amount AND amount BETWEEN 0 AND 500000),
  policy_version TEXT NOT NULL CHECK(policy_version='SEPARATE_REMAINING_PERIOD_V1'),
  before_updated_at TEXT NOT NULL, revision TEXT NOT NULL,
  business_date TEXT NOT NULL, created_at TEXT NOT NULL,
  staff_id TEXT NOT NULL CHECK(length(trim(staff_id))>0),
  reason TEXT NOT NULL CHECK(length(trim(reason)) BETWEEN 1 AND 200),
  audit_id INTEGER NOT NULL UNIQUE REFERENCES luggage_audit_logs(log_id),
  CHECK(suitcase_added+backpack_added>0),
  CHECK(coverage_start_date=business_date AND coverage_end_date=date(original_pickup_at,'+9 hours')),
  CHECK(business_date=date(created_at,'+9 hours') AND julianday(revision)>julianday(before_updated_at))
);
CREATE INDEX idx_luggage_bag_additions_order ON luggage_bag_additions(order_id);

CREATE UNIQUE INDEX idx_luggage_bag_addition_audit ON luggage_audit_logs(device_id) WHERE action='BAG_ADDITION_REGISTER';

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
), amounts AS (
  SELECT o.*, COALESCE(o.parent_order_id, o.order_id) AS root_id,
    COALESCE(o.final_amount, o.prepaid_amount, 0) + COALESCE(o.extra_amount, 0) + COALESCE(b.amount, 0) AS billed_amount,
    COALESCE(b.amount, 0) AS bag_addition_amount, COALESCE(b.count,0) AS bag_addition_count, COALESCE(b.daily_rate,0) AS bag_addition_daily_rate, COALESCE(b.discounted_amount,0) AS bag_addition_discounted_amount, COALESCE(b.pass_discount,0) AS bag_addition_pass_discount, o.price_per_day-COALESCE(b.daily_rate,0) AS bag_original_price_per_day,
    COALESCE(p.recorded_amount, 0) AS recorded_amount, COALESCE(p.payment_count, 0) AS payment_count,
    COALESCE(f.refunded, 0) AS discount_credit_amount, COALESCE(f.refunded, 0) AS cash_refunded_amount,
    COALESCE(f.pending, 0) AS pending_refund_count, COALESCE(f.refund_count, 0) AS refund_count,
    COALESCE(o.final_amount, o.prepaid_amount, 0) + COALESCE(o.extra_amount, 0) + COALESCE(b.amount, 0) - COALESCE(f.refunded, 0) AS effective_billed_amount,
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
  LEFT JOIN bag_additions b ON b.order_id = o.order_id
  LEFT JOIN ledger p ON p.order_id = o.order_id LEFT JOIN refunds f ON f.order_id = o.order_id WHERE o.status != 'CANCELLED'
), evidence AS (
  SELECT m.*, m.effective_billed_amount - m.net_received_amount - m.legacy_paid_estimate AS raw_balance,
    CASE WHEN m.parent_order_id IS NULL AND m.status IN ('PAID', 'PICKED_UP')
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
CREATE VIEW IF NOT EXISTS luggage_billing_balances AS
WITH totals AS (
  SELECT root_id, SUM(parent_order_id IS NOT NULL) AS extension_count, SUM(billed_amount) AS billed_amount, SUM(bag_addition_amount) AS bag_addition_amount, SUM(bag_addition_count) AS bag_addition_count, SUM(bag_addition_daily_rate) AS bag_addition_daily_rate, SUM(bag_addition_discounted_amount) AS bag_addition_discounted_amount, SUM(bag_addition_pass_discount) AS bag_addition_pass_discount, MAX(CASE WHEN parent_order_id IS NULL THEN bag_original_price_per_day ELSE 0 END) AS bag_original_price_per_day,
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
      OR discount_credit_amount > COALESCE(final_amount, prepaid_amount) + bag_addition_amount OR effective_billed_amount < 0 OR net_received_amount < 0
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
        AND b.recorded_amount=b.total_billed_amount
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
CREATE TRIGGER luggage_bag_addition_apply AFTER INSERT ON luggage_bag_additions
BEGIN
  UPDATE luggage_orders SET suitcase_qty=NEW.after_suitcase,backpack_qty=NEW.after_backpack,
    set_qty=NEW.after_set_qty,price_per_day=NEW.after_price_per_day,updated_at=NEW.revision
    WHERE order_id=NEW.order_id AND updated_at=NEW.before_updated_at;
  SELECT CASE WHEN changes()!=1 THEN RAISE(ABORT,'BAG_ADDITION_STALE') END;
END;
CREATE TRIGGER luggage_bag_addition_no_update BEFORE UPDATE ON luggage_bag_additions
BEGIN SELECT RAISE(ABORT,'Preserve bag addition history'); END;
CREATE TRIGGER luggage_bag_addition_no_delete BEFORE DELETE ON luggage_bag_additions
BEGIN SELECT RAISE(ABORT,'Preserve bag addition history'); END;
CREATE TRIGGER luggage_bag_addition_no_replace BEFORE INSERT ON luggage_bag_additions
WHEN EXISTS(SELECT 1 FROM luggage_bag_additions WHERE addition_id=NEW.addition_id)
BEGIN SELECT RAISE(ABORT,'Preserve bag addition history'); END;
CREATE TRIGGER luggage_bag_preserve_order BEFORE UPDATE ON luggage_orders
WHEN EXISTS(SELECT 1 FROM luggage_bag_additions WHERE order_id=OLD.order_id)
BEGIN
  SELECT CASE WHEN NEW.prepaid_amount IS NOT OLD.prepaid_amount OR NEW.final_amount IS NOT OLD.final_amount
    OR NEW.extra_amount IS NOT OLD.extra_amount OR NEW.parent_order_id IS NOT OLD.parent_order_id
    OR NEW.created_at IS NOT OLD.created_at OR NEW.expected_storage_days IS NOT OLD.expected_storage_days
    OR date(NEW.expected_pickup_at,'+9 hours') IS NOT date(OLD.expected_pickup_at,'+9 hours') OR NEW.flying_pass_tier IS NOT OLD.flying_pass_tier
    OR NEW.flying_pass_discount_amount IS NOT OLD.flying_pass_discount_amount
    OR NEW.staff_prepaid_override_amount IS NOT OLD.staff_prepaid_override_amount
    OR NEW.status NOT IN ('PAID','PICKED_UP') OR NEW.order_id IS NOT OLD.order_id
    THEN RAISE(ABORT,'Preserve bag addition original claim') END;
  SELECT CASE WHEN (NEW.suitcase_qty IS NOT OLD.suitcase_qty OR NEW.backpack_qty IS NOT OLD.backpack_qty
      OR NEW.set_qty IS NOT OLD.set_qty OR NEW.price_per_day IS NOT OLD.price_per_day)
    AND NOT EXISTS(SELECT 1 FROM luggage_bag_additions a WHERE a.order_id=OLD.order_id
      AND a.before_updated_at=OLD.updated_at AND a.revision=NEW.updated_at
      AND a.before_suitcase=OLD.suitcase_qty AND a.before_backpack=OLD.backpack_qty AND a.before_price_per_day=OLD.price_per_day
      AND a.after_suitcase=NEW.suitcase_qty AND a.after_backpack=NEW.backpack_qty AND a.after_set_qty=NEW.set_qty AND a.after_price_per_day=NEW.price_per_day)
    THEN RAISE(ABORT,'Use audited bag addition') END;
END;
CREATE TRIGGER luggage_bag_preserve_receipt_update BEFORE UPDATE ON luggage_order_payments
WHEN EXISTS(SELECT 1 FROM luggage_bag_additions WHERE order_id=OLD.order_id OR order_id=NEW.order_id)
BEGIN SELECT RAISE(ABORT,'Preserve bag addition receipts'); END;
CREATE TRIGGER luggage_bag_preserve_receipt_delete BEFORE DELETE ON luggage_order_payments
WHEN EXISTS(SELECT 1 FROM luggage_bag_additions WHERE order_id=OLD.order_id)
BEGIN SELECT RAISE(ABORT,'Preserve bag addition receipts'); END;
CREATE TRIGGER luggage_bag_receipt_insert_guard BEFORE INSERT ON luggage_order_payments
WHEN EXISTS(SELECT 1 FROM luggage_bag_additions WHERE order_id=NEW.order_id)
BEGIN
  SELECT CASE WHEN NEW.receipt_request_id IS NULL
    OR EXISTS(SELECT 1 FROM luggage_cash_closings WHERE business_date=NEW.business_date AND closing_type='FINAL_CLOSE')
    THEN RAISE(ABORT,'Use open-day collection confirmation for bag additions') END;
END;
CREATE TRIGGER luggage_bag_order_no_delete BEFORE DELETE ON luggage_orders
WHEN EXISTS(SELECT 1 FROM luggage_bag_additions WHERE order_id=OLD.order_id)
BEGIN SELECT RAISE(ABORT,'Preserve bag addition order'); END;
CREATE TRIGGER luggage_bag_order_no_replace BEFORE INSERT ON luggage_orders
WHEN EXISTS(SELECT 1 FROM luggage_orders o JOIN luggage_bag_additions a ON a.order_id=o.order_id WHERE o.order_id=NEW.order_id)
BEGIN SELECT RAISE(ABORT,'Preserve bag addition order'); END;
CREATE TRIGGER luggage_bag_receipt_no_replace BEFORE INSERT ON luggage_order_payments
WHEN EXISTS(SELECT 1 FROM luggage_order_payments p JOIN luggage_bag_additions a ON a.order_id=p.order_id WHERE p.payment_id=NEW.payment_id)
BEGIN SELECT RAISE(ABORT,'Preserve bag addition receipts'); END;
CREATE TRIGGER luggage_bag_audit_no_update BEFORE UPDATE ON luggage_audit_logs
WHEN EXISTS(SELECT 1 FROM luggage_bag_additions WHERE order_id=OLD.order_id)
BEGIN SELECT RAISE(ABORT,'Preserve bag addition audit'); END;
CREATE TRIGGER luggage_bag_audit_no_delete BEFORE DELETE ON luggage_audit_logs
WHEN EXISTS(SELECT 1 FROM luggage_bag_additions WHERE order_id=OLD.order_id)
BEGIN SELECT RAISE(ABORT,'Preserve bag addition audit'); END;
CREATE TRIGGER luggage_bag_audit_no_replace BEFORE INSERT ON luggage_audit_logs
WHEN EXISTS(SELECT 1 FROM luggage_audit_logs log JOIN luggage_bag_additions a ON a.order_id=log.order_id WHERE log.log_id=NEW.log_id)
BEGIN SELECT RAISE(ABORT,'Preserve bag addition audit'); END;

DROP TRIGGER luggage_refund_insert_guard;
CREATE TRIGGER luggage_refund_insert_guard BEFORE INSERT ON luggage_flying_pass_refunds
BEGIN
  SELECT CASE WHEN EXISTS (SELECT 1 FROM luggage_flying_pass_refunds WHERE refund_id = NEW.refund_id)
    OR NEW.status != 'PAYOUT_PENDING' OR NEW.business_date != date('now', '+9 hours')
    OR NOT EXISTS (SELECT 1 FROM luggage_orders o JOIN luggage_billing_balances b ON b.root_id = o.order_id
      WHERE o.order_id = NEW.order_id AND o.parent_order_id IS NULL AND o.status = 'PAID'
        AND o.staff_prepaid_override_amount IS NULL AND o.final_amount + COALESCE((SELECT SUM(amount) FROM luggage_bag_additions ba WHERE ba.order_id=o.order_id),0) = NEW.original_amount AND o.prepaid_amount = o.final_amount
        AND b.invalid_amount = 0 AND b.root_review_required = 0 AND b.review_pickup_blocked = 0
        AND b.outstanding_amount = 0 AND b.unbilled_days = 0 AND b.legacy_paid_estimate = 0
        AND EXISTS (SELECT 1 FROM luggage_order_payments p WHERE p.order_id = o.order_id)
        AND (SELECT SUM(amount) FROM luggage_order_payments p WHERE p.order_id = o.order_id) = o.final_amount + o.extra_amount + COALESCE((SELECT SUM(amount) FROM luggage_bag_additions ba WHERE ba.order_id=o.order_id),0))

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
DROP TRIGGER luggage_refund_transition_guard;
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
        OR COALESCE(json_extract((SELECT details FROM luggage_audit_logs WHERE log_id = NEW.terminal_audit_id), '$.actor.role'), '') NOT IN ('manager', 'super_admin')
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
DROP TRIGGER luggage_refund_preserve_order;
CREATE TRIGGER luggage_refund_preserve_order BEFORE UPDATE ON luggage_orders
WHEN EXISTS (SELECT 1 FROM luggage_flying_pass_refunds WHERE order_id = OLD.order_id AND status IN ('PAYOUT_PENDING','CONFIRMED'))
  AND (NEW.order_id IS NOT OLD.order_id OR (NEW.status IS NOT OLD.status AND (EXISTS (SELECT 1 FROM luggage_flying_pass_refunds WHERE order_id = OLD.order_id AND status = 'PAYOUT_PENDING')
    OR NOT ((OLD.status = 'PAID' AND NEW.status = 'PICKED_UP') OR (OLD.status = 'PICKED_UP' AND NEW.status = 'PAID'))
    OR EXISTS (SELECT 1 FROM luggage_billing_balances b WHERE b.root_id = OLD.order_id AND (b.invalid_amount != 0 OR b.review_pickup_blocked != 0 OR b.outstanding_amount != 0 OR b.pending_refund_count != 0)))) OR NEW.parent_order_id IS NOT OLD.parent_order_id
    OR NEW.prepaid_amount IS NOT OLD.prepaid_amount OR NEW.final_amount IS NOT OLD.final_amount OR NEW.extra_amount IS NOT OLD.extra_amount
    OR NEW.flying_pass_tier IS NOT OLD.flying_pass_tier OR NEW.flying_pass_discount_amount IS NOT OLD.flying_pass_discount_amount
    OR NEW.staff_prepaid_override_amount IS NOT OLD.staff_prepaid_override_amount OR (NEW.price_per_day IS NOT OLD.price_per_day AND NOT EXISTS(SELECT 1 FROM luggage_bag_additions ba WHERE ba.order_id=OLD.order_id AND ba.before_updated_at=OLD.updated_at AND ba.revision=NEW.updated_at AND ba.before_suitcase=OLD.suitcase_qty AND ba.before_backpack=OLD.backpack_qty AND ba.before_price_per_day=OLD.price_per_day AND ba.after_suitcase=NEW.suitcase_qty AND ba.after_backpack=NEW.backpack_qty AND ba.after_set_qty=NEW.set_qty AND ba.after_price_per_day=NEW.price_per_day))
    OR NEW.expected_storage_days IS NOT OLD.expected_storage_days OR NEW.expected_pickup_at IS NOT OLD.expected_pickup_at
    OR NEW.created_at IS NOT OLD.created_at OR (NEW.suitcase_qty IS NOT OLD.suitcase_qty AND NOT EXISTS(SELECT 1 FROM luggage_bag_additions ba WHERE ba.order_id=OLD.order_id AND ba.before_updated_at=OLD.updated_at AND ba.revision=NEW.updated_at AND ba.before_suitcase=OLD.suitcase_qty AND ba.before_backpack=OLD.backpack_qty AND ba.before_price_per_day=OLD.price_per_day AND ba.after_suitcase=NEW.suitcase_qty AND ba.after_backpack=NEW.backpack_qty AND ba.after_set_qty=NEW.set_qty AND ba.after_price_per_day=NEW.price_per_day)) OR (NEW.backpack_qty IS NOT OLD.backpack_qty AND NOT EXISTS(SELECT 1 FROM luggage_bag_additions ba WHERE ba.order_id=OLD.order_id AND ba.before_updated_at=OLD.updated_at AND ba.revision=NEW.updated_at AND ba.before_suitcase=OLD.suitcase_qty AND ba.before_backpack=OLD.backpack_qty AND ba.before_price_per_day=OLD.price_per_day AND ba.after_suitcase=NEW.suitcase_qty AND ba.after_backpack=NEW.backpack_qty AND ba.after_set_qty=NEW.set_qty AND ba.after_price_per_day=NEW.price_per_day)) OR (NEW.set_qty IS NOT OLD.set_qty AND NOT EXISTS(SELECT 1 FROM luggage_bag_additions ba WHERE ba.order_id=OLD.order_id AND ba.before_updated_at=OLD.updated_at AND ba.revision=NEW.updated_at AND ba.before_suitcase=OLD.suitcase_qty AND ba.before_backpack=OLD.backpack_qty AND ba.before_price_per_day=OLD.price_per_day AND ba.after_suitcase=NEW.suitcase_qty AND ba.after_backpack=NEW.backpack_qty AND ba.after_set_qty=NEW.set_qty AND ba.after_price_per_day=NEW.price_per_day))
    OR NEW.extension_date IS NOT OLD.extension_date)
BEGIN SELECT RAISE(ABORT, 'REFUND_PRESERVE_ORIGINAL_ORDER'); END;
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
BEGIN SELECT RAISE(ABORT, 'REFUND_PRESERVE_ORIGINAL_RECEIPT'); END;
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
), orders AS (
  SELECT date(created_at, '+9 hours') AS business_date, COUNT(*) AS order_count,
    SUM(status IN ('PAID', 'PICKED_UP')) AS paid_count, SUM(status = 'PAYMENT_PENDING') AS pending_count,
    SUM(CASE WHEN status IN ('PAID', 'PICKED_UP') THEN 1 + companion_count ELSE 0 END) AS people,
    SUM(CASE WHEN status IN ('PAID', 'PICKED_UP') THEN suitcase_qty-COALESCE((SELECT SUM(suitcase_added) FROM luggage_bag_additions b WHERE b.order_id=luggage_orders.order_id),0) ELSE 0 END) AS suitcase_total,
    SUM(CASE WHEN status IN ('PAID', 'PICKED_UP') THEN backpack_qty-COALESCE((SELECT SUM(backpack_added) FROM luggage_bag_additions b WHERE b.order_id=luggage_orders.order_id),0) ELSE 0 END) AS backpack_total
  FROM luggage_orders WHERE parent_order_id IS NULL AND status != 'CANCELLED' GROUP BY business_date
), added_bags AS (SELECT business_date,SUM(suitcase_added) AS suitcase_total,SUM(backpack_added) AS backpack_total FROM luggage_bag_additions GROUP BY business_date), dates AS (SELECT business_date FROM added_bags UNION SELECT business_date FROM receipts UNION SELECT business_date FROM orders UNION SELECT business_date FROM refunds)
SELECT d.business_date, COALESCE(r.cash, 0) - COALESCE(f.amount, 0) AS cash, COALESCE(r.qr, 0) AS qr,
  COALESCE(r.total_amount, 0) - COALESCE(f.amount, 0) AS total_amount,
  COALESCE(r.cash, 0) AS gross_cash, COALESCE(r.qr, 0) AS gross_qr, COALESCE(f.amount, 0) AS cash_refund_amount, COALESCE(f.refund_count, 0) AS refund_count, COALESCE(o.order_count, 0) AS order_count,
  COALESCE(r.legacy_estimated_amount, 0) AS legacy_estimated_amount, COALESCE(r.recorded_amount, 0) AS recorded_amount,
  COALESCE(o.paid_count, 0) AS paid_count, COALESCE(o.pending_count, 0) AS pending_count,
  COALESCE(o.people, 0) AS people, COALESCE(o.suitcase_total, 0)+COALESCE(a.suitcase_total,0) AS suitcase_total,
  COALESCE(o.backpack_total, 0)+COALESCE(a.backpack_total,0) AS backpack_total
FROM dates d LEFT JOIN added_bags a ON a.business_date=d.business_date LEFT JOIN receipts r ON r.business_date = d.business_date LEFT JOIN orders o ON o.business_date = d.business_date LEFT JOIN refunds f ON f.business_date = d.business_date;