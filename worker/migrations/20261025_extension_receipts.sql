-- Prepare only. Apply once, before deploying the accompanying Worker code.
-- No historical order/payment rows are rewritten or inferred receipts inserted.
ALTER TABLE luggage_orders ADD COLUMN extension_date TEXT;
ALTER TABLE luggage_order_payments ADD COLUMN receipt_request_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_luggage_extension_date
  ON luggage_orders(parent_order_id, extension_date) WHERE extension_date IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_luggage_receipt_request
  ON luggage_order_payments(receipt_request_id, order_id, tender_type)
  WHERE receipt_request_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_luggage_collection_request
  ON luggage_audit_logs(device_id) WHERE action = 'CONFIRM_COLLECTION';

-- Stored charges and real tender receipts remain separate. A paid root mismatch is a
-- reconciliation item, never an instruction to collect again or offset a child invoice.
CREATE VIEW IF NOT EXISTS luggage_billing_lines AS
WITH ledger AS (
  SELECT order_id, COUNT(*) AS payment_count, SUM(amount) AS recorded_amount,
    MAX(julianday(recorded_at)) AS last_receipt_at,
    SUM(CASE WHEN julianday(recorded_at) IS NULL THEN 1 ELSE 0 END) AS invalid_receipt_dates,
    SUM(receipt_request_id IS NOT NULL) AS modern_receipt_count,
    SUM(CASE WHEN typeof(amount) != 'integer' OR amount < 0 THEN 1 ELSE 0 END) AS invalid_receipt_amounts
  FROM luggage_order_payments GROUP BY order_id
), price_events AS (
  SELECT log_id, order_id, staff_id, timestamp,
    CASE WHEN json_valid(details) THEN details ELSE '{}' END AS payload
  FROM luggage_audit_logs WHERE action = 'UPDATE_PRICE'
), amounts AS (
  SELECT o.*, COALESCE(o.parent_order_id, o.order_id) AS root_id,
    COALESCE(o.final_amount, o.prepaid_amount, 0) + COALESCE(o.extra_amount, 0) AS billed_amount,
    COALESCE(p.recorded_amount, 0) AS recorded_amount, COALESCE(p.payment_count, 0) AS payment_count,
    p.last_receipt_at, p.invalid_receipt_dates, COALESCE(p.modern_receipt_count, 0) AS modern_receipt_count,
    COALESCE(p.invalid_receipt_amounts, 0) AS invalid_receipt_amounts,
    CASE WHEN o.status IN ('PAID', 'PICKED_UP') AND COALESCE(p.payment_count, 0) = 0
      THEN COALESCE(o.final_amount, o.prepaid_amount, 0) + COALESCE(o.extra_amount, 0) ELSE 0 END AS legacy_paid_estimate,
    CASE WHEN o.parent_order_id IS NOT NULL THEN COALESCE(o.extension_date,
      CASE WHEN o.expected_storage_days > 1 THEN date(o.expected_pickup_at, '+9 hours') END,
      MAX(date(o.created_at, '+9 hours'), date(r.expected_pickup_at, '+9 hours', '+1 day')))
    END AS coverage_end
  FROM luggage_orders o LEFT JOIN luggage_orders r ON r.order_id = o.parent_order_id
  LEFT JOIN ledger p ON p.order_id = o.order_id WHERE o.status != 'CANCELLED'
), evidence AS (
  SELECT m.*, m.billed_amount - m.recorded_amount - m.legacy_paid_estimate AS raw_balance,
    CASE WHEN m.parent_order_id IS NULL AND m.status IN ('PAID', 'PICKED_UP')
      AND m.payment_count > 0 AND m.billed_amount != m.recorded_amount THEN 1 ELSE 0 END AS root_review_required,
    (SELECT a.log_id FROM price_events a WHERE a.order_id = m.order_id
      AND m.parent_order_id IS NULL AND m.status IN ('PAID', 'PICKED_UP')
      AND m.payment_count > 0 AND m.billed_amount != m.recorded_amount
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

-- Independent of tags and AUTO_EXTENSION_ENABLED. Reads never create orders.
-- Do not LIMIT this recursive date range: silently dropping old days would understate debt.
-- Operational follow-up: bound historical materialization separately and require explicit review
-- for a backlog beyond that bound; a review state must block pickup, never mean zero outstanding.
CREATE VIEW IF NOT EXISTS luggage_unbilled_extension_days AS
WITH RECURSIVE days(root_id, billing_date, last_date, amount) AS (
  SELECT order_id, date(expected_pickup_at, '+9 hours', '+1 day'),
         date('now', '+9 hours'), price_per_day
  FROM luggage_orders
  WHERE parent_order_id IS NULL AND status IN ('PAID', 'PAYMENT_PENDING')
    AND date(expected_pickup_at, '+9 hours') < date('now', '+9 hours')
  UNION ALL
  SELECT root_id, date(billing_date, '+1 day'), last_date, amount FROM days
  WHERE billing_date < last_date
)
SELECT root_id, billing_date, amount FROM days d
WHERE NOT EXISTS (
  SELECT 1 FROM luggage_billing_lines e WHERE e.parent_order_id = d.root_id
    AND d.billing_date BETWEEN date(e.coverage_end, '-' || (MAX(1, e.expected_storage_days) - 1) || ' days') AND e.coverage_end
);

CREATE VIEW IF NOT EXISTS luggage_billing_balances AS
WITH totals AS (
  SELECT root_id, SUM(parent_order_id IS NOT NULL) AS extension_count, SUM(billed_amount) AS billed_amount,
    SUM(recorded_amount) AS recorded_amount, SUM(legacy_paid_estimate) AS legacy_paid_estimate,
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
      OR raw_balance < 0 OR billed_amount < 0 OR billed_amount != CAST(billed_amount AS INTEGER)
      OR price_per_day < 0 OR price_per_day != CAST(price_per_day AS INTEGER)
      OR billed_amount > 500000 OR price_per_day > 500000 THEN 1 ELSE 0 END) AS invalid_amount
  FROM luggage_billing_lines GROUP BY root_id
), projected AS (
  SELECT root_id, SUM(amount) AS amount, COUNT(*) AS days FROM luggage_unbilled_extension_days GROUP BY root_id
)
SELECT t.*, COALESCE(p.amount, 0) AS unbilled_amount, COALESCE(p.days, 0) AS unbilled_days,
  t.billed_amount + COALESCE(p.amount, 0) AS total_billed_amount,
  t.extension_line_outstanding + COALESCE(p.amount, 0) AS extension_outstanding_amount,
  t.line_outstanding + COALESCE(p.amount, 0) AS outstanding_amount
FROM totals t LEFT JOIN projected p ON p.root_id = t.root_id;

-- Ledger receipts belong to the actual JST receipt day, irrespective of order status/creation.
-- The legacy fallback is mutually exclusive with ledger rows, so it cannot duplicate receipts.
CREATE VIEW IF NOT EXISTS luggage_receipt_sales AS
SELECT p.order_id, p.business_date, p.tender_type, p.amount, 0 AS estimated
FROM luggage_order_payments p
UNION ALL
SELECT o.order_id, date(o.created_at, '+9 hours'),
       CASE WHEN o.payment_method = 'PAY_QR' THEN 'PAY_QR' ELSE 'CASH' END,
       COALESCE(o.final_amount, o.prepaid_amount, 0) + COALESCE(o.extra_amount, 0), 1
FROM luggage_orders o WHERE o.status IN ('PAID', 'PICKED_UP')
  AND NOT EXISTS (SELECT 1 FROM luggage_order_payments p WHERE p.order_id = o.order_id);

-- DB guards also cover bulk/internal/legacy endpoints and races between reads and writes.
CREATE TRIGGER IF NOT EXISTS luggage_extension_insert_guard BEFORE INSERT ON luggage_orders
WHEN NEW.parent_order_id IS NOT NULL
BEGIN
  SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM luggage_orders r
    WHERE r.order_id = NEW.parent_order_id AND r.parent_order_id IS NULL
      AND r.status IN ('PAID', 'PAYMENT_PENDING'))
    THEN RAISE(ABORT, 'Extension requires an active root order') END;
  SELECT CASE WHEN NEW.extension_date IS NOT NULL AND EXISTS (
    SELECT 1 FROM luggage_billing_lines e WHERE e.parent_order_id = NEW.parent_order_id
      AND NEW.extension_date BETWEEN date(e.coverage_end, '-' || (MAX(1, e.expected_storage_days) - 1) || ' days') AND e.coverage_end)
    THEN RAISE(ABORT, 'Extension date already covered') END;
