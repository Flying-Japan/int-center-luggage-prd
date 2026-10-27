-- Forward safety refinement; preserve the existing cutover and all financial rows.
DROP VIEW luggage_unbilled_extension_days;
CREATE VIEW luggage_unbilled_extension_days AS
WITH RECURSIVE confirmed_intakes(order_id, confirmed_at) AS (
  SELECT order_id, MIN(confirmed_at) FROM (
    SELECT order_id, julianday(recorded_at) AS confirmed_at FROM luggage_order_payments
      WHERE amount > 0 AND julianday(recorded_at) IS NOT NULL
    UNION ALL
    SELECT order_id, julianday(timestamp) FROM luggage_audit_logs
      WHERE action IN ('MARK_PAID', 'TOGGLE_PAYMENT', 'UNIFIED_ADMIN_PAYMENT_STATUS_UPDATE')
        AND julianday(timestamp) IS NOT NULL
  ) GROUP BY order_id
), days(root_id, billing_date, last_date, amount, confirmed_at) AS (
  SELECT r.order_id, date(r.expected_pickup_at, '+9 hours', '+1 day'),
    date('now', '+9 hours', CASE WHEN time('now', '+9 hours') >= '21:00:00' THEN '+1 day' ELSE '+0 days' END),
    r.price_per_day, COALESCE(intake.confirmed_at,
      CASE WHEN r.price_per_day = 0 THEN julianday(r.created_at) END)
  FROM luggage_orders r CROSS JOIN luggage_automatic_billing_policy policy
  LEFT JOIN confirmed_intakes intake ON intake.order_id = r.order_id
  WHERE policy.singleton = 1 AND r.parent_order_id IS NULL
    AND r.status IN ('PAID', 'PAYMENT_PENDING') AND r.actual_pickup_at IS NULL
    AND julianday(r.created_at) >= julianday(policy.starts_at)
    AND julianday(r.created_at) <= julianday('now')
    AND date(r.expected_pickup_at, '+9 hours') >= date(r.created_at, '+9 hours')
    AND (intake.confirmed_at IS NOT NULL OR (r.status = 'PAID' AND r.price_per_day = 0))
    AND typeof(r.price_per_day) = 'integer' AND r.price_per_day BETWEEN 0 AND 500000
    AND datetime(r.expected_pickup_at, '+9 hours', 'start of day', '+21 hours')
      <= datetime('now', '+9 hours')
  UNION ALL
  SELECT root_id, date(billing_date, '+1 day'), last_date, amount, confirmed_at FROM days
  WHERE billing_date < last_date
)
SELECT root_id, billing_date, amount FROM days d
-- An unconfirmed form is not evidence of physical overnight storage.
WHERE julianday(d.billing_date || 'T12:00:00Z', '-1 day') >= d.confirmed_at
AND NOT EXISTS (
  SELECT 1 FROM luggage_billing_lines e WHERE e.parent_order_id = d.root_id
    AND d.billing_date BETWEEN date(e.coverage_end, '-' || (MAX(1, e.expected_storage_days) - 1) || ' days') AND e.coverage_end
);
