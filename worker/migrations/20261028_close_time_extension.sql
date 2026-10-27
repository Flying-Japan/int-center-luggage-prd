-- Apply once to the deployed F1 schema, as one atomic D1 import.
-- Existing orders and receipts are never changed. All pre-cutover orders are
-- excluded from new automatic accrual until separately reviewed by staff.
CREATE TABLE luggage_automatic_billing_policy (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  starts_at TEXT NOT NULL CHECK (julianday(starts_at) IS NOT NULL)
);
INSERT INTO luggage_automatic_billing_policy(singleton, starts_at)
VALUES (1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

DROP VIEW luggage_unbilled_extension_days;
CREATE VIEW luggage_unbilled_extension_days AS
WITH RECURSIVE days(root_id, billing_date, last_date, amount) AS (
  SELECT r.order_id, date(r.expected_pickup_at, '+9 hours', '+1 day'),
    date('now', '+9 hours', CASE WHEN time('now', '+9 hours') >= '21:00:00' THEN '+1 day' ELSE '+0 days' END),
    r.price_per_day
  FROM luggage_orders r CROSS JOIN luggage_automatic_billing_policy policy
  WHERE policy.singleton = 1 AND r.parent_order_id IS NULL
    AND r.status IN ('PAID', 'PAYMENT_PENDING') AND r.actual_pickup_at IS NULL
    AND julianday(r.created_at) >= julianday(policy.starts_at)
    AND julianday(r.created_at) <= julianday('now')
    AND date(r.expected_pickup_at, '+9 hours') >= date(r.created_at, '+9 hours')
    AND (r.status = 'PAID' OR EXISTS (
      SELECT 1 FROM luggage_order_payments p WHERE p.order_id = r.order_id AND p.amount > 0))
    AND typeof(r.price_per_day) = 'integer' AND r.price_per_day BETWEEN 0 AND 500000
    AND datetime(r.expected_pickup_at, '+9 hours', 'start of day', '+21 hours')
      <= datetime('now', '+9 hours')
  UNION ALL
  SELECT root_id, date(billing_date, '+1 day'), last_date, amount FROM days
  WHERE billing_date < last_date
)
SELECT root_id, billing_date, amount FROM days d
WHERE NOT EXISTS (
  SELECT 1 FROM luggage_billing_lines e WHERE e.parent_order_id = d.root_id
    AND d.billing_date BETWEEN date(e.coverage_end, '-' || (MAX(1, e.expected_storage_days) - 1) || ' days') AND e.coverage_end
);