END;

CREATE TRIGGER IF NOT EXISTS luggage_pickup_balance_guard BEFORE UPDATE OF status ON luggage_orders
WHEN NEW.status = 'PICKED_UP' AND OLD.status != 'PICKED_UP'
BEGIN
  SELECT CASE WHEN OLD.parent_order_id IS NOT NULL
    AND EXISTS (SELECT 1 FROM luggage_orders r WHERE r.order_id = OLD.parent_order_id AND r.status != 'PICKED_UP')
    THEN RAISE(ABORT, 'Pick up the root order') END;
  SELECT CASE WHEN EXISTS (SELECT 1 FROM luggage_billing_balances b
    WHERE b.root_id = COALESCE(OLD.parent_order_id, OLD.order_id)
      AND (b.outstanding_amount > 0 OR b.invalid_amount != 0 OR b.review_pickup_blocked != 0))
    THEN RAISE(ABORT, 'Outstanding collection prevents pickup') END;
END;

-- A review item cannot be hidden by resetting its status to pending/cancelled.
CREATE TRIGGER IF NOT EXISTS luggage_root_review_status_guard BEFORE UPDATE OF status ON luggage_orders
WHEN OLD.parent_order_id IS NULL AND NEW.status NOT IN ('PAID', 'PICKED_UP')
  AND EXISTS (SELECT 1 FROM luggage_billing_lines l WHERE l.order_id = OLD.order_id AND l.root_review_required = 1)
BEGIN SELECT RAISE(ABORT, 'Preserve original settlement review'); END;

CREATE TRIGGER IF NOT EXISTS luggage_pickup_extensions AFTER UPDATE OF status ON luggage_orders
WHEN NEW.status = 'PICKED_UP' AND OLD.status != 'PICKED_UP' AND NEW.parent_order_id IS NULL
BEGIN
  UPDATE luggage_orders SET status = 'PICKED_UP', actual_pickup_at = NEW.actual_pickup_at,
    updated_at = datetime('now') WHERE parent_order_id = NEW.order_id AND status IN ('PAID', 'PAYMENT_PENDING');
END;

-- Retain the existing cancellation of legacy unpaid drafts, never a dated/accrued charge or receipt.
-- An undated draft has no confirmed service date. Known past service dates require an approved correction policy.
CREATE VIEW IF NOT EXISTS luggage_cancellation_policy AS
SELECT o.order_id,
  CASE
    WHEN l.root_review_required = 1 THEN 'ROOT_SETTLEMENT_REVIEW_REQUIRED'
    WHEN o.parent_order_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM luggage_order_payments p WHERE p.order_id = o.order_id) THEN 'COLLECTED_EXTENSION'
    WHEN o.parent_order_id IS NOT NULL AND (
      o.status != 'PAYMENT_PENDING' OR o.extension_date IS NOT NULL
      OR date(l.coverage_end, '-' || (MAX(1, l.expected_storage_days) - 1) || ' days') <= date('now', '+9 hours')
      OR NOT EXISTS (SELECT 1 FROM luggage_orders r WHERE r.order_id = o.parent_order_id
        AND r.status IN ('PAID', 'PAYMENT_PENDING'))) THEN 'EXTENSION_POLICY_REQUIRED'
    WHEN o.parent_order_id IS NULL AND (
      EXISTS (SELECT 1 FROM luggage_orders e WHERE e.parent_order_id = o.order_id AND e.status != 'CANCELLED')
      OR EXISTS (SELECT 1 FROM luggage_unbilled_extension_days d WHERE d.root_id = o.order_id AND d.amount > 0))
      THEN 'EXTENSION_POLICY_REQUIRED'
  END AS block_reason
FROM luggage_orders o LEFT JOIN luggage_billing_lines l ON l.order_id = o.order_id;

CREATE TRIGGER IF NOT EXISTS luggage_no_extension_waiver BEFORE UPDATE OF status ON luggage_orders
WHEN NEW.status = 'CANCELLED' AND OLD.status != 'CANCELLED'
  AND EXISTS (SELECT 1 FROM luggage_cancellation_policy p WHERE p.order_id = OLD.order_id AND p.block_reason IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'Extension cancellation requires an approved policy'); END;

CREATE TRIGGER IF NOT EXISTS luggage_preserve_collection_delete BEFORE DELETE ON luggage_order_payments
WHEN OLD.receipt_request_id IS NOT NULL
  OR EXISTS (SELECT 1 FROM luggage_billing_lines l WHERE l.order_id = OLD.order_id AND l.root_review_required = 1)
  OR EXISTS (SELECT 1 FROM luggage_orders o
  WHERE o.order_id = OLD.order_id AND (o.parent_order_id IS NOT NULL
    OR EXISTS (SELECT 1 FROM luggage_orders e WHERE e.parent_order_id = o.order_id)))
BEGIN SELECT RAISE(ABORT, 'Preserve collection history'); END;
CREATE TRIGGER IF NOT EXISTS luggage_preserve_collection_update BEFORE UPDATE ON luggage_order_payments
WHEN OLD.receipt_request_id IS NOT NULL
  OR EXISTS (SELECT 1 FROM luggage_billing_lines l WHERE l.order_id = OLD.order_id AND l.root_review_required = 1)
  OR EXISTS (SELECT 1 FROM luggage_orders o
  WHERE o.order_id = OLD.order_id AND (o.parent_order_id IS NOT NULL
    OR EXISTS (SELECT 1 FROM luggage_orders e WHERE e.parent_order_id = o.order_id)))
BEGIN SELECT RAISE(ABORT, 'Preserve collection history'); END;

CREATE TRIGGER IF NOT EXISTS luggage_preserve_collected_price BEFORE UPDATE OF prepaid_amount, final_amount, extra_amount, parent_order_id, extension_date ON luggage_orders
WHEN (NEW.prepaid_amount IS NOT OLD.prepaid_amount OR NEW.final_amount IS NOT OLD.final_amount
  OR NEW.extra_amount IS NOT OLD.extra_amount OR NEW.parent_order_id IS NOT OLD.parent_order_id
  OR NEW.extension_date IS NOT OLD.extension_date)
  AND EXISTS (SELECT 1 FROM luggage_order_payments p WHERE p.order_id = OLD.order_id)
BEGIN SELECT RAISE(ABORT, 'Collected amounts require a separate correction policy'); END;

CREATE TRIGGER IF NOT EXISTS luggage_receipt_insert_guard BEFORE INSERT ON luggage_order_payments
WHEN NEW.receipt_request_id IS NOT NULL
BEGIN
  SELECT CASE WHEN NEW.amount <= 0 OR NEW.amount != CAST(NEW.amount AS INTEGER) OR NEW.amount > 500000
    OR NEW.staff_id IS NULL OR NEW.business_date != date(NEW.recorded_at, '+9 hours')
    OR NOT EXISTS (SELECT 1 FROM luggage_audit_logs a WHERE a.device_id = NEW.receipt_request_id
      AND a.action = 'CONFIRM_COLLECTION' AND a.staff_id = NEW.staff_id)
    OR NOT EXISTS (SELECT 1 FROM luggage_billing_lines l JOIN luggage_orders r ON r.order_id = l.root_id
      WHERE l.order_id = NEW.order_id AND r.status IN ('PAID', 'PAYMENT_PENDING')
        AND l.collectible_amount >= NEW.amount)
    THEN RAISE(ABORT, 'Invalid or excess collection') END;
END;
CREATE TRIGGER IF NOT EXISTS luggage_legacy_extension_payment_guard BEFORE INSERT ON luggage_order_payments
WHEN NEW.receipt_request_id IS NULL AND EXISTS (SELECT 1 FROM luggage_orders o WHERE o.order_id = NEW.order_id
  AND (o.parent_order_id IS NOT NULL OR EXISTS (SELECT 1 FROM luggage_orders e WHERE e.parent_order_id = o.order_id)))
BEGIN SELECT RAISE(ABORT, 'Use collection confirmation for extensions'); END;
CREATE TRIGGER IF NOT EXISTS luggage_extension_paid_guard BEFORE UPDATE OF status ON luggage_orders
WHEN NEW.status = 'PAID' AND OLD.status = 'PAYMENT_PENDING'
  AND (OLD.parent_order_id IS NOT NULL OR EXISTS (SELECT 1 FROM luggage_orders e WHERE e.parent_order_id = OLD.order_id))
  AND COALESCE(NEW.final_amount, NEW.prepaid_amount, 0) + COALESCE(NEW.extra_amount, 0)
    > COALESCE((SELECT SUM(p.amount) FROM luggage_order_payments p WHERE p.order_id = OLD.order_id), 0)
BEGIN SELECT RAISE(ABORT, 'Actual collection is required'); END;

CREATE VIEW IF NOT EXISTS luggage_sales_daily AS
WITH receipts AS (
  SELECT business_date, SUM(CASE WHEN tender_type = 'CASH' THEN amount ELSE 0 END) AS cash,
    SUM(CASE WHEN tender_type = 'PAY_QR' THEN amount ELSE 0 END) AS qr, SUM(amount) AS total_amount,
    SUM(CASE WHEN estimated = 1 THEN amount ELSE 0 END) AS legacy_estimated_amount,
    SUM(CASE WHEN estimated = 0 THEN amount ELSE 0 END) AS recorded_amount
  FROM luggage_receipt_sales GROUP BY business_date
), orders AS (
  SELECT date(created_at, '+9 hours') AS business_date, COUNT(*) AS order_count,
    SUM(status IN ('PAID', 'PICKED_UP')) AS paid_count, SUM(status = 'PAYMENT_PENDING') AS pending_count,
    SUM(CASE WHEN status IN ('PAID', 'PICKED_UP') THEN 1 + companion_count ELSE 0 END) AS people,
    SUM(CASE WHEN status IN ('PAID', 'PICKED_UP') THEN suitcase_qty ELSE 0 END) AS suitcase_total,
    SUM(CASE WHEN status IN ('PAID', 'PICKED_UP') THEN backpack_qty ELSE 0 END) AS backpack_total
  FROM luggage_orders WHERE parent_order_id IS NULL AND status != 'CANCELLED' GROUP BY business_date
), dates AS (SELECT business_date FROM receipts UNION SELECT business_date FROM orders)
SELECT d.business_date, COALESCE(r.cash, 0) AS cash, COALESCE(r.qr, 0) AS qr,
  COALESCE(r.total_amount, 0) AS total_amount, COALESCE(o.order_count, 0) AS order_count,
  COALESCE(r.legacy_estimated_amount, 0) AS legacy_estimated_amount, COALESCE(r.recorded_amount, 0) AS recorded_amount,
  COALESCE(o.paid_count, 0) AS paid_count, COALESCE(o.pending_count, 0) AS pending_count,
  COALESCE(o.people, 0) AS people, COALESCE(o.suitcase_total, 0) AS suitcase_total,
  COALESCE(o.backpack_total, 0) AS backpack_total
FROM dates d LEFT JOIN receipts r ON r.business_date = d.business_date LEFT JOIN orders o ON o.business_date = d.business_date;

-- Actual extension identity/coverage remains immutable. A projection alone is not an issued invoice:
-- preserve existing audited pickup-date/rate corrections on standalone orders, even on historical fixtures.
-- Such corrections never delete receipts or alter an already-created extension's service dates.
CREATE TRIGGER IF NOT EXISTS luggage_preserve_extension_coverage BEFORE UPDATE OF parent_order_id, extension_date, expected_pickup_at, price_per_day ON luggage_orders
WHEN (NEW.parent_order_id IS NOT OLD.parent_order_id OR NEW.extension_date IS NOT OLD.extension_date)
  OR (((NEW.expected_pickup_at IS NOT OLD.expected_pickup_at
      AND (date(NEW.expected_pickup_at, '+9 hours') IS NULL
        OR date(NEW.expected_pickup_at, '+9 hours') IS NOT date(OLD.expected_pickup_at, '+9 hours')))
      OR NEW.price_per_day IS NOT OLD.price_per_day)
    AND (OLD.parent_order_id IS NOT NULL OR EXISTS (SELECT 1 FROM luggage_orders e
      WHERE e.parent_order_id = OLD.order_id AND (e.status != 'CANCELLED' OR e.extension_date IS NOT NULL
        OR EXISTS (SELECT 1 FROM luggage_order_payments p WHERE p.order_id = e.order_id)))))
BEGIN SELECT RAISE(ABORT, 'Preserve accrued extension coverage'); END;
